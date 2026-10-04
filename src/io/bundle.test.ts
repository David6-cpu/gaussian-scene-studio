import { test, expect } from "vitest";
import { encodeBundle, decodeBundle, sha256 } from "./bundle";
import { buildScene } from "../build";
import { defaultTestRecipe as r } from "../../tests/support/fixtures";
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
