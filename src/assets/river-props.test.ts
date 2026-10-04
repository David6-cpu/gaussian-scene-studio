import { expect, test } from "vitest";
import { Vector3, Quaternion } from "three";
import { buildScene } from "../build";
import { riversideRecipe } from "../recipe";
import type { F0Recipe, GroundArrays } from "../gaussian/types";
import { assertGaussianBuffer, assertSceneBudget } from "../gaussian/validate";
import { sampleHeight } from "../terrain/heightfield";
import { encodeBundle, decodeBundle } from "../io/bundle";
import { readFileSync } from "node:fs";
import { riversideData } from "../terrain/riverside-data";

const variants = [
  "f0-riverside-grass-v1",
  "f0-riverside-reed-v1",
  "f0-riverside-grass-v2",
] as const;
const recipe = (version: string, changes: Partial<F0Recipe> = {}) =>
  ({
    ...riversideRecipe,
    algorithmVersion: version,
    ...changes,
  }) as F0Recipe;

test("low grass reduces blade height and width without moving stones or changing placement", () => {
  for (const seed of [0, 7, 42, 20261002, 4294967295]) {
    const previous = buildScene(recipe("f0-riverside-grass-v1", { seed }));
    const revised = buildScene(recipe("f0-riverside-grass-v2", { seed }));
    expect(revised.scene.instances).toEqual(previous.scene.instances);
    expect(revised.scene.assets[0]).toEqual(previous.scene.assets[0]);
    expect(revised.report.rejections).toEqual(previous.report.rejections);
    for (const level of ["full", "coarse"] as const) {
      const old = previous.scene.assets[1].lods[level];
      const low = revised.scene.assets[1].lods[level];
      const field = (b: typeof low, offset: number) =>
        Array.from({ length: b.count }, (_, i) => b.data[i * 14 + offset]);
      const tallest = Math.max(...field(low, 1));
      expect(tallest).toBeLessThanOrEqual(0.12);
      expect(tallest).toBeLessThan(Math.max(...field(old, 1)) * 0.35);
      expect(Math.max(...field(low, 3))).toBeLessThan(
        Math.max(...field(old, 3)) * 0.4,
      );
      expect(low.count).toBe(old.count);
      const heights = field(low, 1).sort((a, b) => a - b);
      expect(heights[Math.floor(heights.length * 0.95)]).toBeLessThan(0.08);
    }
  }
});

test("tilted procedural rock centers stay inside their placement radius", () => {
  const result = buildScene(
    recipe("f0-riverside-grass-v1", {
      seed: 4294967295,
      waterLevel: null,
      requested: { rock: 20, reed: 0 },
    }),
  );
  const asset = result.scene.assets.find((a) => a.id === "rock")!;
  let furthest = 0;
  for (const instance of result.scene.instances)
    for (const lod of [asset.lods.full, asset.lods.coarse]) {
      for (let i = 0; i < lod.count; i++) {
        const p = new Vector3()
          .fromArray(lod.data, i * 14)
          .applyQuaternion(new Quaternion(...instance.rotation));
        furthest = Math.max(furthest, Math.hypot(p.x, p.z));
      }
    }
  expect(furthest).toBeLessThanOrEqual(asset.radius);
});

test.each(variants)(
  "%s replaces props while preserving accepted ground and deterministic seed",
  (version) => {
    const a = buildScene(recipe(version)),
      b = buildScene(recipe(version)),
      old = buildScene(riversideRecipe);
    expect(a.scene.ground).toEqual(old.scene.ground);
    expect(a.heightfield).toEqual(old.heightfield);
    expect(a.scene.water).toEqual(old.scene.water);
    expect(a.scene).toEqual(b.scene);
    expect(a.scene.assets).not.toEqual(old.scene.assets);
    expect(buildScene(recipe(version, { seed: 7 })).scene.assets).not.toEqual(
      a.scene.assets,
    );
    for (const asset of a.scene.assets) {
      expect(asset.synthetic).toBe(true);
      expect(asset.lods.full.count).toBe(4096);
      expect(asset.lods.coarse.count).toBe(1024);
      assertGaussianBuffer(asset.lods.full);
      assertGaussianBuffer(asset.lods.coarse);
      const y = Array.from(
        { length: asset.lods.full.count },
        (_, i) => asset.lods.full.data[i * 14 + 1],
      );
      expect(Math.min(...y)).toBeGreaterThanOrEqual(-0.03);
      if (asset.id === "reed")
        expect(Math.max(...y)).toBeLessThan(
          version.includes("grass") ? 0.5 : 1,
        );
    }
    expect(a.report.accepted).toEqual(a.recipe.requested);
    expect(new Set(a.scene.instances.map((i) => i.scale)).size).toBeGreaterThan(
      1,
    );
    expect(
      new Set(a.scene.instances.map((i) => i.rotation.join(","))).size,
    ).toBeGreaterThan(1);
    for (const i of a.scene.instances) {
      const asset = a.scene.assets.find((a) => a.id === i.assetId)!;
      expect(
        Math.abs(i.position[0]) + asset.radius * i.scale,
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(i.position[2]) + asset.radius * i.scale,
      ).toBeLessThanOrEqual(2);
      expect(
        sampleHeight(a.heightfield, i.position[0], i.position[2]),
      ).toBeGreaterThanOrEqual(a.recipe.waterLevel!);
      if (version === "f0-riverside-reed-v1" && i.assetId === "reed") {
        let distance = Infinity;
        for (let z = 0; z < a.heightfield.nz; z++)
          for (let x = 0; x < a.heightfield.nx; x++)
            if (
              a.heightfield.heights[z * a.heightfield.nx + x] <
              a.recipe.waterLevel!
            )
              distance = Math.min(
                distance,
                Math.hypot(
                  i.position[0] - (x * 0.1 - 2),
                  i.position[2] - (z * 0.1 - 2),
                ),
              );
        expect(distance).toBeLessThanOrEqual(0.900001);
      }
      for (const j of a.scene.instances)
        if (i !== j) {
          const other = a.scene.assets.find((a) => a.id === j.assetId)!;
          expect(
            Math.hypot(
              i.position[0] - j.position[0],
              i.position[2] - j.position[2],
            ),
          ).toBeGreaterThanOrEqual(
            Math.max(0.6, asset.radius * i.scale + other.radius * j.scale) -
              1e-8,
          );
        }
      for (const p of asset.supportPoints) {
        const v = new Vector3(...p)
          .sub(new Vector3(...asset.anchor))
          .multiplyScalar(i.scale)
          .applyQuaternion(new Quaternion(...i.rotation))
          .add(new Vector3(...i.position));
        const gap = v.y - sampleHeight(a.heightfield, v.x, v.z);
        expect(gap).toBeGreaterThanOrEqual(-0.020001);
        expect(gap).toBeLessThanOrEqual(0.050001);
      }
    }
    assertSceneBudget(a.scene);
    assertSceneBudget(
      buildScene(recipe(version, { requested: { rock: 10, reed: 10 } })).scene,
    );
    expect(
      buildScene(recipe(version, { waterLevel: 0.5 })).scene.instances,
    ).toHaveLength(0);
  },
);

test.each(variants)(
  "%s saves/reopens the same props and seed with truthful origin",
  async (version) => {
    const original = buildScene(recipe(version));
    original.scene.ground!.arrays = Object.fromEntries(
      riversideData.outputs.map((o) => [
        o.key,
        new Uint32Array(
          Uint8Array.from(
            readFileSync(`public/assets/riverside-ground-v1/${o.filename}`),
          ).buffer,
        ),
      ]),
    ) as GroundArrays;
    const packed = await encodeBundle(original),
      manifest = JSON.parse(packed.manifest);
    expect(manifest.scene.assets[0].origin).toBe("procedural-river-props-v1");
    expect(manifest.scene.assets[1].origin).toBe(
      version === "f0-riverside-grass-v2"
        ? "procedural-low-grass-v2"
        : "procedural-river-props-v1",
    );
    const restored = await decodeBundle(packed.manifest, packed.files);
    expect(restored.scene).toEqual(original.scene);
    expect(restored.recipe).toEqual(original.recipe);
    manifest.scene.assets[1].origin = "photographic-capture";
    await expect(
      decodeBundle(JSON.stringify(manifest), packed.files),
    ).rejects.toThrow();
  },
);
