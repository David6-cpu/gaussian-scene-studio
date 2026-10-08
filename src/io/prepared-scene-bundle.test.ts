import { test, expect } from "vitest";
import { preparedSceneFixture } from "../../tests/support/prepared-scene";
import { buildScene } from "../build";
import { defaultRecipe } from "../recipe";
import { packBundle, unpackBundle } from "./archive";
test("v3 offline roundtrip preserves saved ground, license, proxy and procedural bytes", async () => {
  const { encodeSceneBundle, decodeSceneBundle } =
    await import("./prepared-scene-bundle");
  const { result } = await preparedSceneFixture();
  const b = await encodeSceneBundle(result),
    u = unpackBundle(packBundle(b));
  expect(JSON.parse(u.manifest).version).toBe(3);
  const reopened = await decodeSceneBundle(u.manifest, u.files);
  expect(reopened.recipe).toEqual(result.recipe);
  expect(reopened.scene.ground).toEqual(result.scene.ground);
  expect(reopened.scene.instances).toEqual(result.scene.instances);
  expect(reopened.heightfield).toEqual(result.heightfield);
  expect(reopened.scene.assets).toEqual(result.scene.assets);
  const old = buildScene(defaultRecipe),
    oldBundle = await encodeSceneBundle(old);
  expect(
    (await decodeSceneBundle(oldBundle.manifest, oldBundle.files)).recipe,
  ).toEqual(old.recipe);
});
test("v3 rejects unknown versions, changed definitions, instances and bytes", async () => {
  const { encodeSceneBundle, decodeSceneBundle } =
    await import("./prepared-scene-bundle");
  const { result } = await preparedSceneFixture();
  const b = await encodeSceneBundle(result);
  for (const mutate of [
    (m: any) => (m.version = 999),
    (m: any) => (m.definition.licenseText = ""),
    (m: any) => (m.definition.heightProxy.heights[0] = 1),
    (m: any) =>
      (m.definition.metadata.contentVersion = "sha256-" + "0".repeat(64)),
    (m: any) => (m.scene.instances[0].position[0] += 0.5),
  ]) {
    const m = JSON.parse(b.manifest);
    mutate(m);
    await expect(
      decodeSceneBundle(JSON.stringify(m), b.files),
    ).rejects.toThrow();
  }
  const files = new Map([...b.files].map(([n, v]) => [n, v.slice()]));
  files.get("ground-sh1.u32")![0] ^= 1;
  await expect(decodeSceneBundle(b.manifest, files)).rejects.toThrow();
  const { encodeBundle } = await import("./bundle");
  await expect(encodeBundle(result as any)).rejects.toThrow();
});
