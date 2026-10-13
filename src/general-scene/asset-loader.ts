import { utils } from "@sparkjsdev/spark";
import { assertGaussianBuffer } from "../gaussian/validate.ts";
import type { GroundArrays } from "../gaussian/types.ts";
import { SH3_KEYS } from "../io/sh3-variant.ts";
import type { AssetManifestV2 } from "./asset-manifest.ts";
import type { AssetRef, Transform, Vec2 } from "./core.ts";
import {
  makeAssetLibrary,
  verifyCatalogView,
  type AssetLibrary,
} from "./asset-library.ts";
import {
  verifyAssetManifest,
  verifyAssetMember,
  lodMemberNames,
} from "./asset-package.ts";
/** Raw source coordinates, untouched SH. Consumers apply sourceToCanonical once, then canonical anchor placement. */
export type SplatSource =
  | { kind: "float14"; count: number; data: Float32Array }
  | { kind: "ext-sh3"; count: number; capacity: number; arrays: GroundArrays };
export type PatchProxy = {
  width: number;
  depth: number;
  spacing: number;
  heights: Float32Array;
  validPolygon: readonly Vec2[];
  voidMask: readonly (readonly Vec2[])[];
  errorBound: number;
  transform: Transform;
};
export type LoadedAsset = {
  manifest: AssetManifestV2;
  full: SplatSource;
  coarse: SplatSource | null;
  patch: PatchProxy | null;
};
const turn = async (signal: AbortSignal) => {
  signal.throwIfAborted();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal.throwIfAborted();
};
async function floats(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Float32Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    a = new Float32Array(bytes.length / 4);
  for (let start = 0; start < a.length; start += 16384) {
    await turn(signal);
    for (let i = start; i < Math.min(start + 16384, a.length); i++)
      a[i] = v.getFloat32(i * 4, true);
  }
  return a;
}
export async function loadAsset(
  ref: AssetRef,
  library: AssetLibrary,
  signal: AbortSignal,
): Promise<LoadedAsset> {
  signal.throwIfAborted();
  // Snapshot caller metadata before awaits; a caller cannot rewrite identity while a resolver runs.
  const stable = makeAssetLibrary(
    {
      digest: library.digest,
      manifests: library.manifests,
      styles: library.styles,
    },
    library.resolveMember,
  );
  await verifyCatalogView({
    digest: stable.digest,
    manifests: stable.manifests,
    styles: stable.styles,
  });
  signal.throwIfAborted();
  const declared = stable.manifests.find(
    (m) => m.id === ref.id && m.contentVersion === ref.contentVersion,
  );
  if (!declared) throw Error("Unknown asset reference");
  const m = await verifyAssetManifest(declared);
  signal.throwIfAborted();
  const read = async (name: string) => {
    await turn(signal);
    const b = await stable.resolveMember(m, name, signal);
    signal.throwIfAborted();
    await verifyAssetMember(m, name, b);
    signal.throwIfAborted();
    return b;
  };
  await read("license.txt");
  const decode = async (lod: "full" | "coarse"): Promise<SplatSource> => {
    const count = m.gaussian[lod]!.points,
      names = lodMemberNames(m, lod);
    if (m.gaussian.shDegree === 0) {
      const data = await floats(await read(names[0]), signal);
      for (let start = 0; start < count; start += 1024) {
        await turn(signal);
        const n = Math.min(1024, count - start);
        assertGaussianBuffer({
          count: n,
          data: data.subarray(start * 14, (start + n) * 14),
        });
      }
      return { kind: "float14", count, data };
    }
    const capacity = Math.ceil(count / 2048) * 2048,
      arrays = {} as GroundArrays;
    for (let k = 0; k < SH3_KEYS.length; k++) {
      const b = await read(names[k]),
        v = new DataView(b.buffer, b.byteOffset, b.byteLength),
        a = new Uint32Array(capacity * 4);
      for (let start = 0; start < a.length; start += 16384) {
        await turn(signal);
        for (let i = start; i < Math.min(start + 16384, a.length); i++)
          a[i] = v.getUint32(i * 4, true);
      }
      arrays[SH3_KEYS[k]] = a;
    }
    for (let start = 0; start < count; start += 512) {
      await turn(signal);
      for (let i = start; i < Math.min(start + 512, count); i++) {
        const s = utils.decodeExtSplat([arrays.ext0, arrays.ext1], i);
        if (
          [
            ...s.center.toArray(),
            ...s.scales.toArray(),
            ...s.quaternion.toArray(),
            s.color.r,
            s.color.g,
            s.color.b,
            s.opacity,
          ].some((x) => !Number.isFinite(x)) ||
          s.scales.toArray().some((x) => x <= 0) ||
          Math.abs(s.quaternion.length() - 1) > 0.01 ||
          s.opacity < 0 ||
          s.opacity > 1
        )
          throw Error("Invalid encoded Gaussian");
        for (let k = 0; k < 15; k++) {
          const c = utils.decodeExtRgb(
            arrays[SH3_KEYS[2 + Math.floor(k / 4)]][i * 4 + (k % 4)],
          );
          if (![c.r, c.g, c.b].every(Number.isFinite))
            throw Error("Invalid encoded SH");
        }
      }
    }
    return { kind: "ext-sh3", count, capacity, arrays };
  };
  const full = await decode("full"),
    coarse = m.gaussian.coarse ? await decode("coarse") : null;
  let patch: PatchProxy | null = null;
  const proxy =
    m.kind === "patch"
      ? m.patch.heightProxy
      : m.kind === "environment"
        ? m.environment.heightProxy
        : null;
  if (proxy) {
    const heights = await floats(await read(proxy.heightFile), signal),
      normals = await floats(await read(proxy.normalFile), signal);
    if (heights.some((h) => !Number.isFinite(h) || h < -2 || h > 2))
      throw Error("Invalid fixed proxy elevation");
    for (let i = 0; i < 1681; i++)
      if (
        !Number.isFinite(normals[i * 3]) ||
        !Number.isFinite(normals[i * 3 + 1]) ||
        !Number.isFinite(normals[i * 3 + 2]) ||
        Math.abs(Math.hypot(...normals.subarray(i * 3, i * 3 + 3)) - 1) > 0.01
      )
        throw Error("Invalid proxy normal");
    if (m.kind === "patch")
      patch = {
        width: 4,
        depth: 4,
        spacing: 0.1,
        heights,
        validPolygon: m.patch.usablePolygon,
        voidMask: m.patch.voidMask,
        errorBound: proxy.maxError,
        transform: m.patch.displayTransform,
      };
  }
  signal.throwIfAborted();
  return { manifest: m, full, coarse, patch };
}
