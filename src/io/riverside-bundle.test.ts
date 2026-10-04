import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { buildScene } from "../build";
import { defaultRecipe, riversideRecipe } from "../recipe";
import type { GroundArrays } from "../gaussian/types";
import { riversideData } from "../terrain/riverside-data";
import { encodeBundle, decodeBundle, sha256 } from "./bundle";
import { packBundle, unpackBundle } from "./archive";

function readyScene() {
  const scene = buildScene(riversideRecipe);
  scene.scene.ground!.arrays = Object.fromEntries(
    riversideData.outputs.map((o) => {
      const bytes = readFileSync(
        `public/assets/riverside-ground-v1/${o.filename}`,
      );
      return [o.key, new Uint32Array(Uint8Array.from(bytes).buffer)];
    }),
  ) as GroundArrays;
  return scene;
}

test("Riverside ZIP embeds all six SH3 arrays and attribution and reopens without fetching", async () => {
  const source = readyScene();
  const bundle = await encodeBundle(source),
    manifest = JSON.parse(bundle.manifest);
  expect(manifest.version).toBe(2);
  expect(manifest.scene.ground.attribution).toMatchObject({
    author: "VeryOS",
    license: "CC BY 4.0",
  });
  expect(bundle.files.size).toBe(13);
  for (const o of riversideData.outputs)
    expect(await sha256(bundle.files.get(o.filename)!)).toBe(o.sha256);
  const restored = unpackBundle(packBundle(bundle));
  const decoded = await decodeBundle(restored.manifest, restored.files);
  expect(decoded.scene.ground).toEqual(source.scene.ground);
  expect(decoded.scene.water).toEqual(source.scene.water);
  expect(decoded.scene.instances).toEqual(source.scene.instances);
  expect((await encodeBundle(decoded)).manifest).toBe(bundle.manifest);
  expect(
    JSON.parse((await encodeBundle(buildScene(defaultRecipe))).manifest)
      .version,
  ).toBe(1);
});

test("a rewritten manifest hash cannot disguise altered Riverside SH data", async () => {
  const bundle = await encodeBundle(readyScene()),
    manifest = JSON.parse(bundle.manifest);
  const name = "riverside-sh3a.u32",
    bytes = bundle.files.get(name)!;
  expect(bytes).toBeDefined();
  bytes[0] ^= 1;
  manifest.files.find((f: { name: string }) => f.name === name).sha256 =
    await sha256(bytes);
  await expect(
    decodeBundle(JSON.stringify(manifest), bundle.files),
  ).rejects.toThrow(/Riverside.*摘要/);
});

test("a Riverside bundle rejects altered placement transform and removed credit", async () => {
  for (const kind of ["transform", "credit"]) {
    const bundle = await encodeBundle(readyScene()),
      manifest = JSON.parse(bundle.manifest);
    expect(manifest.scene.ground).toBeDefined();
    if (kind === "transform") manifest.scene.ground.scale = 30;
    else manifest.scene.ground.attribution.author = "Someone else";
    await expect(
      decodeBundle(JSON.stringify(manifest), bundle.files),
    ).rejects.toThrow();
  }
});
