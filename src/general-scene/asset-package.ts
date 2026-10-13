import { parseAssetManifest, type AssetManifestV2 } from "./asset-manifest.ts";
import { GENERAL_LIMITS } from "./core.ts";
import { canonicalJson, jsonDigest } from "../io/prepared-ground.ts";
import { sha256 } from "../io/hash.ts";
import { SH3_KEYS } from "../io/sh3-variant.ts";
import {
  readBoundedZip,
  readBoundedZipManifest,
  writeBoundedZip,
} from "./bounded-zip.ts";

/** Immutable descriptor projection v1: reviews never recursively change their subject. */
export function assetIdentityProjection(manifest: AssetManifestV2) {
  const m = parseAssetManifest(manifest);
  const {
    contentVersion: _version,
    quality: _quality,
    gaussian,
    ...descriptor
  } = m;
  const { quality: _full, ...full } = gaussian.full;
  const coarse =
    gaussian.coarse && (({ quality: _coarse, ...lod }) => lod)(gaussian.coarse);
  return {
    projectionVersion: 1,
    descriptor: { ...descriptor, gaussian: { ...gaussian, full, coarse } },
  };
}
export async function assetContentVersion(
  manifest: AssetManifestV2,
): Promise<string> {
  return "sha256-" + (await jsonDigest(assetIdentityProjection(manifest)));
}
export const parseAssetJson = (bytes: Uint8Array): unknown => {
  if (bytes.byteLength > GENERAL_LIMITS.maxJsonBytes)
    throw Error("JSON exceeds byte limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
};
export function lodMemberNames(
  m: AssetManifestV2,
  lod: "full" | "coarse",
): string[] {
  if (m.gaussian.shDegree === 0 && m.origin === "procedural")
    return [`${m.id}-${lod}.f32`];
  if (m.gaussian.shDegree === 3)
    return SH3_KEYS.map((key) => `${m.id}-${lod}-${key}.u32`);
  throw Error(
    "Only procedural float14 or verified six-array SH3 input is supported",
  );
}
/** Checks derived sizes before any resolver, decoding or typed-array allocation. */
export function assertAssetLayout(m: AssetManifestV2): {
  sourceBytes: number;
  decodedBytes: number;
  maxMemberBytes: number;
} {
  const names = ["license.txt"],
    sizes = new Map<string, number>();
  let decodedBytes = 0;
  for (const lod of ["full", "coarse"] as const) {
    const d = m.gaussian[lod];
    if (!d) continue;
    for (const name of lodMemberNames(m, lod)) {
      const bytes =
        m.gaussian.shDegree === 0
          ? d.points * 56
          : Math.ceil(d.points / 2048) * 2048 * 16;
      names.push(name);
      sizes.set(name, bytes);
      decodedBytes += bytes;
    }
  }
  const proxy =
    m.kind === "patch"
      ? m.patch.heightProxy
      : m.kind === "environment"
        ? m.environment.heightProxy
        : null;
  if (proxy) {
    if (
      proxy.heightFile !== `${m.id}-heights.f32` ||
      proxy.normalFile !== `${m.id}-normals.f32`
    )
      throw Error("Invalid fixed proxy member names");
    names.push(proxy.heightFile, proxy.normalFile);
    sizes.set(proxy.heightFile, 1681 * 4);
    sizes.set(proxy.normalFile, 1681 * 12);
    decodedBytes += 1681 * 16;
    const b = m.coordinates.usableBounds;
    if (b.min[0] !== -2 || b.max[0] !== 2 || b.min[2] !== -2 || b.max[2] !== 2)
      throw Error("Only the fixed centered 4×4 proxy contract is supported");
  }
  if (
    m.files.length !== names.length ||
    names.some((name) => !m.files.some((f) => f.path === name))
  )
    throw Error("Missing or undeclared package member");
  for (const f of m.files)
    if (sizes.has(f.path) && sizes.get(f.path) !== f.bytes)
      throw Error("Array byte/count declaration mismatch");
  if (
    m.files.find((f) => f.path === "license.txt")!.bytes >
    GENERAL_LIMITS.maxJsonBytes
  )
    throw Error("License text exceeds limit");
  if (m.provenance.license.evidence !== "license.txt")
    throw Error("Packaged license evidence required");
  const sourceBytes = m.files.reduce((s, f) => s + f.bytes, 0),
    maxMemberBytes = Math.max(...m.files.map((f) => f.bytes));
  // Source/member/hash copies, decoded arrays, JSON and bounded decoder workspace.
  const peak = sourceBytes + decodedBytes + 2 * maxMemberBytes + 8 * 1024 ** 2;
  if (
    peak > GENERAL_LIMITS.maxCandidateCpuBytes ||
    decodedBytes > m.resources.decodedBytes ||
    sourceBytes > m.resources.cpuSourceBytes
  )
    throw Error("Candidate CPU budget or declared byte budget exceeded");
  if (
    peak + decodedBytes + m.resources.uploadBytes >
    GENERAL_LIMITS.maxTransitionBytes
  )
    throw Error("Transition budget exceeded");
  return { sourceBytes, decodedBytes, maxMemberBytes };
}
export async function verifyAssetManifest(
  value: unknown,
): Promise<AssetManifestV2> {
  const m = parseAssetManifest(value);
  assertAssetLayout(m);
  if (m.contentVersion !== (await assetContentVersion(m)))
    throw Error("Asset content identity mismatch");
  for (const lod of ["full", "coarse"] as const) {
    const d = m.gaussian[lod];
    if (!d) continue;
    const files = lodMemberNames(m, lod).map((name) =>
      m.files.find((f) => f.path === name)!,
    );
    const digest =
      m.gaussian.shDegree === 0 ? files[0].sha256 : await jsonDigest(files);
    if (d.sha256 !== digest) throw Error("LOD digest mismatch");
  }
  return m;
}
export async function verifyAssetMember(
  m: AssetManifestV2,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const f = m.files.find((f) => f.path === name);
  if (!f || !(bytes instanceof Uint8Array) || bytes.length !== f.bytes)
    throw Error("Member byte/count mismatch");
  if ((await sha256(bytes)) !== f.sha256) throw Error("Member digest mismatch");
  if (
    name === "license.txt" &&
    !new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()
  )
    throw Error("License text required");
}
export type AssetPackage = {
  manifest: AssetManifestV2;
  members: Map<string, Uint8Array>;
};
async function validatePackage(
  manifest: unknown,
  members: Map<string, Uint8Array>,
  signal = new AbortController().signal,
): Promise<AssetPackage> {
  const m = await verifyAssetManifest(manifest);
  if (members.size !== m.files.length)
    throw Error("Missing or undeclared package member");
  for (const [name, bytes] of members) await verifyAssetMember(m, name, bytes);
  const { createCatalogView, makeAssetLibrary } =
    await import("./asset-library.ts");
  const { loadAsset } = await import("./asset-loader.ts");
  await loadAsset(
    m,
    makeAssetLibrary(await createCatalogView([m], []), async (_r, n) =>
      members.get(n)!,
    ),
    signal,
  );
  return { manifest: m, members };
}
export async function prepareAssetPackage(
  manifest: unknown,
  members: Map<string, Uint8Array>,
): Promise<Uint8Array> {
  const m = parseAssetManifest(manifest),
    budget = assertAssetLayout(m);
  if (!(members instanceof Map) || members.size !== m.files.length)
    throw Error("Missing or undeclared package member");
  let actualBytes = 0;
  for (const [name, b] of members) {
    const f = m.files.find((f) => f.path === name);
    if (!f || !(b instanceof Uint8Array) || b.length !== f.bytes)
      throw Error("Actual member byte/count mismatch");
    actualBytes += b.length;
    if (actualBytes > GENERAL_LIMITS.maxExpandedPackageBytes)
      throw Error("Actual member budget exceeded");
  }
  if (actualBytes !== budget.sourceBytes)
    throw Error("Actual member total mismatch");
  if (
    2 * budget.sourceBytes +
      budget.decodedBytes +
      2 * budget.maxMemberBytes +
      8 * 1024 ** 2 >
    GENERAL_LIMITS.maxCandidateCpuBytes
  )
    throw Error("Package preparation peak budget exceeded");
  const snapshot = new Map(
    [...members].map(([n, b]) => [n, new Uint8Array(b)]),
  );
  await validatePackage(m, snapshot);
  snapshot.set("manifest.json", new TextEncoder().encode(canonicalJson(m)));
  return writeBoundedZip(snapshot, { allowedNames: [...snapshot.keys()] });
}
export async function readAssetPackage(
  bytes: Uint8Array,
  signal = new AbortController().signal,
): Promise<AssetPackage> {
  signal.throwIfAborted();
  if (bytes.length > GENERAL_LIMITS.maxCompressedPackageBytes)
    throw Error("Compressed package limit exceeded");
  const manifest = await verifyAssetManifest(
    parseAssetJson(readBoundedZipManifest(bytes)),
  );
  const budget = assertAssetLayout(manifest);
  if (
    bytes.length +
      budget.sourceBytes +
      budget.decodedBytes +
      2 * budget.maxMemberBytes +
      8 * 1024 ** 2 >
    GENERAL_LIMITS.maxCandidateCpuBytes
  )
    throw Error("Package decoding peak budget exceeded");
  const members = readBoundedZip(bytes, {
    allowedNames: ["manifest.json", ...manifest.files.map((f) => f.path)],
  });
  members.delete("manifest.json");
  return validatePackage(manifest, members, signal);
}
