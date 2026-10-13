import { expect, test, vi } from "vitest";
import { createSourceBank } from "./source-bank";
import type { SplatSource } from "../asset-loader";
const source = (): SplatSource => ({
  kind: "float14",
  count: 1,
  data: new Float32Array([
    1, 0, 0, 0.1, 0.1, 0.1, 0, 0, 0, 1, 0.3, 0.5, 0.7, 1,
  ]),
});
test("current, prepared and rollback leases share one upload and release only the last owner", async () => {
  const bank = createSourceBank();
  const input = source();
  const a = bank.acquire("same", input),
    b = bank.acquire("same", input);
  await Promise.all([a.ready, b.ready]);
  expect(a.source).toBe(b.source);
  const dispose = vi.spyOn(a.source, "dispose");
  a.release();
  a.release();
  expect(dispose).not.toHaveBeenCalled();
  expect(bank.stats().sourceCount).toBe(1);
  const rollback = bank.acquire("same", input);
  rollback.release();
  expect(dispose).not.toHaveBeenCalled();
  b.release();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(bank.stats()).toEqual({ sourceCount: 0, ownedBytes: 0 });
});
test("same key cannot reuse mutated bytes and uploads own a stable snapshot", async () => {
  const bank = createSourceBank(),
    input = source();
  const lease = bank.acquire("immutable", input);
  if (input.kind !== "float14") throw Error();
  input.data[0] = 8;
  await lease.ready;
  expect(lease.source.getSplat(0).center.x).toBe(1);
  expect(() => bank.acquire("immutable", input)).toThrow(/identity|changed/i);
  lease.release();
  expect(bank.stats().ownedBytes).toBe(0);
});
test("malformed SH capacity is rejected before Spark can truncate it", () => {
  const arrays = Object.fromEntries(
    ["ext0", "ext1", "sh1", "sh2", "sh3a", "sh3b"].map((k) => [
      k,
      new Uint32Array(4),
    ]),
  );
  expect(() =>
    createSourceBank().acquire("bad", {
      kind: "ext-sh3",
      count: 1,
      capacity: 1,
      arrays,
    } as SplatSource),
  ).toThrow(/capacity|array/i);
});
