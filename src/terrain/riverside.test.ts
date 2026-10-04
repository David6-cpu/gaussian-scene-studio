import { expect, test } from "vitest";
import { buildScene } from "../build";
import { defaultRecipe, parseRecipe } from "../recipe";
import type { F0Recipe } from "../gaussian/types";
import { countSplats } from "../gaussian/validate";
import { sampleHeight } from "./heightfield";

export const trial: F0Recipe = {
  ...defaultRecipe,
  algorithmVersion: "f0-riverside-v1",
  width: 4,
  depth: 4,
  spacing: 0.1,
  amplitude: 0,
  octaves: 1,
  waterLevel: -0.025,
  requested: { rock: 2, reed: 6 },
};

test("Riverside uses one continuous SH3 ground with a surveyed proxy for water and placement", () => {
  const result = buildScene(trial);
  expect(result.scene.ground).toMatchObject({
    id: "riverside-ground-v1",
    count: 64949,
    scale: 13,
    rotation: [1, 0, 0, 0],
  });
  // A retained procedural land layer would occlude the accepted scan.
  expect(result.scene.terrain.count).toBe(0);
  expect(result.heightfield.heights.length).toBe(41 * 41);
  expect(new Set(result.heightfield.heights).size).toBeGreaterThan(50);
  expect(result.scene.water!.count).toBeGreaterThan(0);
  expect(result.scene.water!.count).toBeLessThan(41 * 41);
  const water = result.scene.water!.data;
  for (let i = 0; i < water.length; i += 14) {
    expect(water[i + 1]).toBeCloseTo(trial.waterLevel!, 6);
    expect(
      sampleHeight(result.heightfield, water[i], water[i + 2]),
    ).toBeLessThan(trial.waterLevel! + 1e-6);
  }
  expect(result.scene.instances.length).toBeGreaterThan(0);
  for (const item of result.scene.instances) {
    expect(Math.abs(item.position[0])).toBeLessThan(2);
    expect(Math.abs(item.position[2])).toBeLessThan(2);
    expect(
      sampleHeight(result.heightfield, item.position[0], item.position[2]),
    ).toBeGreaterThanOrEqual(trial.waterLevel!);
  }
  expect(countSplats(result.scene).activeSplats).toBe(
    64949 + result.scene.water!.count + result.scene.instances.length * 4096,
  );
  expect(result.report.cpuBufferBytes).toBeGreaterThanOrEqual(6 * 1024 * 1024);
});

test("Riverside rejects stretching or a noise amplitude while legacy terrain stays reproducible", () => {
  for (const change of [
    { width: 10 },
    { depth: 6 },
    { amplitude: 0.5 },
    { spacing: 0.4 },
    { octaves: 3 },
  ])
    expect(() => parseRecipe({ ...trial, ...change })).toThrow(/Riverside/);
  expect(buildScene(defaultRecipe).report.activeSplats).toBe(85123);
  const a = buildScene(trial),
    b = buildScene({ ...trial, seed: trial.seed + 1 });
  expect(a.heightfield).toEqual(b.heightfield);
  expect(a.scene.ground).toEqual(b.scene.ground);
  expect(a.scene.instances).not.toEqual(b.scene.instances);
});
