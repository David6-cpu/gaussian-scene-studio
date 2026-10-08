import { test, expect } from "vitest";
import { encodeBundle, decodeBundle, sha256 } from "./bundle";
import { buildScene } from "../build";
import { readFileSync } from "node:fs";
import { riversideRecipe } from "../recipe";
import { riversideData } from "../terrain/riverside-data";
import type { GroundArrays } from "../gaussian/types";
import { defaultTestRecipe as r } from "../../tests/support/fixtures";
test.each(["f0-riverbank-grass-v1", "f0-riverbank-reed-v1"] as const)("%s ZIP v2 preserves water and rejects recipe/buffer substitution", async algorithmVersion => {
  const source = buildScene({ ...riversideRecipe, algorithmVersion, waterLevel: 0, requested: { rock: 0, reed: 4 } });
  source.scene.ground!.arrays = Object.fromEntries(riversideData.outputs.map(o => [o.key, new Uint32Array(Uint8Array.from(readFileSync(`public/assets/riverside-ground-v1/${o.filename}`)).buffer)])) as GroundArrays;
  const bundle = await encodeBundle(source);
  const loaded = await decodeBundle(bundle.manifest, bundle.files);
  expect(loaded.scene.water!.data).toEqual(source.scene.water!.data);
  expect(loaded.recipe.algorithmVersion).toBe(algorithmVersion);
  const changed = JSON.parse(bundle.manifest);
  expect(changed.version).toBe(2);
  changed.recipe.algorithmVersion = "f0-riverside-grass-v2";
  await expect(decodeBundle(JSON.stringify(changed), bundle.files)).rejects.toThrow();
  const bytes = bundle.files.get("water.gsbin")!;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(4, 0.1, true);
  const corrupted = JSON.parse(bundle.manifest);
  corrupted.files.find((f: { name: string }) => f.name === "water.gsbin").sha256 = await sha256(bytes);
  await expect(decodeBundle(JSON.stringify(corrupted), bundle.files)).rejects.toThrow();
});
test("versioned binary bundle round-trips scene, recipe and hashes", async () => {
  const source = buildScene(r),
    b = await encodeBundle(source),
    again = await decodeBundle(b.manifest, b.files);
  expect(again.recipe).toEqual(source.recipe);
  expect(again.scene.terrain.data).toEqual(source.scene.terrain.data);
  expect(again.scene.assets[1].lods.coarse.data).toEqual(
    source.scene.assets[1].lods.coarse.data,
  );
  expect(again.scene.instances).toEqual(source.scene.instances);
  expect((await encodeBundle(again)).manifest).toBe(b.manifest);
});
test("one corrupt byte is rejected and missing file is not silently regenerated", async () => {
  const b = await encodeBundle(buildScene(r));
  const [name, data] = [...b.files][0];
  data[0] ^= 1;
  await expect(decodeBundle(b.manifest, b.files)).rejects.toThrow(
    /SHA|hash|摘要/,
  );
  b.files.delete(name);
  await expect(decodeBundle(b.manifest, b.files)).rejects.toThrow(
    /缺少|missing/,
  );
});
test("rejects unsafe filenames, unknown format and oversized manifest", async () => {
  const b = await encodeBundle(buildScene(r)),
    m = JSON.parse(b.manifest);
  m.files[0].name = "../outside.gsbin";
  await expect(decodeBundle(JSON.stringify(m), b.files)).rejects.toThrow();
  await expect(
    decodeBundle('{"format":"unknown"}', new Map()),
  ).rejects.toThrow();
  await expect(
    decodeBundle(" ".repeat(1024 * 1024 + 1), new Map()),
  ).rejects.toThrow();
});
import { packBundle, unpackBundle } from "./archive";
import { zipSync } from "fflate";
test("single local ZIP contains only bounded flat files", async () => {
  const b = await encodeBundle(buildScene(r));
  const loaded = unpackBundle(packBundle(b));
  expect(loaded.manifest).toBe(b.manifest);
  expect(loaded.files).toEqual(b.files);
  expect(() =>
    unpackBundle(zipSync({ "../evil": new Uint8Array(1) })),
  ).toThrow();
  expect(() =>
    unpackBundle(zipSync({ "manifest.json": new Uint8Array(1) }, { level: 6 })),
  ).toThrow();
});
test.each([
  "outside",
  "overlap",
  "scale",
  "floating",
  "anchor",
  "radius",
  "water",
  "terrain",
  "asset",
  "heightfield",
])(
  "hash-valid %s edits cannot change F0 geometry independently of its recipe",
  async (kind) => {
    const bundle = await encodeBundle(buildScene(r)),
      m = JSON.parse(bundle.manifest);
    if (kind === "outside")
      m.scene.instances[0].position = [1e308, 1e308, 1e308];
    if (kind === "overlap")
      m.scene.instances[1].position = [...m.scene.instances[0].position];
    if (kind === "scale") m.scene.instances[0].scale = 10;
    if (kind === "floating") m.scene.instances[0].position[1] += 1;
    if (kind === "anchor") m.scene.assets[0].anchor = [0, 3, 0];
    if (kind === "radius") m.scene.assets[0].radius = 0.001;
    const files: Record<string, [string, number, number]> = {
      water: ["water.gsbin", 4, 100],
      terrain: ["terrain.gsbin", 4, 100],
      asset: ["rock-full.gsbin", 0, 100],
      heightfield: ["heightfield.f32", 0, 0],
    };
    if (files[kind]) {
      const [name, offset, value] = files[kind],
        bytes = bundle.files.get(name)!;
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(
        offset,
        value,
        true,
      );
      m.files.find((f: { name: string }) => f.name === name).sha256 =
        await sha256(bytes);
    }
    await expect(decodeBundle(JSON.stringify(m), bundle.files)).rejects.toThrow(
      /F0.*配方|配方.*F0/,
    );
  },
);
