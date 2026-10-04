import { finite, integer, oneOf, record, vector } from "../data-validation.ts";
import type { GroundArrays, GroundArrayKey } from "../gaussian/types.ts";
import { encodeRangeSafeRgb } from "../gaussian/sh3-range.ts";
import { sha256 } from "./hash.ts";
import { unpackBundle } from "./archive.ts";

export const SH3_KEYS = ["ext0", "ext1", "sh1", "sh2", "sh3a", "sh3b"] as const;
export type ShImportMode = "native" | "range-safe";
type Output = {
  key: GroundArrayKey;
  filename: string;
  bytes: number;
  sha256: string;
};
type Display = {
  quaternionXYZW: number[];
  position: number[];
  uniformScale: number;
};
export interface Sh3VariantManifest {
  format: "wetland-sh3-variant";
  version: 1;
  mode: ShImportMode;
  count: number;
  capacity: number;
  shBands: 3;
  sourcePlySha256: string;
  credit: string;
  display: Display;
  outputs: Output[];
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid hash");
  return value;
}
function capacityFor(
  count: unknown,
  capacity: unknown,
): { count: number; capacity: number } {
  const n = integer(count, 1, 250000),
    c = Math.ceil(n / 2048) * 2048;
  if (capacity !== c) throw new Error("Invalid SH3 array capacity");
  return { count: n, capacity: c };
}
function displayFrom(value: unknown): Display {
  if (!value || typeof value !== "object")
    throw new Error("Missing display transform");
  const d = value as Record<string, unknown>,
    q = vector(d.quaternionXYZW, 4);
  if (Math.abs(Math.hypot(...q) - 1) > 1e-6)
    throw new Error("Invalid quaternion");
  const scale = finite(d.uniformScale);
  if (scale <= 0) throw new Error("Invalid display scale");
  return {
    quaternionXYZW: q,
    position: vector(d.position, 3),
    uniformScale: scale,
  };
}
function creditFrom(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new Error("Asset credit is required");
  return value;
}
async function readArrays(
  outputs: unknown,
  files: Map<string, Uint8Array>,
  capacity: number,
) {
  if (!Array.isArray(outputs) || outputs.length !== 6 || files.size !== 6)
    throw new Error("Expected six SH3 arrays");
  const arrays = {} as GroundArrays,
    names = new Set<string>();
  for (const value of outputs) {
    const o = record(value, ["key", "filename", "bytes", "sha256"]);
    const key = oneOf(o.key, SH3_KEYS);
    if (
      arrays[key] ||
      typeof o.filename !== "string" ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.u32$/.test(o.filename) ||
      names.has(o.filename)
    )
      throw new Error("Invalid array name or duplicate key");
    names.add(o.filename);
    const b = files.get(o.filename);
    if (
      o.bytes !== capacity * 16 ||
      !(b instanceof Uint8Array) ||
      b.byteLength !== o.bytes
    )
      throw new Error("Invalid array length");
    if ((await sha256(b)) !== digest(o.sha256))
      throw new Error("Array hash mismatch");
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    arrays[key] = Uint32Array.from({ length: capacity * 4 }, (_, i) =>
      view.getUint32(i * 4, true),
    );
  }
  return arrays;
}
function plyFields(ply: Uint8Array, count: number) {
  // Deliberately narrow: existing 59-float binary LE SH3 PLY crops only.
  // Unsupported encodings/elements fail; no generic PLY guessing or downsampling.
  const marker = new TextEncoder().encode("end_header\n");
  let end = -1;
  for (let i = 0; i <= Math.min(ply.length, 16384) - marker.length; i++) {
    if (marker.every((v, j) => ply[i + j] === v)) {
      end = i + marker.length;
      break;
    }
  }
  if (end < 0) throw new Error("Unsupported PLY header");
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(ply.subarray(0, end))
    .trimEnd()
    .split("\n");
  if (lines[0] !== "ply" || lines[1] !== "format binary_little_endian 1.0")
    throw new Error("Unsupported PLY format");
  const fields: string[] = [];
  let vertices = 0;
  for (const line of lines.slice(2, -1)) {
    if (line.startsWith("comment ")) continue;
    if (
      line === `element vertex ${count}` &&
      vertices++ === 0 &&
      fields.length === 0
    )
      continue;
    const property = /^property float ([a-z0-9_]+)$/.exec(line);
    if (property && vertices === 1) {
      fields.push(property[1]);
      continue;
    }
    throw new Error("Unsupported PLY fields or count");
  }
  const required = [
    "x",
    "y",
    "z",
    ...[0, 1, 2].map((i) => `f_dc_${i}`),
    ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
    "opacity",
    ...[0, 1, 2].map((i) => `scale_${i}`),
    ...[0, 1, 2, 3].map((i) => `rot_${i}`),
  ];
  if (
    vertices !== 1 ||
    fields.length !== 59 ||
    new Set(fields).size !== 59 ||
    required.some((f) => !fields.includes(f)) ||
    ply.byteLength !== end + count * 236
  )
    throw new Error("Incomplete SH3 PLY or invalid length");
  return { end, offsets: Object.fromEntries(fields.map((f, i) => [f, i * 4])) };
}

/** Produce an explicit offline variant. Never change or recover old packed data in place. */
export async function prepareSh3Variant(
  ply: Uint8Array,
  native: unknown,
  files: Map<string, Uint8Array>,
  credit: string,
  mode: ShImportMode = "native",
): Promise<{ manifest: string; files: Map<string, Uint8Array> }> {
  oneOf(mode, ["native", "range-safe"]);
  if (!native || typeof native !== "object")
    throw new Error("Missing native manifest");
  const n = native as Record<string, unknown>;
  const { count, capacity } = capacityFor(n.numSplats, n.capacity);
  oneOf(n.shBands, [3]);
  const sourceHash = digest(n.inputSha256),
    display = displayFrom(n.display);
  creditFrom(credit);
  if (ply.byteLength > 64 * 1024 * 1024)
    throw new Error("Source exceeds input byte budget");
  if ((await sha256(ply)) !== sourceHash)
    throw new Error("Source PLY hash mismatch");
  const { end, offsets } = plyFields(ply, count);
  const arrays = await readArrays(n.outputs, files, capacity);
  const view = new DataView(ply.buffer, ply.byteOffset, ply.byteLength);
  for (let i = 0; i < count; i++) {
    const start = end + i * 236;
    for (let f = 0; f < 59; f++)
      if (!Number.isFinite(view.getFloat32(start + f * 4, true)))
        throw new Error("Nonfinite PLY field");
    for (let axis = 0; axis < 3; axis++)
      if (
        view.getUint32(start + offsets["xyz"[axis]], true) !==
        arrays.ext0[i * 4 + axis]
      )
        throw new Error("Native geometry does not match source PLY order");
    if (mode === "range-safe")
      for (let k = 0; k < 15; k++) {
        const r = view.getFloat32(start + offsets[`f_rest_${k}`], true);
        const g = view.getFloat32(start + offsets[`f_rest_${15 + k}`], true);
        const b = view.getFloat32(start + offsets[`f_rest_${30 + k}`], true);
        arrays[SH3_KEYS[2 + Math.floor(k / 4)]][i * 4 + (k % 4)] =
          encodeRangeSafeRgb(r, g, b);
      }
  }
  const outputFiles = new Map<string, Uint8Array>(),
    outputs: Output[] = [];
  for (const key of SH3_KEYS) {
    const bytes = new Uint8Array(capacity * 16),
      view = new DataView(bytes.buffer);
    arrays[key].forEach((word, i) => view.setUint32(i * 4, word, true));
    const filename = `${key}.u32`;
    outputFiles.set(filename, bytes);
    outputs.push({
      key,
      filename,
      bytes: bytes.byteLength,
      sha256: await sha256(bytes),
    });
  }
  const manifest: Sh3VariantManifest = {
    format: "wetland-sh3-variant",
    version: 1,
    mode,
    count,
    capacity,
    shBands: 3,
    sourcePlySha256: sourceHash,
    credit,
    display,
    outputs,
  };
  return { manifest: JSON.stringify(manifest, null, 2), files: outputFiles };
}

/** Reopen a variant package, not a main-scene F0 ZIP. No source/network needed. */
export async function readSh3Variant(
  bytes: Uint8Array,
): Promise<{ manifest: Sh3VariantManifest; arrays: GroundArrays }> {
  const bundle = unpackBundle(bytes);
  const m = record(JSON.parse(bundle.manifest), [
    "format",
    "version",
    "mode",
    "count",
    "capacity",
    "shBands",
    "sourcePlySha256",
    "credit",
    "display",
    "outputs",
  ]);
  oneOf(m.format, ["wetland-sh3-variant"]);
  oneOf(m.version, [1]);
  oneOf(m.shBands, [3]);
  oneOf(m.mode, ["native", "range-safe"]);
  const { capacity } = capacityFor(m.count, m.capacity);
  digest(m.sourcePlySha256);
  creditFrom(m.credit);
  record(m.display, ["quaternionXYZW", "position", "uniformScale"]);
  displayFrom(m.display);
  const arrays = await readArrays(m.outputs, bundle.files, capacity);
  return { manifest: m as unknown as Sh3VariantManifest, arrays };
}
