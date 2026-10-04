import { test, expect } from "vitest";
import { parseRecipe } from "./recipe";
import { buildScene } from "./build";
import { defaultTestRecipe as r } from "../tests/support/fixtures";
test("manual recipe builds deterministic finite terrain and both assets", () => {
  expect(parseRecipe(r)).toEqual(r);
  const a = buildScene(r),
    b = buildScene(r);
  expect(a.scene.terrain.data).toEqual(b.scene.terrain.data);
  expect(a.scene.instances).toEqual(b.scene.instances);
  expect(a.report.accepted).toEqual({ rock: 10, reed: 10 });
  expect(a.report.activeSplats).toBeLessThanOrEqual(250000);
  expect(a.report.stageMs.total).toBeGreaterThan(0);
});
test.each([
  { x: 1 },
  { seed: 0.1 },
  { seed: NaN },
  { width: 12 },
  { depth: 3 },
  { octaves: 6 },
  { amplitude: -1 },
  { waterLevel: Infinity },
  { requested: { rock: 21, reed: 0 } },
  { url: "https://example.com" },
  { path: "../x" },
  { lodEnabled: 1 },
])("rejects malformed manual recipe %j", (patch) =>
  expect(() => parseRecipe({ ...r, ...patch })).toThrow(/配方/),
);
test("accepts exact bounds without mutation", () => {
  const input = {
    ...r,
    seed: 4294967295,
    width: 2,
    depth: 2,
    amplitude: 1,
    octaves: 5,
    waterLevel: -0.5,
    requested: { rock: 0, reed: 20 },
  };
  expect(parseRecipe(input)).toEqual(input);
  expect(input.requested.reed).toBe(20);
});
