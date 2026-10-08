import { test, expect, vi } from "vitest";
import { createEnvironmentController } from "./controller";
import { importEnvironment } from "./asset";
import {
  environmentSpz,
  environmentWorld,
  jsonBytes,
} from "../../tests/support/environment-fixture";
const asset = () =>
  importEnvironment(jsonBytes(environmentWorld()), environmentSpz());
const deferred = <T>() => {
  let resolve!: (x: T) => void;
  let reject!: (x: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const staged = () => ({
  commit: vi.fn(),
  rollback: vi.fn(),
  usable: () => true,
  camera: () => ({
    position: [4, 3, 8] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
  }),
});
test("late preview rolls itself back after cancellation", async () => {
  const wait = deferred<ReturnType<typeof staged>>(),
    s = staged();
  const c = createEnvironmentController({
    stage: () => wait.promise,
    persist: vi.fn(),
    changed: vi.fn(),
  });
  const work = c.preview(await asset());
  c.cancel();
  wait.resolve(s);
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
  expect(s.rollback).toHaveBeenCalledTimes(1);
  expect(c.getState().phase).toBe("idle");
});
test("failed save retains preview and retries; duplicate clicks share one save", async () => {
  const s = staged(),
    wait = deferred<{ duplicate: boolean }>(),
    persist = vi
      .fn()
      .mockRejectedValueOnce(Error("quota"))
      .mockImplementationOnce(() => wait.promise);
  const c = createEnvironmentController({
    stage: async () => s,
    persist,
    changed: vi.fn(),
  });
  await c.preview(await asset());
  await expect(c.save()).rejects.toThrow("quota");
  expect(c.getState().phase).toBe("preview");
  expect(s.rollback).not.toHaveBeenCalled();
  const one = c.save(),
    two = c.save();
  expect(one).toBe(two);
  wait.resolve({ duplicate: false });
  await one;
  expect(persist).toHaveBeenCalledTimes(2);
  expect(s.commit).toHaveBeenCalledTimes(1);
  expect(c.getState().phase).toBe("saved");
});
test("a save resolving after close cannot republish over a newer preview", async () => {
  const wait = deferred<{ duplicate: boolean }>(),
    old = staged(),
    next = staged();
  const stage = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next);
  const changed = vi.fn(),
    c = createEnvironmentController({
      stage,
      persist: () => wait.promise,
      changed,
    });
  const a = await asset();
  await c.preview(a);
  const saving = c.save();
  c.close();
  c.close();
  await c.preview(a);
  const calls = changed.mock.calls.length;
  wait.resolve({ duplicate: false });
  const outcome = await saving;
  expect(outcome.applied).toBe(false);
  expect(changed).toHaveBeenCalledTimes(calls);
  expect(old.commit).not.toHaveBeenCalled();
  expect(next.rollback).not.toHaveBeenCalled();
  expect(c.getState().phase).toBe("preview");
});
test("repeated preview and cancel restore saved state without persisting another record", async () => {
  const first = staged(),
    second = staged(),
    third = staged(),
    persist = vi.fn(async () => ({ duplicate: false }));
  const stage = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
    .mockResolvedValueOnce(third);
  const c = createEnvironmentController({ stage, persist, changed: vi.fn() });
  const a = await asset();
  await c.preview(a);
  await c.save();
  await c.preview(a);
  await c.preview(a);
  c.cancel();
  expect(first.commit).toHaveBeenCalledTimes(1);
  expect(second.rollback).toHaveBeenCalledTimes(1);
  expect(third.rollback).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(c.getState().phase).toBe("saved");
});
