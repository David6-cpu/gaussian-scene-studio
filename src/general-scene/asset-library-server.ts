import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  existsSync,
  realpathSync,
  rmdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readBoundedFile } from "../assets/catalog/local.ts";
import { record, oneOf } from "../data-validation.ts";
import { canonicalJson } from "../io/prepared-ground.ts";
import {
  parseAssetManifest,
  parseSurfaceStyle,
  type AssetManifestV2,
  type SurfaceStyle,
} from "./asset-manifest.ts";
import { GENERAL_LIMITS } from "./core.ts";
import {
  readAssetPackage,
  parseAssetJson,
  assertAssetLayout,
  verifyAssetMember,
} from "./asset-package.ts";
import { readBoundedZip, readBoundedZipManifest } from "./bounded-zip.ts";
import {
  createCatalogView,
  makeAssetLibrary,
  type AssetLibrary,
} from "./asset-library.ts";

type Entry = { package: string; packageSha256: string; review: unknown };
type Index = {
  format: "general-scene-library";
  version: 1;
  entries: Entry[];
  styles: SurfaceStyle[];
};
function parseIndex(value: unknown): Index {
  const i = record(value, ["format", "version", "entries", "styles"]);
  oneOf(i.format, ["general-scene-library"]);
  oneOf(i.version, [1]);
  if (!Array.isArray(i.entries) || i.entries.length > 128)
    throw Error("Invalid library entries");
  const entries = i.entries.map((value) => {
    const e = record(value, ["package", "packageSha256", "review"]);
    if (
      typeof e.package !== "string" ||
      !/^([a-z][a-z0-9-]*)-sha256-[a-f0-9]{64}\.zip$/.test(e.package) ||
      typeof e.packageSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(e.packageSha256)
    )
      throw Error("Invalid registered package path or digest");
    return e as Entry;
  });
  if (new Set(entries.map((e) => e.package)).size !== entries.length)
    throw Error("Duplicate registered package");
  if (!Array.isArray(i.styles) || i.styles.length > 128)
    throw Error("Invalid library styles");
  return {
    format: "general-scene-library",
    version: 1,
    entries,
    styles: i.styles.map(parseSurfaceStyle),
  };
}
export function applyAssetReview(
  manifest: AssetManifestV2,
  value: unknown,
): AssetManifestV2 {
  const r = record(value, [
    "format",
    "version",
    "evidenceKind",
    "asset",
    "files",
    "quality",
    "full",
    "coarse",
  ]);
  oneOf(r.format, ["general-scene-asset-review"]);
  oneOf(r.version, [1]);
  oneOf(r.evidenceKind, ["constructed", "candidate-inspection", "human"]);
  if (
    canonicalJson(r.asset) !==
      canonicalJson({
        id: manifest.id,
        contentVersion: manifest.contentVersion,
      }) ||
    canonicalJson(r.files) !==
      canonicalJson(
        manifest.files.map(({ path, sha256 }) => ({ path, sha256 })),
      )
  )
    throw Error("Review asset or file identity mismatch");
  const m = parseAssetManifest({
    ...manifest,
    quality: r.quality,
    gaussian: {
      ...manifest.gaussian,
      full: { ...manifest.gaussian.full, quality: r.full },
      coarse: manifest.gaussian.coarse
        ? { ...manifest.gaussian.coarse, quality: r.coarse }
        : null,
    },
  });
  if (!manifest.gaussian.coarse && r.coarse !== null)
    throw Error("Review cannot invent coarse LOD");
  if (
    r.evidenceKind !== "human" &&
    (m.quality.status === "accepted" ||
      m.quality.humanReview !== null ||
      m.gaussian.full.quality.status === "passed" ||
      m.gaussian.coarse?.quality.status === "passed")
  )
    throw Error("Constructed/candidate review is not human acceptance");
  if (r.evidenceKind === "constructed" && !m.tags.includes("constructed"))
    throw Error("Constructed review requires constructed fixture label");
  if (m.tags.includes("constructed") && m.quality.status === "accepted")
    throw Error("Constructed fixtures cannot enter accepted assets");
  return m;
}
// Includes manifest/JSON buffers, bounded inflater scratch and small hash workspace.
const SERVER_WORKSPACE_BYTES = 8 * 1024 ** 2;
function remainingCpuBytes(residentBytes: number): number {
  if (
    !Number.isSafeInteger(residentBytes) ||
    residentBytes < 0 ||
    residentBytes > GENERAL_LIMITS.maxCandidateCpuBytes - SERVER_WORKSPACE_BYTES
  )
    throw Error("Invalid resident CPU budget");
  return (
    GENERAL_LIMITS.maxCandidateCpuBytes - residentBytes - SERVER_WORKSPACE_BYTES
  );
}
function packageReadLimit(residentBytes: number): number {
  // readBoundedFile owns both its read buffer and returned snapshot until return.
  return Math.min(
    GENERAL_LIMITS.maxCompressedPackageBytes,
    Math.floor(remainingCpuBytes(residentBytes) / 2),
  );
}
function assertPackagePeak(
  manifest: AssetManifestV2,
  packedBytes: number,
  residentBytes: number,
): void {
  const usage = assertAssetLayout(manifest);
  if (
    packedBytes +
      usage.sourceBytes +
      usage.decodedBytes +
      2 * usage.maxMemberBytes >
    remainingCpuBytes(residentBytes)
  )
    throw Error("Library decoding CPU budget exceeded");
}
// Node's incremental hash consumes the input directly, without a second package snapshot.
const packageDigest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Return metadata only: decoded arrays and the member map cannot escape into the next entry. */
async function validatedManifest(
  bytes: Uint8Array,
  residentBytes: number,
): Promise<AssetManifestV2> {
  const declared = parseAssetManifest(
    parseAssetJson(readBoundedZipManifest(bytes)),
  );
  assertPackagePeak(declared, bytes.length, residentBytes);
  const { manifest } = await readAssetPackage(bytes);
  return manifest;
}
async function readEntry(root: string, entry: Entry, residentBytes: number) {
  const bytes = readBoundedFile(
    join(root, entry.package),
    packageReadLimit(residentBytes),
    root,
  );
  if (packageDigest(bytes) !== entry.packageSha256)
    throw Error("Registered package changed (digest mismatch)");
  const manifest = applyAssetReview(
    await validatedManifest(bytes, residentBytes),
    entry.review,
  );
  return { entry, manifest, packedBytes: bytes.length };
}
async function readCatalog(root: string, index: Index, residentBytes: number) {
  remainingCpuBytes(residentBytes);
  const manifests: AssetManifestV2[] = [],
    entries = new Map<string, Awaited<ReturnType<typeof readEntry>>>();
  let storedBytes = 0;
  for (const entry of index.entries) {
    const checked = await readEntry(root, entry, residentBytes);
    const m = checked.manifest;
    storedBytes += checked.packedBytes;
    if (storedBytes > GENERAL_LIMITS.maxLocalBlobBytes)
      throw Error("Library blob budget exceeded");
    if (
      entry.package !== `${m.id}-${m.contentVersion}.zip` ||
      entries.has(m.id)
    )
      throw Error("Duplicate asset ID or mismatched package name");
    manifests.push(m);
    entries.set(m.id, checked);
  }
  return {
    view: await createCatalogView(manifests, index.styles),
    entries,
    storedBytes,
  };
}
/** Filesystem paths remain private to this Node-only module. HTTP must send CatalogView only. */
export async function loadLibrary(indexPath: string): Promise<AssetLibrary> {
  const path = resolve(indexPath),
    root = dirname(path);
  const index = parseIndex(
    parseAssetJson(readBoundedFile(path, GENERAL_LIMITS.maxJsonBytes, root)),
  );
  const { view, entries } = await readCatalog(root, index, 0);
  return makeAssetLibrary(view, async (ref, name, signal) => {
    signal.throwIfAborted();
    const checked = entries.get(ref.id);
    if (!checked || checked.manifest.contentVersion !== ref.contentVersion)
      throw Error("Unknown asset reference");
    const { entry, manifest, packedBytes } = checked;
    const usage = assertAssetLayout(manifest);
    // This reserve is the OUTER loadAsset's complete decoded capacity, not an inner decode.
    // During ZIP expansion: outer decoded + package + all source members + member/hash copies.
    assertPackagePeak(manifest, packedBytes, 0);
    const bytes = readBoundedFile(
      join(root, entry.package),
      Math.min(packedBytes, packageReadLimit(usage.decodedBytes)),
      root,
    );
    signal.throwIfAborted();
    if (packageDigest(bytes) !== entry.packageSha256)
      throw Error("Registered package changed (digest mismatch)");
    signal.throwIfAborted();
    // Exact whole-package SHA binds the initial full decoded validation. Revalidate ZIP
    // metadata/CRC and requested member SHA, but never recursively decode another asset.
    const members = readBoundedZip(bytes, {
      allowedNames: [
        "manifest.json",
        ...manifest.files.map((file) => file.path),
      ],
    });
    const member = members.get(name);
    if (!member) throw Error("Unknown member");
    await verifyAssetMember(manifest, name, member);
    signal.throwIfAborted();
    return member;
  });
}
/** An exclusive writer lock plus exclusive package/temp creation; index publishes atomically last. */
export async function registerAsset(input: {
  root: string;
  packageBytes: Uint8Array;
  review: unknown;
}): Promise<string> {
  if (input.packageBytes.length > GENERAL_LIMITS.maxCompressedPackageBytes)
    throw Error("Compressed package limit exceeded");
  if (
    2 * input.packageBytes.length + 8 * 1024 ** 2 >
    GENERAL_LIMITS.maxCandidateCpuBytes
  )
    throw Error("Registration snapshot budget exceeded");
  const declared = parseAssetManifest(
      parseAssetJson(readBoundedZipManifest(input.packageBytes)),
    ),
    usage = assertAssetLayout(declared);
  if (
    2 * input.packageBytes.length +
      usage.sourceBytes +
      usage.decodedBytes +
      2 * usage.maxMemberBytes +
      8 * 1024 ** 2 >
    GENERAL_LIMITS.maxCandidateCpuBytes
  )
    throw Error("Registration decoding budget exceeded");
  const review = JSON.parse(canonicalJson(input.review)),
    bytes = new Uint8Array(input.packageBytes),
    m = applyAssetReview(
      await validatedManifest(bytes, input.packageBytes.length),
      review,
    );
  const root = resolve(input.root),
    indexPath = join(root, "index.json"),
    created = !existsSync(root);
  if (created) mkdirSync(root);
  else if (realpathSync(root) !== root)
    throw Error("Library root cannot be a symlink");
  const lockPath = join(root, "register.lock"),
    lock = openSync(lockPath, "wx"),
    owned: string[] = [];
  let published = false;
  try {
    const old = existsSync(indexPath)
      ? parseIndex(
          parseAssetJson(
            readBoundedFile(indexPath, GENERAL_LIMITS.maxJsonBytes, root),
          ),
        )
      : {
          format: "general-scene-library" as const,
          version: 1 as const,
          entries: [],
          styles: [],
        };
    // New input and immutable snapshot remain live while the old entries are verified.
    // validatedManifest returned metadata only; no new source-member map is retained here.
    const previous = await readCatalog(
      root,
      old,
      input.packageBytes.length + bytes.length,
    );
    await createCatalogView([...previous.view.manifests, m], old.styles);
    const name = `${m.id}-${m.contentVersion}.zip`;
    const index: Index = {
      ...old,
      entries: [
        ...old.entries,
        { package: name, packageSha256: packageDigest(bytes), review },
      ],
    };
    const json = canonicalJson(index);
    if (
      new TextEncoder().encode(json).length > GENERAL_LIMITS.maxJsonBytes ||
      index.entries.length > 128
    )
      throw Error("Library index exceeds limit");
    if (bytes.length + previous.storedBytes > GENERAL_LIMITS.maxLocalBlobBytes)
      throw Error("Library blob budget exceeded");
    const write = (name: string, data: string | Uint8Array) => {
      const path = join(root, name),
        fd = openSync(path, "wx");
      owned.push(path);
      try {
        writeFileSync(fd, data);
      } finally {
        closeSync(fd);
      }
    };
    write(name, bytes);
    write("index-pending.json", json + "\n");
    renameSync(join(root, "index-pending.json"), indexPath);
    published = true;
    return indexPath;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
    if (!published) {
      for (const path of owned.reverse())
        try {
          unlinkSync(path);
        } catch {}
      if (created)
        try {
          rmdirSync(root);
        } catch {}
    }
  }
}
