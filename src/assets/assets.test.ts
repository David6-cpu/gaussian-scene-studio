import { test, expect } from "vitest";
import { Vector3, Quaternion } from "three";
import { makeSyntheticAssets } from "./synthetic";
import { placeAssets, anchorInstance } from "./placement";
import { chooseLod } from "./lod";
import { assertSceneBudget, assertGaussianBuffer } from "../gaussian/validate";
import {
  makeHeightField,
  sampleHeight,
  sampleNormal,
} from "../terrain/heightfield";
import {
  defaultTestRecipe as r,
  makeSharedFixture,
} from "../../tests/support/fixtures";
import type { BuiltScene } from "../gaussian/types";
import { riversideRecipe } from "../recipe";
import { buildScene } from "../build";
import { sampleRiverbankWater, riverbankSurface } from "../terrain/riverbank-water";
test.each(["f0-riverbank-grass-v1", "f0-riverbank-reed-v1"] as const)("%s places assets outside its displayed water domain", version => {
  const recipe = { ...riversideRecipe, algorithmVersion: version, waterLevel: 0, requested: { rock: 2, reed: 6 } };
  const built = buildScene(recipe);
  const surface = riverbankSurface(sampleRiverbankWater(built.heightfield, recipe), version === "f0-riverbank-reed-v1");
  expect(built.scene.instances.length).toBeGreaterThan(0);
  for (const instance of built.scene.instances) {
    const [x, , z] = instance.position;
    expect(surface.isWet(x, z)).toBe(false);
    if (surface.shorePlant && instance.assetId === "reed")
      expect(surface.waterPoints.some(([wx, wz]) => Math.hypot(x - wx, z - wz) <= 0.9)).toBe(true);
  }
  const dry = buildScene({ ...recipe, waterLevel: null });
  expect(dry.scene.water).toBeNull();
  expect(dry.report.rejections["shore-distance"]).toBeUndefined();
});
test("both synthetic levels cover finite Gaussian surfaces", () => {
  const assets = makeSyntheticAssets();
  expect(assets.map((a) => a.id)).toEqual(["rock", "reed"]);
  for (const a of assets) {
    expect(a.synthetic).toBe(true);
    expect(a.lods.full.count).toBe(4096);
    expect(a.lods.coarse.count).toBe(1024);
    assertGaussianBuffer(a.lods.full);
    assertGaussianBuffer(a.lods.coarse);
  }
});
test("placement is deterministic, bounded, dry, separated and anchored", () => {
  const assets = makeSyntheticAssets(),
    field = makeHeightField(r),
    out = placeAssets(field, r, assets);
  expect(out).toEqual(placeAssets(field, r, assets));
  expect(out.instances.length).toBe(20);
  for (const i of out.instances) {
    const a = assets.find((a) => a.id === i.assetId)!;
    expect(
      sampleHeight(field, i.position[0], i.position[2]),
    ).toBeGreaterThanOrEqual(0);
    const ix = Math.round((i.position[0] + 5) / 0.2),
      iz = Math.round((i.position[2] + 5) / 0.2);
    expect(sampleNormal(field, ix, iz)[1]).toBeGreaterThanOrEqual(
      Math.cos(Math.PI / 12),
    );
    for (const p of a.supportPoints) {
      const v = new Vector3(...p)
        .sub(new Vector3(...a.anchor))
        .multiplyScalar(i.scale)
        .applyQuaternion(new Quaternion(...i.rotation))
        .add(new Vector3(...i.position));
      const gap = v.y - sampleHeight(field, v.x, v.z);
      expect(gap).toBeGreaterThanOrEqual(-0.020001);
      expect(gap).toBeLessThanOrEqual(0.050001);
    }
    for (const j of out.instances)
      if (i.id !== j.id) {
        const b = assets.find((a) => a.id === j.assetId)!;
        expect(
          Math.hypot(
            i.position[0] - j.position[0],
            i.position[2] - j.position[2],
          ),
        ).toBeGreaterThanOrEqual(
          Math.max(0.6, a.radius * i.scale + b.radius * j.scale) - 1e-8,
        );
      }
  }
});
test("impossible wet placement reports shortfall without unbounded attempts", () => {
  const recipe = { ...r, amplitude: 0, waterLevel: 0.5 };
  const out = placeAssets(
    makeHeightField(recipe),
    recipe,
    makeSyntheticAssets(),
  );
  expect(out.instances).toHaveLength(0);
  expect(out.shortfall).toEqual({ rock: 10, reed: 10 });
  expect(
    Object.values(out.rejections).reduce((a, b) => a + b, 0),
  ).toBeLessThanOrEqual(6000);
});
test("zero request returns empty placement", () => {
  const recipe = { ...r, requested: { rock: 0, reed: 0 } };
  expect(
    placeAssets(makeHeightField(recipe), recipe, makeSyntheticAssets())
      .instances,
  ).toHaveLength(0);
});
test.each([0.5, 2])(
  "ground anchoring accounts for uniform scale %s",
  (scale) => {
    const field = makeHeightField({ ...r, amplitude: 0 });
    const a = makeSyntheticAssets()[0];
    const i = anchorInstance(field, a, [0, 0, 0], [0, 0, 0, 1], scale);
    expect(i).not.toBeNull();
    for (const p of a.supportPoints)
      expect((p[1] - a.anchor[1]) * scale + i![1]).toBeGreaterThanOrEqual(
        -0.02,
      );
  },
);
test("Gaussian LOD has hysteresis instead of oscillating at one threshold", () => {
  expect(chooseLod(23, "full")).toBe("coarse");
  expect(chooseLod(28, "coarse")).toBe("coarse");
  expect(chooseLod(33, "coarse")).toBe("full");
  expect(chooseLod(28, "full")).toBe("full");
});
test("rejects too many instances and nonpositive uniform scaling", () => {
  const s = makeSharedFixture();
  s.instances = Array.from({ length: 21 }, (_, i) => ({
    ...s.instances[0],
    id: String(i),
  }));
  expect(() => assertSceneBudget(s)).toThrow(/20/);
  s.instances = [{ ...s.instances[0], scale: 0 }];
  expect(() => assertSceneBudget(s)).toThrow(/scale/);
});
test("active Gaussian upper bound is checked without allocating huge buffers", () => {
  const s: BuiltScene = {
    terrain: { count: 250000, data: new Float32Array() },
    water: null,
    assets: [],
    instances: [],
  };
  expect(() => assertSceneBudget(s)).not.toThrow();
  s.terrain.count = 250001;
  expect(() => assertSceneBudget(s)).toThrow(/250000/);
});
test("leaf Gaussian long axis follows the blade surface tangent", () => {
  const b = makeSyntheticAssets()[1].lods.full;
  for (let leaf = 0; leaf < 12; leaf++) {
    const i = 1024 + leaf * 256 + 8 * 16 + 7,
      d = b.data;
    const tangent = new Vector3()
      .fromArray(d, (i + 16) * 14)
      .sub(new Vector3().fromArray(d, (i - 16) * 14))
      .normalize();
    const axis = new Vector3(0, 1, 0).applyQuaternion(
      new Quaternion().fromArray(d, i * 14 + 6),
    );
    expect(Math.abs(axis.dot(tangent))).toBeGreaterThan(0.99);
  }
});
