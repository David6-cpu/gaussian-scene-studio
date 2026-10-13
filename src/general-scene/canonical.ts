import { finite, record } from "../data-validation.ts";
import { sha256 } from "../io/hash.ts";
import {
  parseScenePlan,
  inspectCpuBuffer,
  parseEditableState,
  type ScenePlan,
  type EditableState,
} from "./contracts.ts";
import type { AssetRef } from "./core.ts";
/** Strict canonical JSON: sorted object keys, ordered arrays, exact explicit values and text. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): string => {
    if (depth > 64) throw Error("Canonical nesting limit");
    if (v === null || typeof v === "boolean" || typeof v === "string")
      return JSON.stringify(v);
    if (typeof v === "number") return JSON.stringify(finite(v) === 0 ? 0 : v);
    if (!v || typeof v !== "object" || seen.has(v))
      throw Error("Non-JSON/cyclic canonical value");
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (
      proto !== (array ? Array.prototype : Object.prototype) &&
      proto !== null
    )
      throw Error("Non-plain canonical object");
    seen.add(v);
    const keys = Reflect.ownKeys(v).filter((k) => !(array && k === "length"));
    for (const k of keys) {
      if (
        typeof k !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(k)
      )
        throw Error("Unsafe canonical key");
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (
        !d.enumerable ||
        !("value" in d) ||
        (array && !/^(0|[1-9][0-9]*)$/.test(k))
      )
        throw Error("Canonical accessor/key");
    }
    if (array && keys.length !== v.length)
      throw Error("Sparse canonical array");
    const out = array
      ? "[" + v.map((x) => visit(x, depth + 1)).join(",") + "]"
      : "{" +
        (keys as string[])
          .sort()
          .map(
            (k) =>
              JSON.stringify(k) +
              ":" +
              visit(Object.getOwnPropertyDescriptor(v, k)!.value, depth + 1),
          )
          .join(",") +
        "}";
    seen.delete(v);
    return out;
  };
  return visit(value, 0);
}
/** Only generated geometry samples use this boundary; explicit plan/user numbers never do. */
export function quantizeGeometry(value: number): number {
  finite(value);
  const n = Math.round(finite(value * 1e6)) / 1e6;
  return n === 0 ? 0 : n;
}
export function cpuBufferBytes(
  buffer: Float32Array | Uint32Array | Uint8Array,
): Uint8Array {
  const meta = inspectCpuBuffer(buffer);
  const out = new Uint8Array(meta.byteLength),
    view = new DataView(out.buffer);
  for (let i = 0; i < meta.length; i++) {
    const n = meta.value[i];
    if (meta.format === "f32le")
      view.setFloat32(i * 4, finite(n) === 0 ? 0 : n, true);
    else if (meta.format === "u32le") view.setUint32(i * 4, n, true);
    else view.setUint8(i, n);
  }
  return out;
}
export const cpuBufferDigest = (
  buffer: Float32Array | Uint32Array | Uint8Array,
): Promise<string> => sha256(cpuBufferBytes(buffer));
/** Full-document integrity encodes every node with an explicit type tag, including buffer hashes.
 * This prevents a JSON object from impersonating a buffer descriptor. Binary wrapper properties are discarded;
 * all plain-data evidence/bookkeeping remains included.
 */
export async function documentDigest(value: unknown): Promise<string> {
  const seen = new Set<object>();
  const visit = async (v: unknown, depth: number): Promise<unknown> => {
    if (depth > 64) throw Error("Document nesting limit");
    if (ArrayBuffer.isView(v)) {
      const meta = inspectCpuBuffer(v);
      return [
        "buffer",
        meta.format,
        meta.length,
        await cpuBufferDigest(meta.value),
      ];
    }
    if (v === null) return ["null"];
    if (typeof v === "number") return ["number", finite(v) === 0 ? 0 : v];
    if (typeof v === "boolean" || typeof v === "string") return [typeof v, v];
    if (!v || typeof v !== "object" || seen.has(v))
      throw Error("Non-data/cyclic document");
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (
      proto !== (array ? Array.prototype : Object.prototype) &&
      proto !== null
    )
      throw Error("Non-plain document");
    const keys = Reflect.ownKeys(v).filter((k) => !(array && k === "length"));
    for (const k of keys) {
      if (
        typeof k !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(k)
      )
        throw Error("Unsafe document key");
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (
        !d.enumerable ||
        !("value" in d) ||
        (array && !/^(0|[1-9][0-9]*)$/.test(k))
      )
        throw Error("Document accessor/key");
    }
    if (array && keys.length !== v.length) throw Error("Sparse document array");
    seen.add(v);
    const entries: unknown[] = [];
    for (const k of array ? keys : (keys as string[]).sort()) {
      const child = await visit(
        Object.getOwnPropertyDescriptor(v, k)!.value,
        depth + 1,
      );
      entries.push(array ? child : [k, child]);
    }
    seen.delete(v);
    return [array ? "array" : "object", entries];
  };
  return sha256(
    new TextEncoder().encode(
      // visit bounds source depth, sorts object entries and emits only fresh arrays/primitives.
      // Internal type tags add up to three levels per source level; they do not consume source depth.
      JSON.stringify(["general-scene-document-v1", await visit(value, 0)]),
    ),
  );
}
function bindingRef(v: unknown): AssetRef {
  const r = record(v, ["id", "contentVersion"]);
  for (const s of [r.id, r.contentVersion])
    if (
      typeof s !== "string" ||
      !s.trim() ||
      s.length > 200 ||
      /[\x00-\x1f\x7f]/.test(s)
    )
      throw Error("Invalid asset identity");
  return { id: r.id as string, contentVersion: r.contentVersion as string };
}
const digest = (v: unknown): string => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))
    throw Error("Invalid asset SHA-256");
  return v;
};
export function encodeAssetDigestBinding(
  asset: AssetRef,
  hash: string,
): string {
  const r = bindingRef(asset);
  return canonicalJson([r.id, r.contentVersion, digest(hash)]);
}
function decodeBinding(encoded: string): readonly [string, string, string] {
  if (typeof encoded !== "string" || encoded.length > 1000)
    throw Error("Invalid encoded binding");
  const a: unknown = JSON.parse(encoded);
  if (!Array.isArray(a) || a.length !== 3)
    throw Error("Expected [id,contentVersion,digest]");
  const r = bindingRef({ id: a[0], contentVersion: a[1] }),
    d = digest(a[2]);
  if (encodeAssetDigestBinding(r, d) !== encoded)
    throw Error("Noncanonical binding tuple");
  return [r.id, r.contentVersion, d];
}
/** A geometry projection, not document integrity. Preserve semantic sequence, exclude transaction/evidence UI. */
export async function geometryKey(
  plan: ScenePlan,
  state: EditableState,
  assetDigests: string[],
): Promise<string> {
  const p = parseScenePlan(plan),
    s = parseEditableState(state);
  if (!Array.isArray(assetDigests) || assetDigests.length > 128)
    throw Error("Asset binding limit");
  const bindings = assetDigests
      .map(decodeBinding)
      .sort((a, b) =>
        a[0] < b[0]
          ? -1
          : a[0] > b[0]
            ? 1
            : a[1] < b[1]
              ? -1
              : a[1] > b[1]
                ? 1
                : 0,
      ),
    keys = bindings.map((a) => canonicalJson(a.slice(0, 2)));
  if (new Set(keys).size !== keys.length)
    throw Error("Duplicate asset/version binding");
  const refs = [
    ...p.groups.map((g) => g.assetRef),
    ...(p.terrain.source === "patch" ? [p.terrain.assetRef] : []),
    ...(p.surfaceStyleRef ? [p.surfaceStyleRef] : []),
    ...s.overrides.flatMap((o) => (o.assetRef ? [o.assetRef] : [])),
  ];
  for (const r of refs)
    if (!keys.includes(canonicalJson([r.id, r.contentVersion])))
      throw Error("Missing actual asset/style binding");
  // Level provenance and count advice are semantic metadata, not geometry inputs.
  const water =
    p.water.mode === "none"
      ? p.water
      : (({ levelSource: _, levelStatus: __, ...geometry }) => geometry)(
          p.water,
        );
  const groups = p.groups.map(({ countMode: _, required: __, ...g }) => g);
  return documentDigest({
    projectionVersion: 1,
    plan: {
      domain: p.domain,
      terrain: p.terrain,
      water,
      surfaceStyleRef: p.surfaceStyleRef,
      regions: p.regions,
      groups,
      relations: p.relations,
      seed: p.seed,
      generatorVersion: p.generatorVersion,
      rulesVersion: p.rulesVersion,
      prngVersion: p.prngVersion,
      catalogDigest: p.catalogDigest,
      budgetProfileId: p.budgetProfileId,
    },
    state: {
      groups: [...s.groups].sort((a, b) =>
        a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
      ),
      tombstones: [...s.tombstones].sort(),
      lockedInstanceIds: [...s.lockedInstanceIds].sort(),
      overrides: [...s.overrides].sort((a, b) =>
        a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0,
      ),
      brushes: s.brushes,
      affectedRegions: s.affectedRegions,
    },
    assetBindings: bindings,
  });
}
