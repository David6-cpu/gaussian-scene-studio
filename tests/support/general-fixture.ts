/** Constructed software fixtures only; never actual material admission evidence. */
import { manifestFixture } from "../../src/general-scene/test-fixtures.ts";
import {
  parseAssetManifest,
  type AssetManifestV2,
} from "../../src/general-scene/asset-manifest.ts";
import { assetContentVersion } from "../../src/general-scene/asset-package.ts";
import { jsonDigest } from "../../src/io/prepared-ground.ts";
import { sha256 } from "../../src/io/hash.ts";
import { utils } from "@sparkjsdev/spark";
export const encoder = new TextEncoder();
export function floatBytes(data: Float32Array): Uint8Array {
  const bytes = new Uint8Array(data.byteLength),
    view = new DataView(bytes.buffer);
  data.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return bytes;
}
export async function generalFixture(
  options: {
    count?: number;
    coarse?: boolean;
    sh3?: boolean;
    patch?: boolean;
  } = {},
) {
  const m: any = manifestFixture(options.patch ? "patch" : "object");
  m.origin = "procedural";
  m.provenance.license.evidence = "license.txt";
  const members = new Map<string, Uint8Array>([
    [
      "license.txt",
      encoder.encode("Constructed test license only; no real asset rights.\n"),
    ],
  ]);
  for (const lod of options.coarse ? ["full", "coarse"] : ["full"]) {
    const count = lod === "full" ? (options.count ?? 4) : 2;
    if (options.sh3) {
      const keys = ["ext0", "ext1", "sh1", "sh2", "sh3a", "sh3b"] as const;
      const arrays = Object.fromEntries(
        keys.map((k) => [
          k,
          new Uint32Array(Math.ceil(count / 2048) * 2048 * 4),
        ]),
      );
      for (let i = 0; i < count; i++)
        utils.encodeExtSplat(
          [arrays.ext0, arrays.ext1],
          i,
          0,
          0.5,
          0,
          0.01,
          0.01,
          0.01,
          0,
          0,
          0,
          1,
          0.5,
          0.5,
          0.5,
          0.5,
        );
      const descriptors = [];
      for (const key of keys) {
        const path = `${m.id}-${lod}-${key}.u32`,
          bytes = new Uint8Array(arrays[key].buffer);
        members.set(path, bytes);
        descriptors.push({
          path,
          bytes: bytes.length,
          sha256: await sha256(bytes),
        });
      }
      m.gaussian[lod] = {
        points: count,
        sha256: await jsonDigest(descriptors),
        quality: { status: "unreviewed", report: null },
      };
    } else {
      const data = new Float32Array(count * 14);
      for (let i = 0; i < count; i++)
        data.set(
          [0, 0.5, 0, 0.01, 0.01, 0.01, 0, 0, 0, 1, 0.2, 0.3, 0.4, 0.9],
          i * 14,
        );
      const bytes = floatBytes(data);
      members.set(`${m.id}-${lod}.f32`, bytes);
      m.gaussian[lod] = {
        points: count,
        sha256: await sha256(bytes),
        quality: { status: "unreviewed", report: null },
      };
    }
  }
  if (options.sh3) {
    m.gaussian.shDegree = 3;
    if (m.object) m.object.rotation = "fixed";
    m.quality.operations = m.quality.operations.filter(
      (x: string) => x !== "rotate",
    );
  }
  if (options.patch) {
    m.coordinates.fullBounds = { min: [-2, -1, -2], max: [2, 1, 2] };
    m.coordinates.usableBounds = structuredClone(m.coordinates.fullBounds);
    m.patch.usablePolygon = [
      [-1.8, -1.8],
      [1.8, -1.8],
      [1.8, 1.8],
      [-1.8, 1.8],
    ];
    m.patch.heightProxy.heightFile = `${m.id}-heights.f32`;
    m.patch.heightProxy.normalFile = `${m.id}-normals.f32`;
    members.set(
      m.patch.heightProxy.heightFile,
      floatBytes(new Float32Array(1681)),
    );
    const normals = new Float32Array(1681 * 3);
    for (let i = 0; i < 1681; i++) normals[i * 3 + 1] = 1;
    members.set(m.patch.heightProxy.normalFile, floatBytes(normals));
  }
  m.files = await Promise.all(
    [...members].map(async ([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: await sha256(bytes),
    })),
  );
  const n = [...members.values()].reduce((s, b) => s + b.length, 0);
  m.resources = { decodedBytes: n, cpuSourceBytes: n, uploadBytes: n };
  m.contentVersion = await assetContentVersion(parseAssetManifest(m));
  const manifest = parseAssetManifest(m);
  return { manifest, members };
}
export function constructedReview(manifest: AssetManifestV2) {
  return {
    format: "general-scene-asset-review",
    version: 1,
    evidenceKind: "constructed",
    asset: { id: manifest.id, contentVersion: manifest.contentVersion },
    files: manifest.files.map(({ path, sha256 }) => ({ path, sha256 })),
    quality: structuredClone(manifest.quality),
    full: structuredClone(manifest.gaussian.full.quality),
    coarse: structuredClone(manifest.gaussian.coarse?.quality ?? null),
  };
}
