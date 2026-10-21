import { integer, record } from "../data-validation";
import { sha256 } from "../io/hash";
import { canonicalJson, documentDigest } from "./canonical";
import { buildOwnedBytes, verifyStoredResults } from "./compile";
import {
  inspectCpuBuffer,
  parseSnapshot,
  type SceneSnapshot,
  type BuildResourceContext,
} from "./contracts";
import { GENERAL_LIMITS as L, type AssetRef, type Result } from "./core";
import {
  makeAssetLibrary,
  verifyCatalogView,
  type AssetLibrary,
  type CatalogView,
} from "./asset-library";
import {
  assertAssetLayout,
  verifyAssetManifest,
  verifyAssetMember,
  parseAssetJson,
} from "./asset-package";
import { parseAssetManifest } from "./asset-manifest";
import { validateLegacyOriginal } from "./migration";
import { loadAsset, type LoadedAsset } from "./asset-loader";
import {
  readBoundedZip,
  readBoundedZipManifest,
  writeBoundedZip,
} from "./bounded-zip";

/** Caller includes every still-held input/current/renderer allocation. No unknown-zero default. */
export type IOContext = {
  signal: AbortSignal;
  resources: BuildResourceContext;
  /** Already held bytes from this same IO operation; also included in retainedBytes. */
  candidateBytes?: number;
};
export type SceneIOContext = IOContext & { library: AssetLibrary | null };
export type BufferDescriptor = {
  path: string[];
  format: "f32le" | "u32le" | "u8";
  length: number;
  hash: string;
};
export type SnapshotDocument = {
  snapshot: unknown;
  buffers: BufferDescriptor[];
  digest: string;
  resultBytes: number;
};
export type MemberReference = {
  assetRef: AssetRef;
  path: string;
  hash: string;
  bytes: number;
};
export type PreparedScene = {
  document: SnapshotDocument;
  catalog: CatalogView | null;
  members: MemberReference[];
  blobs: Map<string, Uint8Array>;
  ownedBytes: number;
};
export type ImportedScene = {
  snapshot: SceneSnapshot;
  assets: LoadedAsset[];
  missingRefs: (AssetRef & { digest: string; reason: string })[];
  editable: boolean;
  library: AssetLibrary | null;
  historyNotice: string;
  /** Only retained original member bytes. Snapshot/assets have separate independent ownership. */
  ownership: { readonly ownedBytes: number; dispose(): void };
};
const WORKSPACE = 16 * 1024 ** 2;
const hashPattern = /^[0-9a-f]{64}$/;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const refKey = (r: AssetRef) => canonicalJson([r.id, r.contentVersion]);
const memberKey = (r: AssetRef, path: string) =>
  canonicalJson([r.id, r.contentVersion, path]);
const viewOf = (l: CatalogView): CatalogView => ({
  digest: l.digest,
  manifests: l.manifests,
  styles: l.styles,
});
export function captureIO(context: IOContext): IOContext {
  if (
    !context ||
    !(context.signal instanceof AbortSignal) ||
    !context.resources
  )
    throw Error("Required IO signal/resources context");
  const retainedBytes = integer(
    context.resources.retainedBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  context.signal.throwIfAborted();
  const candidateBytes = integer(
    context.candidateBytes ?? 0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (candidateBytes > retainedBytes)
    throw Error("Internal candidate ledger exceeds retained bytes");
  return {
    signal: context.signal,
    resources: { retainedBytes },
    candidateBytes,
  };
}
export function checkIO(ctx: IOContext, additional: number): void {
  ctx.signal.throwIfAborted();
  integer(additional, 0, Number.MAX_SAFE_INTEGER);
  if (
    (ctx.candidateBytes ?? 0) + additional > L.maxCandidateCpuBytes ||
    ctx.resources.retainedBytes + additional > L.maxTransitionBytes
  )
    throw Error("Scene IO memory budget exceeded before allocation");
}
/** Carry operation-owned residency through nested codecs without losing the 128MiB cap. */
export function retainIO(ctx: IOContext, bytes: number): IOContext {
  integer(bytes, 0, Number.MAX_SAFE_INTEGER);
  return {
    signal: ctx.signal,
    resources: { retainedBytes: ctx.resources.retainedBytes + bytes },
    candidateBytes: (ctx.candidateBytes ?? 0) + bytes,
  };
}
/** No binary/string payload copies during this scan before parser/cloning/hash.
 * Binary leaves serialize as null in the descriptor. 64x metadata reserves the
 * simultaneous parsed objects, clones, tagged hashes, UTF-8 and canonical text.
 */
export function metadataBytes(value: unknown): number {
  let bytes = 0,
    nodes = 0;
  const seen = new Set<object>();
  const add = (n: number) => {
    bytes += n;
    if (bytes > L.maxJsonBytes) throw Error("Scene JSON exceeds 2 MiB");
  };
  const str = (s: string) => {
    add(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92) add(2);
      else if (c < 32)
        add(c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < s.length &&
        s.charCodeAt(i + 1) >= 0xdc00 &&
        s.charCodeAt(i + 1) <= 0xdfff
      ) {
        add(4);
        i++;
      } else add(c >= 0xd800 && c <= 0xdfff ? 6 : 3);
    }
  };
  const visit = (v: unknown, depth: number) => {
    if (depth > 64 || ++nodes > 300000)
      throw Error("Scene metadata complexity limit");
    if (ArrayBuffer.isView(v)) {
      inspectCpuBuffer(v);
      add(4);
      return;
    }
    if (v === null) {
      add(4);
      return;
    }
    if (typeof v === "string") {
      str(v);
      return;
    }
    if (typeof v === "boolean") {
      add(v ? 4 : 5);
      return;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw Error("Nonfinite metadata");
      add(String(v).length);
      return;
    }
    if (!v || typeof v !== "object" || seen.has(v))
      throw Error("Nondata/cyclic metadata");
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (
      proto !== null &&
      proto !== (array ? Array.prototype : Object.prototype)
    )
      throw Error("Nonplain metadata");
    seen.add(v);
    add(2);
    let count = 0;
    for (const key of Reflect.ownKeys(v)) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw Error("Unsafe metadata key");
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!d.enumerable || !("value" in d)) throw Error("Metadata accessor");
      if (count++) add(1);
      if (!array) {
        str(key);
        add(1);
      }
      visit(d.value, depth + 1);
    }
    if (array && count !== v.length) throw Error("Sparse metadata");
    seen.delete(v);
  };
  visit(value, 0);
  return bytes;
}
export const metadataWorkspace = (value: unknown) => 64 * metadataBytes(value);
export function jsonBytes(value: unknown): Uint8Array {
  metadataBytes(value);
  const text = canonicalJson(value);
  // Bound code units before UTF-8 allocation, then enforce actual bytes.
  if (text.length > L.maxJsonBytes) throw Error("Scene JSON exceeds 2 MiB");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > L.maxJsonBytes) throw Error("Scene JSON exceeds 2 MiB");
  return bytes;
}
export const ioFailure = (e: unknown): Result<never> => ({
  ok: false,
  issues: [
    {
      code:
        e instanceof DOMException && e.name === "AbortError"
          ? "cancelled"
          : "scene-io",
      path: "scene",
      message: e instanceof Error ? e.message : "Scene IO failed",
    },
  ],
});
function hash(value: unknown): string {
  if (typeof value !== "string" || !hashPattern.test(value))
    throw Error("Invalid SHA-256");
  return value;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("Invalid identity");
  return value;
}
/** Raw little-endian bytes, deliberately preserves -0 unlike canonical geometry hashes. */
function rawBytes(value: Float32Array | Uint32Array | Uint8Array): Uint8Array {
  const m = inspectCpuBuffer(value),
    out = new Uint8Array(m.byteLength),
    d = new DataView(out.buffer);
  for (let i = 0; i < m.length; i++) {
    if (m.format === "f32le") d.setFloat32(i * 4, m.value[i], true);
    else if (m.format === "u32le") d.setUint32(i * 4, m.value[i], true);
    else d.setUint8(i, m.value[i]);
  }
  return out;
}
function bufferSkeleton(
  value: unknown,
  leaves: { path: string[]; value: Float32Array | Uint32Array | Uint8Array }[],
  path: string[] = [],
): unknown {
  if (ArrayBuffer.isView(value)) {
    leaves.push({ path, value: inspectCpuBuffer(value).value });
    return null;
  }
  if (Array.isArray(value))
    return value.map((v, i) => bufferSkeleton(v, leaves, [...path, String(i)]));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        bufferSkeleton(v, leaves, [...path, k]),
      ]),
    );
  return value;
}
export function parseDocument(input: unknown): SnapshotDocument {
  jsonBytes(input);
  const r = record(input, ["snapshot", "buffers", "digest", "resultBytes"]);
  if (!Array.isArray(r.buffers) || r.buffers.length > 30000)
    throw Error("Buffer descriptor count");
  let size = 0;
  const paths = new Set<string>();
  const buffers = r.buffers.map((v) => {
    const b = record(v, ["path", "format", "length", "hash"]);
    if (
      !Array.isArray(b.path) ||
      !b.path.length ||
      b.path.length > 32 ||
      b.path.some(
        (k) =>
          typeof k !== "string" ||
          !k ||
          ["__proto__", "constructor", "prototype"].includes(k),
      )
    )
      throw Error("Unsafe buffer path");
    const key = canonicalJson(b.path);
    if (paths.has(key)) throw Error("Duplicate buffer role");
    paths.add(key);
    if (b.format !== "f32le" && b.format !== "u32le" && b.format !== "u8")
      throw Error("Buffer scalar format");
    const length = integer(b.length, 1, L.maxCandidateCpuBytes),
      format = b.format as BufferDescriptor["format"];
    size += length * (format === "u8" ? 1 : 4);
    if (size > L.maxCandidateCpuBytes) throw Error("Result buffer budget");
    return {
      path: [...b.path] as string[],
      format,
      length,
      hash: hash(b.hash),
    };
  });
  if (integer(r.resultBytes, 1, L.maxCandidateCpuBytes) !== size)
    throw Error("Result byte declaration mismatch");
  return {
    snapshot: r.snapshot,
    buffers,
    digest: hash(r.digest),
    resultBytes: size,
  };
}
export async function validateSnapshot(
  snapshot: SceneSnapshot,
  context: IOContext,
): Promise<void> {
  const ctx = captureIO(context);
  if (snapshot.capability === "editable")
    await verifyStoredResults(snapshot, ctx.signal);
  else
    await validateLegacyOriginal(
      snapshot.original,
      snapshot.originVersion,
      ctx,
    );
  ctx.signal.throwIfAborted();
}
export async function validateCatalog(
  snapshot: SceneSnapshot,
  catalog: CatalogView | null,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (snapshot.capability === "legacy-readonly") {
    if (catalog !== null) throw Error("Legacy has no invented catalog");
    return;
  }
  if (!catalog) throw Error("Missing original full catalog");
  await verifyCatalogView(catalog);
  signal.throwIfAborted();
  if (snapshot.plan.catalogDigest !== catalog.digest)
    throw Error("Original catalog digest differs from plan");
  for (const a of snapshot.assets) {
    const m = catalog.manifests.find((m) => refKey(m) === refKey(a.assetRef));
    if (!m || !same(m, a.manifest))
      throw Error("Pinned complete asset descriptor differs from catalog");
  }
  if (snapshot.surfaceStyle) {
    const s = catalog.styles.find(
      (s) => refKey(s) === refKey(snapshot.surfaceStyle!.assetRef),
    );
    if (!s || !same(s, snapshot.surfaceStyle.descriptor))
      throw Error("Pinned style differs from catalog");
  }
}
export function memberReferences(snapshot: SceneSnapshot): MemberReference[] {
  return snapshot.assets
    .flatMap((a) =>
      a.manifest.files.map((f) => ({
        assetRef: { ...a.assetRef },
        path: f.path,
        hash: f.sha256,
        bytes: f.bytes,
      })),
    )
    .sort((a, b) =>
      memberKey(a.assetRef, a.path).localeCompare(
        memberKey(b.assetRef, b.path),
      ),
    );
}
/** Shared IDB/archive codec. Only the exact snapshot dependencies are acquired. */
export async function prepareScene(
  input: SceneSnapshot,
  context: SceneIOContext,
  includeMembers: boolean,
): Promise<PreparedScene> {
  const ctx = captureIO(context);
  checkIO(ctx, WORKSPACE);
  const inputBytes = buildOwnedBytes(input),
    metadata =
      metadataWorkspace(input) +
      (context.library ? metadataWorkspace(viewOf(context.library)) : 0);
  if (ctx.resources.retainedBytes < inputBytes)
    throw Error("Underreported caller snapshot bytes");
  checkIO(ctx, metadata + WORKSPACE);
  const parsed = parseSnapshot(input),
    resultBytes = buildOwnedBytes(parsed);
  const stableLibrary = context.library
    ? makeAssetLibrary(viewOf(context.library), context.library.resolveMember)
    : null;
  const catalog = stableLibrary ? viewOf(stableLibrary) : null;
  const members = memberReferences(parsed),
    sourceBytes = includeMembers ? members.reduce((n, m) => n + m.bytes, 0) : 0;
  const decoded = Math.max(
    0,
    ...parsed.assets.map((a) => assertAssetLayout(a.manifest).decodedBytes),
  );
  // Clone, raw encoding, hash copy, transient resolver copy, validation decode and IDB/ZIP handoff.
  checkIO(
    ctx,
    4 * resultBytes + 4 * sourceBytes + decoded + metadata + WORKSPACE,
  );
  const snapshot = parseSnapshot(structuredClone(parsed));
  await validateSnapshot(snapshot, retainIO(ctx, resultBytes + metadata));
  await validateCatalog(snapshot, catalog, ctx.signal);
  const leaves: {
      path: string[];
      value: Float32Array | Uint32Array | Uint8Array;
    }[] = [],
    skeleton = bufferSkeleton(snapshot, leaves),
    blobs = new Map<string, Uint8Array>(),
    buffers: BufferDescriptor[] = [];
  for (const leaf of leaves) {
    ctx.signal.throwIfAborted();
    const data = rawBytes(leaf.value),
      h = await sha256(data);
    ctx.signal.throwIfAborted();
    blobs.set(h, data);
    const m = inspectCpuBuffer(leaf.value);
    buffers.push({
      path: leaf.path,
      format: m.format,
      length: m.length,
      hash: h,
    });
  }
  const document = {
    snapshot: skeleton,
    buffers,
    digest: await documentDigest(snapshot),
    resultBytes,
  };
  jsonBytes(document);
  ctx.signal.throwIfAborted();
  if (includeMembers) {
    if (snapshot.assets.length && !stableLibrary)
      throw Error("Exact member source required");
    for (const a of snapshot.assets) {
      await verifyAssetManifest(a.manifest);
      ctx.signal.throwIfAborted();
      for (const f of a.manifest.files) {
        const returned = await stableLibrary!.resolveMember(
          a.assetRef,
          f.path,
          ctx.signal,
        );
        ctx.signal.throwIfAborted();
        if (!(returned instanceof Uint8Array) || returned.length !== f.bytes)
          throw Error("Source member byte mismatch");
        const owned = new Uint8Array(returned);
        await verifyAssetMember(a.manifest, f.path, owned);
        ctx.signal.throwIfAborted();
        blobs.set(f.sha256, owned);
      }
    }
    if (catalog) {
      const local = makeAssetLibrary(catalog, async (r, path, signal) => {
        signal.throwIfAborted();
        const m = members.find(
          (m) => memberKey(m.assetRef, m.path) === memberKey(r, path),
        );
        const b = m && blobs.get(m.hash);
        if (!b) throw Error("Missing exact source member");
        return b;
      });
      for (const a of snapshot.assets) {
        await loadAsset(a.assetRef, local, ctx.signal);
        ctx.signal.throwIfAborted();
      }
    }
  }
  const ownedBytes =
    [...blobs.values()].reduce((n, b) => n + b.length, 0) +
    jsonBytes({ document, catalog, members }).length;
  checkIO(ctx, 2 * ownedBytes + metadata + WORKSPACE);
  return { document, catalog, members, blobs, ownedBytes };
}
export async function restoreDocument(
  input: SnapshotDocument,
  blobs: Map<string, Uint8Array>,
  context: IOContext,
): Promise<SceneSnapshot> {
  const ctx = captureIO(context),
    metadata = metadataWorkspace(input);
  checkIO(ctx, metadata + WORKSPACE);
  const d = parseDocument(input);
  checkIO(ctx, d.resultBytes * 3 + metadata + WORKSPACE);
  const skeleton = structuredClone(d.snapshot) as any;
  for (const b of d.buffers) {
    ctx.signal.throwIfAborted();
    const raw = blobs.get(b.hash),
      size = b.length * (b.format === "u8" ? 1 : 4);
    if (!raw || raw.length !== size || (await sha256(raw)) !== b.hash)
      throw Error("Missing or changed result buffer");
    ctx.signal.throwIfAborted();
    let parent = skeleton;
    for (const key of b.path.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key))
        throw Error("Unknown result buffer path");
      parent = parent[key];
    }
    const key = b.path.at(-1)!;
    if (
      !parent ||
      typeof parent !== "object" ||
      !Object.hasOwn(parent, key) ||
      parent[key] !== null
    )
      throw Error("Invalid result buffer placeholder");
    const array =
        b.format === "f32le"
          ? new Float32Array(b.length)
          : b.format === "u32le"
            ? new Uint32Array(b.length)
            : new Uint8Array(b.length),
      view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < b.length; i++)
      array[i] =
        b.format === "f32le"
          ? view.getFloat32(i * 4, true)
          : b.format === "u32le"
            ? view.getUint32(i * 4, true)
            : view.getUint8(i);
    parent[key] = array;
  }
  const snapshot = parseSnapshot(skeleton);
  if ((await documentDigest(snapshot)) !== d.digest)
    throw Error("Complete snapshot document digest mismatch");
  await validateSnapshot(snapshot, retainIO(ctx, d.resultBytes + metadata));
  return snapshot;
}
function checkRedistribution(snapshot: SceneSnapshot) {
  const sources = [
    ...snapshot.assets.map((a) => a.manifest),
    ...(snapshot.surfaceStyle ? [snapshot.surfaceStyle.descriptor] : []),
  ];
  if (sources.some((a) => !a.provenance.license.redistributable))
    throw Error(
      "Embedded redistribution is not permitted; export a reference archive instead (可导出引用包)。",
    );
}
export async function encodeGeneralArchive(
  input: SceneSnapshot,
  assets: LoadedAsset[],
  mode: "embedded" | "reference",
  context: SceneIOContext,
): Promise<Uint8Array> {
  const ctx = captureIO(context);
  if (mode !== "embedded" && mode !== "reference")
    throw Error("Unknown archive mode");
  checkIO(ctx, WORKSPACE);
  const metadata =
    metadataWorkspace(input) +
    (context.library ? metadataWorkspace(viewOf(context.library)) : 0);
  checkIO(ctx, metadata + WORKSPACE);
  const parsed = parseSnapshot(input);
  if (mode === "embedded") checkRedistribution(parsed);
  const assetBytes = buildOwnedBytes(assets);
  if (ctx.resources.retainedBytes < buildOwnedBytes({ input, assets }))
    throw Error("Underreported caller export bytes");
  checkIO(ctx, 2 * assetBytes + metadata + WORKSPACE);
  const layouts = parsed.assets.map((a) => assertAssetLayout(a.manifest));
  const sourceBytes =
    mode === "embedded" ? layouts.reduce((n, l) => n + l.sourceBytes, 0) : 0;
  checkIO(
    ctx,
    (mode === "embedded" ? assetBytes : 0) +
      4 * buildOwnedBytes(parsed) +
      4 * sourceBytes +
      Math.max(0, ...layouts.map((l) => l.decodedBytes)) +
      metadata +
      WORKSPACE,
  );
  const stableAssets = mode === "embedded" ? structuredClone(assets) : [];
  const p = await prepareScene(
    parsed,
    {
      ...retainIO(ctx, mode === "embedded" ? assetBytes : 0),
      library: context.library,
    },
    mode === "embedded",
  );
  if (mode === "embedded" && parsed.capability === "editable") {
    if (
      stableAssets.length !== parsed.assets.length ||
      new Set(stableAssets.map((a) => refKey(a.manifest))).size !==
        stableAssets.length
    )
      throw Error("Missing/extra decoded export assets");
    const lib = makeAssetLibrary(p.catalog!, async (r, path) => {
      const m = p.members.find(
        (m) => memberKey(m.assetRef, m.path) === memberKey(r, path),
      );
      if (!m) throw Error("Unknown member");
      return p.blobs.get(m.hash)!;
    });
    for (const descriptor of parsed.assets) {
      ctx.signal.throwIfAborted();
      const found = stableAssets.find(
        (a) => refKey(a.manifest) === refKey(descriptor.assetRef),
      );
      const loaded = await loadAsset(descriptor.assetRef, lib, ctx.signal);
      if (
        !found ||
        (await documentDigest(found)) !== (await documentDigest(loaded))
      )
        throw Error("Decoded export asset differs from exact originals");
    }
  }
  const sorted = [...p.blobs.entries()].sort(([a], [b]) => a.localeCompare(b));
  let size = 0;
  const blobs = sorted.map(([hash, b]) => {
    const item = { hash, bytes: b.length, offset: size };
    size += b.length;
    return item;
  });
  const manifest = jsonBytes({
    documentType: "general-gaussian-scene",
    formatVersion: 1,
    mode,
    document: p.document,
    catalog: p.catalog,
    members: p.members,
    blobs,
  });
  const total = size + manifest.length;
  checkIO(ctx, p.ownedBytes + assetBytes + 2 * total + metadata + WORKSPACE);
  if (total + 1024 > L.maxCompressedPackageBytes)
    throw Error("Archive exceeds 64 MiB stored ZIP limit");
  const payload = new Uint8Array(size);
  sorted.forEach(([, b], i) => payload.set(b, blobs[i].offset));
  ctx.signal.throwIfAborted();
  const result = writeBoundedZip(
    new Map([
      ["manifest.json", manifest],
      ["payload.bin", payload],
    ]),
    { allowedNames: ["manifest.json", "payload.bin"] },
  );
  ctx.signal.throwIfAborted();
  return result;
}
export async function decodeGeneralArchive(
  input: Uint8Array,
  library: AssetLibrary | null,
  context: IOContext,
): Promise<Result<ImportedScene>> {
  try {
    const ctx = captureIO(context);
    if (
      !(input instanceof Uint8Array) ||
      input.length > L.maxCompressedPackageBytes ||
      ctx.resources.retainedBytes < input.byteLength
    )
      throw Error("Compressed package limit");
    checkIO(ctx, input.length + WORKSPACE);
    const bytes = new Uint8Array(input),
      source = library
        ? makeAssetLibrary(viewOf(library), library.resolveMember)
        : null;
    const raw = readBoundedZipManifest(bytes);
    checkIO(ctx, bytes.length + 4 * raw.length + WORKSPACE);
    const parsedManifest = parseAssetJson(raw),
      metadata = metadataWorkspace(parsedManifest);
    checkIO(ctx, bytes.length + metadata + WORKSPACE);
    const m = record(parsedManifest, [
      "documentType",
      "formatVersion",
      "mode",
      "document",
      "catalog",
      "members",
      "blobs",
    ]);
    if (m.documentType !== "general-gaussian-scene" || m.formatVersion !== 1)
      throw Error(
        "Unknown general scene archive version; keep the original file",
      );
    if (m.mode !== "embedded" && m.mode !== "reference")
      throw Error("Unknown archive mode");
    const document = parseDocument(m.document);
    const catalog =
      m.catalog === null
        ? null
        : viewOf(
            makeAssetLibrary(m.catalog as CatalogView, async () => {
              throw Error("Unbound source");
            }),
          );
    if (
      !Array.isArray(m.members) ||
      m.members.length > 2048 ||
      !Array.isArray(m.blobs) ||
      m.blobs.length > 30000
    )
      throw Error("Member/blob descriptor limit");
    const members: MemberReference[] = m.members.map((v) => {
      const a = record(v, ["assetRef", "path", "hash", "bytes"]),
        r = record(a.assetRef, ["id", "contentVersion"]);
      return {
        assetRef: { id: text(r.id), contentVersion: text(r.contentVersion) },
        path: text(a.path),
        hash: hash(a.hash),
        bytes: integer(a.bytes, 1, L.maxExpandedPackageBytes),
      };
    });
    if (
      new Set(members.map((m) => memberKey(m.assetRef, m.path))).size !==
      members.length
    )
      throw Error("Duplicate dependency member");
    let size = 0;
    const hashes = new Set<string>();
    const entries = m.blobs.map((v) => {
      const b = record(v, ["hash", "bytes", "offset"]),
        h = hash(b.hash),
        n = integer(b.bytes, 1, L.maxExpandedPackageBytes);
      if (
        hashes.has(h) ||
        integer(b.offset, 0, L.maxExpandedPackageBytes) !== size
      )
        throw Error("Duplicate/overlapping/noncontiguous blob range");
      hashes.add(h);
      const offset = size;
      size += n;
      if (size > L.maxExpandedPackageBytes)
        throw Error("Expanded payload limit");
      return { hash: h, bytes: n, offset };
    });
    const required = new Set([
      ...document.buffers.map((b) => b.hash),
      ...(m.mode === "embedded" ? members.map((m) => m.hash) : []),
    ]);
    if (
      required.size !== hashes.size ||
      [...required].some((h) => !hashes.has(h))
    )
      throw Error("Missing or unrelated archive blob");
    const declarations = (document.snapshot as { assets?: unknown })?.assets;
    if (!Array.isArray(declarations) || declarations.length > 128)
      throw Error("Snapshot dependency metadata limit");
    const layouts = declarations.map((a) =>
      assertAssetLayout(parseAssetManifest(a.manifest)),
    );
    const sourceBytes = layouts.reduce((n, l) => n + l.sourceBytes, 0),
      decodedBytes = layouts.reduce((n, l) => n + l.decodedBytes, 0),
      maxMember = Math.max(0, ...layouts.map((l) => l.maxMemberBytes));
    if (sourceBytes !== members.reduce((n, m) => n + m.bytes, 0))
      throw Error("Declared dependency source byte mismatch");
    // Input copy + decoded ZIP + independent blobs + restored arrays + source acquisition/decoded assets/hash copies.
    checkIO(
      ctx,
      bytes.length +
        3 * size +
        3 * document.resultBytes +
        3 * sourceBytes +
        decodedBytes +
        2 * maxMember +
        metadata +
        WORKSPACE,
    );
    const files = readBoundedZip(bytes, {
      allowedNames: ["manifest.json", "payload.bin"],
      maxExpandedBytes: raw.length + size,
      maxMemberBytes: Math.max(raw.length, size),
      maxPeakBytes:
        Math.min(
          L.maxCandidateCpuBytes - (ctx.candidateBytes ?? 0),
          L.maxTransitionBytes - ctx.resources.retainedBytes,
        ) -
        metadata -
        WORKSPACE,
    });
    if (
      files.size !== 2 ||
      !files.has("payload.bin") ||
      files.get("payload.bin")!.length !== size
    )
      throw Error("Missing/extra payload member");
    const payload = files.get("payload.bin")!,
      blobs = new Map<string, Uint8Array>();
    for (const b of entries) {
      ctx.signal.throwIfAborted();
      const owned = payload.slice(b.offset, b.offset + b.bytes);
      if ((await sha256(owned)) !== b.hash)
        throw Error("Archive blob digest mismatch");
      ctx.signal.throwIfAborted();
      blobs.set(b.hash, owned);
    }
    const nested = retainIO(
      ctx,
      bytes.length + 2 * size + metadata + WORKSPACE / 2,
    );
    const snapshot = await restoreDocument(document, blobs, nested);
    await validateCatalog(snapshot, catalog, ctx.signal);
    if (!same(members, memberReferences(snapshot)))
      throw Error("Dependency members differ from snapshot manifests");
    if (m.mode === "embedded") checkRedistribution(snapshot);
    const originals = new Map<string, Uint8Array>(),
      missingRefs: ImportedScene["missingRefs"] = [],
      assets: LoadedAsset[] = [];
    let disposed = false;
    const recovered = catalog
      ? makeAssetLibrary(catalog, async (r, path, signal) => {
          signal.throwIfAborted();
          if (disposed) throw Error("Imported member source disposed");
          const b = originals.get(memberKey(r, path));
          if (!b) throw Error("Missing exact imported dependency");
          return b;
        })
      : null;
    for (const a of snapshot.assets) {
      let missing: string | null = null;
      for (const file of a.manifest.files) {
        try {
          ctx.signal.throwIfAborted();
          const received =
            m.mode === "embedded"
              ? blobs.get(file.sha256)
              : await (source
                  ? source.resolveMember(a.assetRef, file.path, ctx.signal)
                  : Promise.reject(
                      Error("No exact reference library available"),
                    ));
          ctx.signal.throwIfAborted();
          if (!received || received.length !== file.bytes)
            throw Error("Missing original member");
          const owned = new Uint8Array(received);
          await verifyAssetMember(a.manifest, file.path, owned);
          ctx.signal.throwIfAborted();
          originals.set(memberKey(a.assetRef, file.path), owned);
        } catch (e) {
          ctx.signal.throwIfAborted();
          if (m.mode === "embedded") throw e;
          missing = e instanceof Error ? e.message : "Missing dependency";
        }
      }
      if (missing)
        missingRefs.push({ ...a.assetRef, digest: a.digest, reason: missing });
      else assets.push(await loadAsset(a.assetRef, recovered!, ctx.signal));
    }
    ctx.signal.throwIfAborted();
    const retainedOriginals = [...originals.values()].reduce(
      (n, b) => n + b.byteLength,
      0,
    );
    checkIO(
      ctx,
      bytes.length +
        2 * size +
        retainedOriginals +
        buildOwnedBytes({ snapshot, assets }) +
        2 * maxMember +
        metadata +
        WORKSPACE,
    );
    return {
      ok: true,
      value: {
        snapshot,
        assets,
        missingRefs,
        editable: snapshot.capability === "editable" && !missingRefs.length,
        library: recovered,
        historyNotice: "包中未含此前撤销历史；后续本地编辑建立新的撤销链。",
        ownership: {
          get ownedBytes() {
            return [...originals.values()].reduce(
              (n, b) => n + b.byteLength,
              0,
            );
          },
          dispose() {
            disposed = true;
            originals.clear();
          },
        },
      },
    };
  } catch (e) {
    return ioFailure(e);
  }
}
