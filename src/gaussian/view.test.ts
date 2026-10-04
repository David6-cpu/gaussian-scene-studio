import { test, expect } from "vitest";
import { assertGaussianBuffer, countSplats } from "./validate";
import { single, makeSharedFixture } from "../../tests/support/fixtures";
test("accepts a finite anisotropic Gaussian with normalized xyzw", () =>
  expect(() => assertGaussianBuffer(single())).not.toThrow());
test.each([
  [3, 0],
  [4, -0.1],
  [0, NaN],
  [9, 2],
  [10, 2],
  [13, -0.1],
])("rejects invalid field %i=%s", (i, v) => {
  const b = single();
  b.data[i] = v;
  expect(() => assertGaussianBuffer(b)).toThrow(/Gaussian/);
});
test("rejects mismatched count and buffer length", () => {
  const b = single();
  b.count = 2;
  expect(() => assertGaussianBuffer(b)).toThrow(/length/);
});
test("counts shared resident sources once but each active instance", () =>
  expect(countSplats(makeSharedFixture())).toEqual({
    uniqueSourceSplats: 2,
    activeSplats: 4,
  }));
