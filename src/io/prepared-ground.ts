import {
  decodeExtRgb,
  decodeExtSplat,
  isValidExtSplat,
} from "../gaussian/ext-decode.ts";
import { finite, integer, oneOf, record, vector } from "../data-validation.ts";
import {
  parseAssetMetadata,
  freeze,
  type AssetMetadata,
} from "../assets/catalog/metadata.ts";
import type { GroundArrays } from "../gaussian/types.ts";
import {
  SH3_KEYS,
  prepareSh3Variant,
  type ShImportMode,
} from "./sh3-variant.ts";
import { packBundle, unpackBundle } from "./archive.ts";
import { sha256 } from "./hash.ts";

export interface PreparedGroundDefinition {
  format: "wetland-prepared-ground";
  version: 1;
  metadata: AssetMetadata;
  sourcePlySha256: string;
  mode: ShImportMode;
  count: number;
  capacity: number;
  shBands: 3;
  display: {
    quaternionXYZW: number[];
    position: number[];
    uniformScale: number;
  };
  heightProxy: {
    width: 4;
    depth: 4;
    spacing: 0.1;
    nx: 41;
    nz: 41;
    heights: number[];
  };
  licenseText: string;
  licenseSha256: string;
  purpose: "workflow-test" | "candidate";
}
export interface PreparedGroundAsset {
  definition: PreparedGroundDefinition;
  arrays: GroundArrays;
}
export function canonicalJson(value: unknown): string {
  const visit = (x: unknown): unknown => {
    if (typeof x === "number") return finite(x) === 0 ? 0 : x;
    if (x === null || typeof x === "string" || typeof x === "boolean") return x;
    if (Array.isArray(x)) return x.map(visit);
    if (
      x &&
      typeof x === "object" &&
      Object.getPrototypeOf(x) === Object.prototype
    )
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, visit((x as Record<string, unknown>)[k])]),
      );
    throw Error("Unsupported canonical JSON value");
  };
  return JSON.stringify(visit(value));
}
export const jsonDigest = (value: unknown) =>
  sha256(new TextEncoder().encode(canonicalJson(value)));
function digest(x: unknown): string {
  if (typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x))
    throw Error("Invalid digest");
  return x;
}
export async function preparedContentVersion(
  d: PreparedGroundDefinition,
): Promise<string> {
  const { contentVersion: _, ...metadata } = d.metadata;
  return "sha256-" + (await jsonDigest({ ...d, metadata }));
}
export async function parsePreparedDefinition(
  value: unknown,
): Promise<PreparedGroundDefinition> {
  const d = record(value, [
    "format",
    "version",
    "metadata",
    "sourcePlySha256",
    "mode",
    "count",
    "capacity",
    "shBands",
    "display",
    "heightProxy",
    "licenseText",
    "licenseSha256",
    "purpose",
  ]);
  oneOf(d.format, ["wetland-prepared-ground"]);
  oneOf(d.version, [1]);
  oneOf(d.shBands, [3]);
  const metadata = parseAssetMetadata(d.metadata),
    count = integer(d.count, 1, 250000),
    capacity = Math.ceil(count / 2048) * 2048;
  if (
    d.capacity !== capacity ||
    metadata.loader !== "prepared-sh3-ground-v1" ||
    metadata.quality.status !== "trial" ||
    metadata.gaussian.full !== count ||
    metadata.gaussian.coarse !== null ||
    metadata.gaussian.shBands !== 3 ||
    metadata.gaussian.sourceBytes !== capacity * 96
  )
    throw Error("Prepared metadata/count/byte budget mismatch");
  const h = record(d.heightProxy, [
    "width",
    "depth",
    "spacing",
    "nx",
    "nz",
    "heights",
  ]);
  if (
    h.width !== 4 ||
    h.depth !== 4 ||
    h.spacing !== 0.1 ||
    h.nx !== 41 ||
    h.nz !== 41 ||
    !Array.isArray(h.heights) ||
    h.heights.length !== 1681
  )
    throw Error("Invalid 4×4 height proxy");
  const heights = h.heights.map((x) => finite(x, -1000, 1000));
  if (
    metadata.spatial.unit !== "display-unit" ||
    metadata.spatial.metricScale ||
    metadata.spatial.dimensions[0] !== 4 ||
    metadata.spatial.dimensions[2] !== 4 ||
    metadata.spatial.anchor.some((x) => x !== 0)
  )
    throw Error("Invalid prepared layout");
  const t = record(d.display, ["quaternionXYZW", "position", "uniformScale"]),
    q = vector(t.quaternionXYZW, 4),
    p = vector(t.position, 3),
    scale = finite(t.uniformScale, Number.MIN_VALUE, 1000);
  if (
    Math.abs(Math.hypot(...q) - 1) > 1e-6 ||
    p.some((x) => Math.abs(x) > 10000)
  )
    throw Error("Invalid prepared transform");
  if (
    typeof d.licenseText !== "string" ||
    !d.licenseText.trim() ||
    new TextEncoder().encode(d.licenseText).length > 65536
  )
    throw Error("Original license text required");
  if (
    (await sha256(new TextEncoder().encode(d.licenseText))) !==
    digest(d.licenseSha256)
  )
    throw Error("License digest mismatch");
  const prefix = `public/assets/local-ground/${metadata.id}/`;
  if (
    metadata.provenance.licenseFile !== prefix + "LICENSE.txt" ||
    metadata.provenance.files.length !== 6
  )
    throw Error("Invalid prepared license or array paths");
  for (const key of SH3_KEYS) {
    const f = metadata.provenance.files.find(
      (f) => f.path === prefix + key + ".u32",
    );
    if (!f || f.bytes !== capacity * 16)
      throw Error("Invalid prepared array declaration");
  }
  const result: PreparedGroundDefinition = {
    format: "wetland-prepared-ground",
    version: 1,
    metadata,
    sourcePlySha256: digest(d.sourcePlySha256),
    mode: oneOf(d.mode, ["native", "range-safe"] as const),
    count,
    capacity,
    shBands: 3,
    display: { quaternionXYZW: q, position: p, uniformScale: scale },
    heightProxy: { width: 4, depth: 4, spacing: 0.1, nx: 41, nz: 41, heights },
    licenseText: d.licenseText,
    licenseSha256: digest(d.licenseSha256),
    purpose: oneOf(d.purpose, ["workflow-test", "candidate"] as const),
  };
  if (metadata.contentVersion !== (await preparedContentVersion(result)))
    throw Error("Prepared content identity mismatch");
  return freeze(result);
}
export async function validatePreparedArrays(
  d: PreparedGroundDefinition,
  arrays: GroundArrays,
): Promise<void> {
  if (!arrays || Object.keys(arrays).length !== 6)
    throw Error("Expected six prepared arrays");
  for (const key of SH3_KEYS) {
    const a = arrays[key],
      f = d.metadata.provenance.files.find((f) =>
        f.path.endsWith(`/${key}.u32`),
      )!;
    if (
      !(a instanceof Uint32Array) ||
      a.length !== d.capacity * 4 ||
      (await sha256(arrayBytes(a))) !== f.sha256
    )
      throw Error("Prepared array length or digest mismatch");
  }
  for (let i = 0; i < d.count; i++) {
    if (!isValidExtSplat(decodeExtSplat([arrays.ext0, arrays.ext1], i)))
      throw Error("Invalid encoded Gaussian");
    for (let k = 0; k < 15; k++) {
      const c = decodeExtRgb(
        arrays[SH3_KEYS[2 + Math.floor(k / 4)]][i * 4 + (k % 4)],
      );
      if (!c.every(Number.isFinite)) throw Error("Invalid encoded SH");
    }
  }
}
export function arrayBytes(a: Uint32Array): Uint8Array {
  const b = new Uint8Array(a.byteLength),
    v = new DataView(b.buffer);
  a.forEach((n, i) => v.setUint32(i * 4, n, true));
  return b;
}
export async function readPreparedGround(
  bytes: Uint8Array,
): Promise<PreparedGroundAsset> {
  const b = unpackBundle(bytes),
    definition = await parsePreparedDefinition(JSON.parse(b.manifest));
  if (b.files.size !== 6) throw Error("Unexpected prepared member");
  const arrays = {} as GroundArrays;
  for (const key of SH3_KEYS) {
    const data = b.files.get(`${key}.u32`);
    if (!data || data.byteLength !== definition.capacity * 16)
      throw Error("Missing or invalid prepared array");
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    arrays[key] = Uint32Array.from({ length: data.byteLength / 4 }, (_, i) =>
      v.getUint32(i * 4, true),
    );
  }
  await validatePreparedArrays(definition, arrays);
  return { definition, arrays };
}
export async function prepareGroundPackage(input: {
  ply: Uint8Array;
  native: unknown;
  files: Map<string, Uint8Array>;
  metadata: Omit<AssetMetadata, "contentVersion">;
  heightProxy: unknown;
  licenseText: string;
  purpose: "workflow-test" | "candidate";
  mode?: ShImportMode;
}): Promise<Uint8Array> {
  const metadata = parseAssetMetadata({
    ...input.metadata,
    contentVersion: "pending",
  });
  if (
    !input.licenseText.trim() ||
    new TextEncoder().encode(input.licenseText).length > 65536
  )
    throw Error("Original license text required");
  const prepared = await prepareSh3Variant(
    input.ply,
    input.native,
    input.files,
    `${metadata.provenance.author} / ${metadata.provenance.source} / ${metadata.provenance.licenseUrl} / ${metadata.provenance.changes}`,
    input.mode,
  );
  const m = JSON.parse(prepared.manifest);
  // The caller must describe the original native files honestly; range-safe gets new output hashes.
  const n = input.native as {
    outputs: { key: string; sha256: string; bytes: number }[];
  };
  for (const key of SH3_KEYS) {
    const f = metadata.provenance.files.find(
        (f) =>
          f.path === `public/assets/local-ground/${metadata.id}/${key}.u32`,
      ),
      original = n.outputs.find((f) => f.key === key);
    if (
      !f ||
      !original ||
      f.bytes !== original.bytes ||
      f.sha256 !== original.sha256
    )
      throw Error("Input metadata does not match native arrays");
  }
  const outputs = m.outputs as { key: string; bytes: number; sha256: string }[];
  const definition: PreparedGroundDefinition = {
    format: "wetland-prepared-ground",
    version: 1,
    metadata: {
      ...metadata,
      provenance: {
        ...metadata.provenance,
        files: outputs.map((f) => ({
          path: `public/assets/local-ground/${metadata.id}/${f.key}.u32`,
          bytes: f.bytes,
          sha256: f.sha256,
        })),
      },
    },
    sourcePlySha256: m.sourcePlySha256,
    mode: m.mode,
    count: m.count,
    capacity: m.capacity,
    shBands: 3,
    display: m.display,
    heightProxy: input.heightProxy as PreparedGroundDefinition["heightProxy"],
    licenseText: input.licenseText,
    licenseSha256: await sha256(new TextEncoder().encode(input.licenseText)),
    purpose: input.purpose,
  };
  definition.metadata = {
    ...definition.metadata,
    contentVersion: await preparedContentVersion(definition),
  };
  const checked = await parsePreparedDefinition(definition);
  const bytes = packBundle({
    manifest: JSON.stringify(checked),
    files: prepared.files,
  });
  await readPreparedGround(bytes);
  return bytes;
}
