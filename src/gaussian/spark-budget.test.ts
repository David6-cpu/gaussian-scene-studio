import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { SplatAccumulator } from "@sparkjsdev/spark";
import {
  SPARK_BUDGET_OPTIONS,
  SPARK_BUDGET_VERSION,
  sparkRendererBudget,
  sparkSceneCapacity,
} from "./spark-budget";

test("the pinned model matches Spark's actual per-generator mapping rows", () => {
  const installed = JSON.parse(
    readFileSync(
      new URL(
        "../../node_modules/@sparkjsdev/spark/package.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(installed.version).toBe(SPARK_BUDGET_VERSION);
  const spark = new SplatAccumulator({ extSplats: false });
  for (const counts of [
    [],
    [1],
    [1, 1],
    [2048, 2049],
    Array(121).fill(1),
    [249880, ...Array(120).fill(1)],
  ]) {
    expect(sparkSceneCapacity(counts)).toBe(
      spark.generateMapping(counts).maxSplats,
    );
  }
  expect(sparkSceneCapacity(Array(121).fill(1))).toBe(247808);
  expect(sparkSceneCapacity([249880, ...Array(120).fill(1)])).toBe(497664);
});

test("padded ordering capacity is independent of logical counts and has an empty minimum", () => {
  expect(sparkRendererBudget(0)).toMatchObject({
    capacity: 0,
    orderingCapacity: 16384,
    accumulatorBytes: 0,
    readbackBytes: 8192,
    pixelPackBytes: 0,
    knownBytes: 204800,
    reservedBytes: 8388608,
  });
  expect(
    sparkRendererBudget(sparkSceneCapacity([16384])).orderingCapacity,
  ).toBe(16384);
  expect(
    sparkRendererBudget(sparkSceneCapacity([16385])).orderingCapacity,
  ).toBe(32768);
});

test("known allocations fit the reserved envelope across the supported capacity domain", () => {
  for (let capacity = 0; capacity <= 2048 ** 2; capacity += 2048) {
    const budget = sparkRendererBudget(capacity);
    expect(budget.knownBytes).toBeLessThanOrEqual(budget.reservedBytes);
  }
  expect(sparkRendererBudget(247808)).toMatchObject({
    orderingCapacity: 262144,
    knownBytes: 19996672,
    reservedBytes: 40108032,
    unmeasured: ["private-wasm-runtime", "driver"],
  });
});

test.each([
  NaN,
  Infinity,
  -1,
  0.5,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
])("unsafe count/capacity %s is rejected", (value) => {
  expect(() => sparkSceneCapacity([value])).toThrow();
  expect(() => sparkRendererBudget(value)).toThrow();
});

test("zero generators, unpadded capacities and extra layers are rejected explicitly", () => {
  expect(() => sparkSceneCapacity([0])).toThrow(/positive/);
  expect(() => sparkRendererBudget(1)).toThrow(/padded/);
  expect(() => sparkSceneCapacity([2048 ** 2, 1])).toThrow(/capacity/);
});

test("unsupported accumulator, LOD, paging or target configurations cannot borrow the standard estimate", () => {
  for (const key of Object.keys(SPARK_BUDGET_OPTIONS)) {
    expect(() =>
      sparkRendererBudget(2048, { ...SPARK_BUDGET_OPTIONS, [key]: true }),
    ).toThrow(/configuration/);
  }
  expect(() =>
    sparkRendererBudget(2048, { ...SPARK_BUDGET_OPTIONS, target: {} }),
  ).toThrow(/configuration/);
});
