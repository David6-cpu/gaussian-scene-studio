import { expect, test } from "vitest";
import { sampleRiverbankWater, riverbankSurface } from "./riverbank-water";
import { riversideHeightField } from "./riverside";
import { sampleHeight } from "./heightfield";
import { riversideRecipe } from "../recipe";
import { assertGaussianBuffer } from "../gaussian/validate";
import type { RiverbankRecipe } from "../gaussian/types";

const recipe: RiverbankRecipe = {
  ...riversideRecipe,
  algorithmVersion: "f0-riverbank-grass-v1",
};
test.each([0, -0.025])(
  "natural river water at %s spans both ends without a cut through submerged land",
  (level) => {
    const f = riversideHeightField();
    const w = sampleRiverbankWater(f, { ...recipe, waterLevel: level });
    expect(w.metrics.components).toBe(1);
    expect(w.metrics.spansZ).toBe(true);
    expect(w.metrics.minWetWidth).toBeGreaterThan(0);
    expect(w.metrics.wetFraction).toBeGreaterThan(0.05);
    expect(w.metrics.wetFraction).toBeLessThan(1);
    expect(w.nx).toBe(81);
    expect(w.nz).toBe(81);
    const b = w.buffer!;
    assertGaussianBuffer(b);
    expect(b.count).toBeLessThanOrEqual(6561);
    const colors = new Set<number>(),
      opacity = new Set<number>();
    for (let i = 0; i < b.count; i++) {
      const a = i * 14;
      expect(b.data[a + 1]).toBeCloseTo(level, 6);
      expect(sampleHeight(f, b.data[a], b.data[a + 2])).toBeLessThan(
        level + 1e-7,
      );
      colors.add(b.data[a + 10]);
      opacity.add(b.data[a + 13]);
    }
    expect(colors.size).toBeGreaterThan(10);
    expect(opacity.size).toBeGreaterThan(10);
    for (let iz = 0; iz < 81; iz++) {
      expect(w.mask.slice(iz * 81, iz * 81 + 81).some(Boolean)).toBe(true);
      for (let ix = 0; ix < 81; ix++) {
        if (!w.mask[iz * 81 + ix]) continue;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = ix + dx,
            nz = iz + dz;
          if (nx < 0 || nz < 0 || nx > 80 || nz > 80 || w.mask[nz * 81 + nx])
            continue;
          expect(
            sampleHeight(f, nx * 0.05 - 2, nz * 0.05 - 2),
          ).toBeGreaterThanOrEqual(level);
        }
      }
    }
    expect(
      sampleRiverbankWater(f, { ...recipe, waterLevel: level }).buffer!.data,
    ).toEqual(b.data);
  },
);
test("dry, disconnected and fully flooded surfaces do not masquerade as riverbanks", () => {
  const f = riversideHeightField();
  const dry = sampleRiverbankWater(f, { ...recipe, waterLevel: null });
  expect(dry.buffer).toBeNull();
  expect(dry.mask.some(Boolean)).toBe(false);
  expect(riverbankSurface(dry, true).shorePlant).toBe(false);
  expect(() =>
    sampleRiverbankWater(f, { ...recipe, waterLevel: -0.5 }),
  ).toThrow(/连续|贯通/);
  expect(() =>
    sampleRiverbankWater(
      { ...f, heights: new Float32Array(1681).fill(-0.1) },
      { ...recipe, waterLevel: 0 },
    ),
  ).toThrow(/岸/);
  const broken = new Float32Array(1681).fill(-0.1);
  broken.fill(0.1, 20 * 41, 21 * 41);
  expect(() =>
    sampleRiverbankWater(
      { ...f, heights: broken },
      { ...recipe, waterLevel: 0 },
    ),
  ).toThrow(/连续|贯通/);
});
