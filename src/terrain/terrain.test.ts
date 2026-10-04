import { test, expect } from "vitest";
import { Vector3, Quaternion } from "three";
import { makeHeightField, sampleHeight, sampleNormal } from "./heightfield";
import { sampleTerrain } from "./sampling";
import { assertGaussianBuffer } from "../gaussian/validate";
import type { F0Recipe, HeightField } from "../gaussian/types";
export const r: F0Recipe = {
  schemaVersion: 1,
  algorithmVersion: "f0-v1",
  recipeSource: "manual",
  seed: 20261002,
  width: 10,
  depth: 10,
  spacing: 0.1,
  amplitude: 0.6,
  octaves: 3,
  tangentFactor: 0.75,
  normalFactor: 0.1,
  opacity: 0.95,
  waterLevel: 0,
  requested: { rock: 10, reed: 10 },
  lodEnabled: true,
};
function plane(a: number, b: number): HeightField {
  return {
    width: 2,
    depth: 2,
    spacing: 1,
    nx: 3,
    nz: 3,
    heights: Float32Array.from(
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      (i) => a * ((i % 3) - 1) + b * (Math.floor(i / 3) - 1),
    ),
  };
}
test("flat plane has up normals including every boundary", () => {
  for (let z = 0; z < 3; z++)
    for (let x = 0; x < 3; x++) {
      const n = sampleNormal(plane(0, 0), x, z);
      expect(n[0]).toBeCloseTo(0);
      expect(n[1]).toBeCloseTo(1);
      expect(n[2]).toBeCloseTo(0);
    }
});
test("analytic sloped plane has correct one-sided derivatives", () => {
  for (let z = 0; z < 3; z++)
    for (let x = 0; x < 3; x++) {
      const n = sampleNormal(plane(0.2, 0.3), x, z),
        want = new Vector3(-0.2, 1, -0.3).normalize();
      expect(n[0]).toBeCloseTo(want.x, 5);
      expect(n[1]).toBeCloseTo(want.y, 5);
      expect(n[2]).toBeCloseTo(want.z, 5);
    }
});
test("bilinear sampling interpolates plane and rejects out-of-domain input", () => {
  expect(sampleHeight(plane(0.2, 0.3), 0.5, 0.5)).toBeCloseTo(0.25);
  expect(() => sampleHeight(plane(0, 0), 2, 0)).toThrow();
});
test("same seed gives byte-identical field and different seed changes it", () => {
  const a = makeHeightField(r);
  expect(a.nx).toBe(101);
  expect(a.nz).toBe(101);
  expect(a.heights).toEqual(makeHeightField(r).heights);
  expect(a.heights).not.toEqual(makeHeightField({ ...r, seed: 4 }).heights);
  expect(Math.max(...a.heights) - Math.min(...a.heights)).toBeLessThanOrEqual(
    0.600001,
  );
});
test("samples oriented positive-thickness Gaussians with horizontal wet mask", () => {
  const f = makeHeightField(r),
    { terrain, water } = sampleTerrain(f, r);
  expect(terrain.count).toBe(10201);
  assertGaussianBuffer(terrain);
  expect(water!.count).toBeGreaterThan(0);
  assertGaussianBuffer(water!);
  for (let i = 0; i < terrain.count; i++) {
    const d = terrain.data,
      off = i * 14;
    const normal = new Vector3(0, 0, 1).applyQuaternion(
      new Quaternion().fromArray(d, off + 6),
    );
    expect(
      normal.dot(
        new Vector3(...sampleNormal(f, i % f.nx, Math.floor(i / f.nx))),
      ),
    ).toBeGreaterThan(0.999);
  }
  for (let i = 0; i < water!.count; i++) {
    const d = water!.data,
      off = i * 14;
    expect(d[off + 1]).toBe(0);
    expect(sampleHeight(f, d[off], d[off + 2])).toBeLessThan(0);
  }
});
test("zero amplitude stays finite and disabled water produces no water buffer", () => {
  const recipe = { ...r, amplitude: 0, waterLevel: null };
  const f = makeHeightField(recipe);
  expect([...f.heights].every((x) => x === 0)).toBe(true);
  expect(sampleTerrain(f, recipe).water).toBeNull();
});
