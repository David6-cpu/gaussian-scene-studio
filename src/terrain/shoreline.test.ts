import { test, expect } from "vitest";
import { sampleTerrain } from "./sampling";
import { sampleHeight } from "./heightfield";
import { assertGaussianBuffer } from "../gaussian/validate";
import { defaultRecipe } from "../recipe";
import { buildScene } from "../build";
import { encodeBundle, decodeBundle, sha256 } from "../io/bundle";
import type { F0Recipe, HeightField } from "../gaussian/types";
const refined: F0Recipe = { ...defaultRecipe, algorithmVersion: "f0-shore-v2" };
function plane(spacing = 0.2): HeightField {
  const n = Math.round(10 / spacing) + 1;
  return {
    width: 10,
    depth: 10,
    spacing,
    nx: n,
    nz: n,
    heights: Float32Array.from(
      { length: n * n },
      (_, i) => (Math.floor(i / n) * spacing - 5) * 0.04,
    ),
  };
}
test("local shoreline sampling increases only the crossing band and retains distant baseline bytes", () => {
  const f = plane(),
    old = sampleTerrain(f, defaultRecipe),
    next = sampleTerrain(f, refined);
  expect(next.terrain.count).toBeGreaterThan(old.terrain.count);
  expect(next.terrain.count).toBeLessThan(2601 * 4);
  expect([...next.terrain.data.slice(0, 14)]).toEqual([
    ...old.terrain.data.slice(0, 14),
  ]);
  let fine = 0;
  for (let off = 0; off < next.terrain.data.length; off += 14) {
    const d = next.terrain.data;
    if (d[off + 3] < 0.1) {
      fine++;
      expect(Math.abs(d[off + 2])).toBeLessThan(0.7);
    }
    expect(d[off + 1]).toBeCloseTo(sampleHeight(f, d[off], d[off + 2]), 6);
  }
  expect(fine).toBeGreaterThan(1000);
  assertGaussianBuffer(next.terrain);
  assertGaussianBuffer(next.water!);
  for (let off = 0; off < next.water!.data.length; off += 14) {
    const d = next.water!.data;
    expect(d[off + 1]).toBe(0);
    expect(sampleHeight(f, d[off], d[off + 2])).toBeLessThan(0);
  }
});
test.each([null, -0.5, 0.5])(
  "no shoreline at water level %s keeps the original buffers",
  (waterLevel) => {
    const f = plane(),
      old = sampleTerrain(f, { ...defaultRecipe, waterLevel }),
      next = sampleTerrain(f, { ...refined, waterLevel });
    expect(next).toEqual(old);
  },
);
test("coarse water records remain byte-identical before and after two refined banks", () => {
  const f = plane();
  for (let i = 0; i < f.heights.length; i++)
    f.heights[i] = 0.1 - Math.abs(Math.floor(i / f.nx) * f.spacing - 5) * 0.04;
  const old = sampleTerrain(f, defaultRecipe).water!,
    next = sampleTerrain(f, refined).water!,
    original = new Map<string, Float32Array>();
  for (let i = 0; i < old.data.length; i += 14)
    original.set(
      `${old.data[i]},${old.data[i + 2]}`,
      old.data.slice(i, i + 14),
    );
  let before = 0,
    after = 0;
  for (let i = 0; i < next.data.length; i += 14) {
    if (next.data[i + 3] < 0.1) continue;
    expect(next.data.slice(i, i + 14)).toEqual(
      original.get(`${next.data[i]},${next.data[i + 2]}`),
    );
    if (next.data[i + 2] < -3) before++;
    if (next.data[i + 2] > 3) after++;
  }
  expect(before).toBeGreaterThan(0);
  expect(after).toBeGreaterThan(0);
});
test.each([0.1, 0.2, 0.4])(
  "worst alternating wet/dry cells stay below budget at spacing %s",
  (spacing) => {
    const f = plane(spacing);
    for (let i = 0; i < f.heights.length; i++)
      f.heights[i] = i % 2 ? 0.1 : -0.1;
    const s = sampleTerrain(f, { ...refined, spacing });
    expect(s.terrain.count + s.water!.count + 20 * 4096).toBeLessThanOrEqual(
      168448,
    );
    expect(s.terrain.count).toBeGreaterThan(f.nx * f.nz);
  },
);
test("new version keeps heightfield and asset placement while reducing shoreline sampling step", () => {
  const old = buildScene(defaultRecipe),
    next = buildScene(refined);
  expect(next.heightfield).toEqual(old.heightfield);
  expect(next.scene.instances).toEqual(old.scene.instances);
  expect(next.report.algorithmVersion).toBe("f0-shore-v2");
  expect(next.report.activeSplats).toBe(95319);
  expect(buildScene(refined).scene.terrain.data).toEqual(
    next.scene.terrain.data,
  );
});
test("new sampling version round trips with canonical validation still enforced", async () => {
  const b = buildScene(refined),
    bundle = await encodeBundle(b);
  expect(
    (await decodeBundle(bundle.manifest, bundle.files)).scene.terrain.data,
  ).toEqual(b.scene.terrain.data);
  const m = JSON.parse(bundle.manifest),
    bytes = bundle.files.get("terrain.gsbin")!;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(
    10 * 4,
    0.9,
    true,
  );
  m.files.find((f: { name: string }) => f.name === "terrain.gsbin").sha256 =
    await sha256(bytes);
  await expect(decodeBundle(JSON.stringify(m), bundle.files)).rejects.toThrow(
    /配方不匹配/,
  );
});
test("v1 keeps the binary hashes captured before shoreline changes at e171a3a", async () => {
  const { files } = await encodeBundle(buildScene(defaultRecipe));
  const hashes: Record<string, string> = {
    "terrain.gsbin":
      "fc1cdb38e103bdee8f323f8d8422383dd1832476da068cf6fabf509e6f5a6d08",
    "water.gsbin":
      "ecd56b233a371f2325d4c15a0eb4bf7d18ca84aead2297d22b7ad49f7f2a6984",
    "rock-full.gsbin":
      "61101c9e3068a1c2e4a27cb4e22d4b6ff60b9238f281376f93ff080f4cc54c54",
    "rock-coarse.gsbin":
      "1f20f8fcbc396f82d16c0ebd62d9d4d6ead61be93aa5b6b78a69b2e5f7156573",
    "reed-full.gsbin":
      "3f233c79fa811005e50357556d9c86c928b5c5379db194b90af575d414e52e2f",
    "reed-coarse.gsbin":
      "7e5e178718a1da1279dd1684ee812f3cf044eac2b36af9ae5c0bab22a7882eb9",
    "heightfield.f32":
      "aa3b85f34038deabfe3522e15aedb39e581dc90b2b07a25aa4cfde513e48ede3",
  };
  for (const [name, expected] of Object.entries(hashes))
    expect(await sha256(files.get(name)!), name).toBe(expected);
});
