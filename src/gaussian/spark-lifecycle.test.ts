import { expect, test, vi } from "vitest";
import type { SparkRenderer } from "@sparkjsdev/spark";
import { deferredSparkDisposal } from "./spark-lifecycle";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function fake(driveSort: () => Promise<void>) {
  return {
    driveSort,
    autoUpdate: true,
    sortDirty: true,
    dispose: vi.fn(),
    removeFromParent: vi.fn(),
    updateTimeoutId: undefined as ReturnType<typeof setTimeout> | undefined,
    sortTimeoutId: undefined as ReturnType<typeof setTimeout> | undefined,
  };
}
test("quiescence observes recursive sorts and disposal retains original shared promise", async () => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const spark = fake(async () => {
    calls++;
    if (calls === 1) {
      await first.promise;
      void spark.driveSort();
    } else await second.promise;
  });
  const after = vi.fn(),
    release = deferredSparkDisposal(spark as unknown as SparkRenderer, after);
  const sort = spark.driveSort();
  const quiet = release.whenQuiescent();
  let done = false;
  void quiet.then(() => {
    done = true;
  });
  expect(release.activity()).toEqual({ busy: true, released: false });
  first.resolve();
  await sort;
  await flush();
  expect(done).toBe(false);
  const closing = release();
  expect(release()).toBe(closing);
  expect(spark.dispose).not.toHaveBeenCalled();
  second.resolve();
  await quiet;
  await closing;
  expect(release.activity()).toEqual({ busy: false, released: true });
  expect(spark.dispose).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1);
});
test("a scheduled actual Spark timer remains busy until its asynchronous sort ends", async () => {
  vi.useFakeTimers();
  const held = deferred(),
    spark = fake(() => held.promise);
  const release = deferredSparkDisposal(
    spark as unknown as SparkRenderer,
    () => {},
  );
  spark.sortTimeoutId = setTimeout(() => {
    spark.sortTimeoutId = undefined;
    void spark.driveSort();
  }, 10);
  const quiet = release.whenQuiescent();
  let done = false;
  void quiet.then(() => {
    done = true;
  });
  expect(release.activity().busy).toBe(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(done).toBe(false);
  held.resolve();
  await quiet;
  expect(release.activity()).toEqual({ busy: false, released: false });
  await release();
  vi.useRealTimers();
});
test("quiescence does not hide a sort error or destroy a live renderer", async () => {
  const spark = fake(async () => {
    throw Error("sort failed");
  });
  const release = deferredSparkDisposal(
    spark as unknown as SparkRenderer,
    () => {},
  );
  await expect(spark.driveSort()).rejects.toThrow("sort failed");
  await release.whenQuiescent();
  expect(release.activity()).toEqual({ busy: false, released: false });
  expect(spark.dispose).not.toHaveBeenCalled();
  await release();
});
test("a failed GPU disposal rejects terminal waiters without claiming release", async () => {
  const spark = fake(async () => {});
  spark.dispose.mockImplementation(() => {
    throw Error("GPU cleanup failed");
  });
  const release = deferredSparkDisposal(
    spark as unknown as SparkRenderer,
    () => {},
  );
  await expect(release()).rejects.toThrow("GPU cleanup failed");
  await expect(release.whenQuiescent()).rejects.toThrow("GPU cleanup failed");
  expect(release.activity().released).toBe(false);
});
