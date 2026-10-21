import type { HeightModel, ProfileWater } from "./water-profile.ts";
import { finite, integer, oneOf, record, vector } from "../data-validation.ts";
import {
  parseAssetManifest,
  parseSurfaceStyle,
  type AssetManifestV2,
  type SurfaceStyle,
} from "./asset-manifest.ts";
import {
  GENERAL_LIMITS as L,
  assertBudget,
  type AssetRef,
  type CameraState,
  type Issue,
  type Transform,
  type Vec2,
} from "./core.ts";

export type FieldSource = "user" | "model" | "default" | "manual";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** World XZ, simple polygon, no repeated closing vertex. */
export type Polygon = readonly Vec2[];
export type AtomicConstraint = {
  key: string;
  value: JsonValue;
  source: FieldSource;
  span: readonly [number, number] | null;
  strength: "hard" | "suggestion";
  negated: boolean;
};
export type SceneInstance = {
  instanceId: string;
  groupId: string;
  assetRef: AssetRef;
  transform: Transform;
  locked: boolean;
};
export type OperationContext = {
  operationId: string;
  baseRevisionId: string | null;
  signal: AbortSignal;
};
export type RevisionContext = OperationContext & {
  sceneId: string;
  revisionId: string;
};
export type BuildResourceContext = { retainedBytes: number };
export type CompileContext = RevisionContext & {
  intent: SceneIntent;
  modelEvidence: readonly ModelEvidence[];
  patch: ScenePatch | null;
  camera: CameraState;
  resources: BuildResourceContext;
  baseSnapshot: EditableSnapshot | null;
};
export type WorkerCompileContext = Omit<CompileContext, "signal">;
export type QualityCheck = {
  status: "pass" | "fail" | "pending" | "not-applicable";
  evidenceRefs: string[];
  issues: Issue[];
};
export type QualityReport = {
  geometryDigest: string;
  semanticMode: "model-verified" | "manual-corrected" | "unverified";
  semantic: QualityCheck;
  assets: QualityCheck;
  geometry: QualityCheck;
  visual: QualityCheck;
  performance: QualityCheck;
};

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const digest = (v: unknown): string => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))
    throw Error("Invalid SHA-256");
  return v;
};
function text(v: unknown, max = 2000, empty = false): string {
  if (typeof v !== "string" || v.length > max || (!empty && !v.trim()))
    throw Error("Invalid text");
  return v;
}
function id(v: unknown): string {
  const s = text(v, 200);
  if (
    /[\x00-\x1f\x7f]/.test(s) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      s,
    )
  )
    throw Error("Invalid identity");
  return s;
}
const bool = (v: unknown) => oneOf(v, [true, false]);
const source = (v: unknown): FieldSource =>
  oneOf(v, ["user", "model", "default", "manual"] as const);
const nullableId = (v: unknown) => (v === null ? null : id(v));
function list<T>(
  v: unknown,
  parse: (v: unknown) => T,
  max = 10000,
  min = 0,
): T[] {
  if (!Array.isArray(v) || v.length < min || v.length > max)
    throw Error("Invalid list length");
  return v.map((item) => parse(item));
}
function unique<T>(xs: T[]): T[] {
  if (new Set(xs).size !== xs.length)
    throw Error("Duplicate identity or value");
  return xs;
}
const ids = (v: unknown, max = 10000) => unique(list(v, id, max));
const vec2 = (v: unknown) => vector(v, 2) as [number, number];
const vec3 = (v: unknown) => vector(v, 3) as [number, number, number];
function range(v: unknown, min: number, max: number): [number, number] {
  const r = vec2(v);
  r.forEach((x) => finite(x, min, max));
  if (r[0] > r[1]) throw Error("Reversed range");
  return r;
}
function ref(v: unknown): AssetRef {
  const r = record(v, ["id", "contentVersion"]);
  return { id: id(r.id), contentVersion: id(r.contentVersion) };
}
const refKey = (r: AssetRef) => JSON.stringify([r.id, r.contentVersion]);
function transform(v: unknown): Transform {
  const r = record(v, ["position", "quaternion", "scale"]),
    q = vector(r.quaternion, 4) as [number, number, number, number];
  if (Math.abs(Math.hypot(...q) - 1) > 1e-6) throw Error("Non-unit quaternion");
  return {
    position: vec3(r.position),
    quaternion: q,
    scale: finite(r.scale, Number.MIN_VALUE),
  };
}
function camera(v: unknown): CameraState {
  const r = record(v, ["position", "target"]),
    position = vec3(r.position),
    target = vec3(r.target);
  if (position.every((x, i) => x === target[i]))
    throw Error("Camera direction is zero");
  return { position, target };
}
function issue(v: unknown): Issue {
  const r = record(v, ["code", "path", "message"]);
  return {
    code: id(r.code),
    path: text(r.path, 1000, true),
    message: text(r.message),
  };
}

/** Intrinsic getters cannot be shadowed by own typed-array metadata or accessors. */
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayGetter = (key: PropertyKey) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, key)!.get!;
const intrinsicFormat = typedArrayGetter(Symbol.toStringTag);
const intrinsicBuffer = typedArrayGetter("buffer");
const intrinsicByteOffset = typedArrayGetter("byteOffset");
const intrinsicByteLength = typedArrayGetter("byteLength");
const intrinsicLength = typedArrayGetter("length");
const intrinsicBackingBytes = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;

/** Normalize binary leaves without copying bytes or retaining an untrusted view wrapper.
 * View-only properties are discarded, never read or enumerated (millions of numeric keys at max size).
 * Backing buffers must remain property-free; subviews/empty views are permitted only for standalone hashing.
 */
export function inspectCpuBuffer(value: unknown) {
  const brand: unknown = intrinsicFormat.call(value);
  const format =
    brand === "Float32Array"
      ? ("f32le" as const)
      : brand === "Uint32Array"
        ? ("u32le" as const)
        : brand === "Uint8Array"
          ? ("u8" as const)
          : null;
  if (format === null) throw Error("Unsupported CPU scalar format");
  const prototype =
    format === "f32le"
      ? Float32Array.prototype
      : format === "u32le"
        ? Uint32Array.prototype
        : Uint8Array.prototype;
  if (Object.getPrototypeOf(value) !== prototype)
    throw Error("Unexpected buffer prototype");
  const buffer: unknown = intrinsicBuffer.call(value);
  if (
    !(buffer instanceof ArrayBuffer) ||
    Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
  )
    throw Error("Unexpected/shared backing buffer");
  const byteOffset: number = intrinsicByteOffset.call(value),
    byteLength: number = intrinsicByteLength.call(value),
    length: number = intrinsicLength.call(value),
    backingByteLength: number = intrinsicBackingBytes.call(buffer);
  // Reject sizes before metadata enumeration or element scans. Runtime aggregate budget is checked separately.
  if (
    backingByteLength > L.maxCandidateCpuBytes ||
    byteLength > L.maxCandidateCpuBytes
  )
    throw Error("Runtime buffer budget exceeded");
  // DataView distinguishes an empty live buffer from a detached one.
  new DataView(buffer, byteOffset, byteLength);
  if (Reflect.ownKeys(buffer).length)
    throw Error("Unexpected backing-buffer properties");
  const clean =
    format === "f32le"
      ? new Float32Array(buffer, byteOffset, length)
      : format === "u32le"
        ? new Uint32Array(buffer, byteOffset, length)
        : new Uint8Array(buffer, byteOffset, length);
  return {
    value: clean,
    format,
    buffer,
    byteOffset,
    byteLength,
    length,
    backingByteLength,
  };
}

/** Inspect descriptors before property access. Runtime buffers are leaves; their bytes never enter JSON. */
function checkData(value: unknown, runtime = false): number {
  const seen = new Set<object>(),
    buffers = new Set<ArrayBuffer>();
  let bytes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 32) throw Error("Contract nesting limit exceeded");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return finite(v);
    if (!v || typeof v !== "object") throw Error("Expected plain data");
    if (runtime && ArrayBuffer.isView(v)) {
      const meta = inspectCpuBuffer(v);
      if (
        meta.byteOffset !== 0 ||
        meta.byteLength !== meta.backingByteLength ||
        meta.backingByteLength === 0 ||
        buffers.has(meta.buffer)
      )
        throw Error("Missing, detached, shared or aliased result buffer");
      buffers.add(meta.buffer);
      bytes += meta.byteLength;
      if (bytes > L.maxCandidateCpuBytes)
        throw Error("Runtime buffer budget exceeded");
      return { scalar: meta.format, length: meta.length };
    }
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (
      seen.has(v) ||
      (proto !== (array ? Array.prototype : Object.prototype) && proto !== null)
    )
      throw Error("Non-JSON or cyclic data");
    seen.add(v);
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Reflect.ownKeys(v)) {
      if (array && k === "length") continue;
      if (
        typeof k !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(k)
      )
        throw Error("Unsafe data key");
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (
        !d.enumerable ||
        !("value" in d) ||
        (array && !/^(0|[1-9][0-9]*)$/.test(k))
      )
        throw Error("Accessors/extra array keys forbidden");
      out[k] = visit(d.value, depth + 1);
    }
    if (array && Object.keys(v).length !== v.length)
      throw Error("Sparse array");
    seen.delete(v);
    return array ? Object.values(out) : out;
  };
  if (
    new TextEncoder().encode(JSON.stringify(visit(value, 0))).length >
    L.maxJsonBytes
  )
    throw Error("JSON metadata budget exceeded");
  return bytes;
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !ArrayBuffer.isView(v)) {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
const cross = (a: Vec2, b: Vec2, c: Vec2) =>
  finite((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.abs(cross(a, b, p)) <= 1e-9 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-9 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9
  );
}
function intersects(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  return (
    (Math.sign(cross(a, b, c)) * Math.sign(cross(a, b, d)) < 0 &&
      Math.sign(cross(c, d, a)) * Math.sign(cross(c, d, b)) < 0) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}
function polygon(v: unknown): Polygon {
  const p = list(v, vec2, 12, 3);
  unique(p.map((x) => JSON.stringify(x)));
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    area = finite(area + a[0] * b[1] - a[1] * b[0]);
    if (
      Math.abs(cross(a, b, p[(i + 2) % p.length])) <= 1e-9 &&
      onSegment(a, b, p[(i + 2) % p.length])
    )
      throw Error("Overlapping polygon edges");
    for (let j = i + 2; j < p.length; j++)
      if (
        !(i === 0 && j === p.length - 1) &&
        intersects(a, b, p[j], p[(j + 1) % p.length])
      )
        throw Error("Self-intersecting polygon");
  }
  if (Math.abs(area) <= 1e-9) throw Error("Degenerate polygon");
  return p;
}
function contains(p: Polygon, q: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[j],
      b = p[i];
    if (onSegment(a, b, q)) return true;
    if (
      a[1] > q[1] !== b[1] > q[1] &&
      q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function containsPolygon(outer: Polygon, inner: Polygon): boolean {
  // Check all edge pieces split by outer vertices/intersections, not just endpoints in a concave region.
  return inner.every((a, i) => {
    const b = inner[(i + 1) % inner.length],
      ts = [0, 1];
    for (let j = 0; j < outer.length; j++) {
      const c = outer[j],
        d = outer[(j + 1) % outer.length],
        den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
      if (Math.abs(den) > 1e-12) {
        const t =
          ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
        if (
          t > 0 &&
          t < 1 &&
          onSegment(c, d, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
        )
          ts.push(t);
      }
    }
    ts.sort((a, b) => a - b);
    return ts.every(
      (t, j) =>
        contains(outer, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]) &&
        (j === 0 ||
          contains(outer, [
            a[0] + ((t + ts[j - 1]) / 2) * (b[0] - a[0]),
            a[1] + ((t + ts[j - 1]) / 2) * (b[1] - a[1]),
          ])),
    );
  });
}
function bounds(v: unknown) {
  const r = record(v, ["min", "max"]),
    min = vec2(r.min),
    max = vec2(r.max);
  if (min.some((x, i) => x >= max[i])) throw Error("Empty bounds");
  return { min, max };
}
function domain(v: unknown) {
  const r = record(v, ["width", "depth", "unit", "up"]);
  const extent = (x: unknown) => {
    const n = finite(x, L.minExtent, L.maxExtent);
    if ((n / L.extentStep) % 1 !== 0) throw Error("Extent step");
    return n;
  };
  return {
    width: extent(r.width),
    depth: extent(r.depth),
    unit: oneOf(r.unit, ["display-unit"] as const),
    up: oneOf(r.up, ["+Y"] as const),
  };
}
function inDomain(p: Polygon, d: { width: number; depth: number }): void {
  if (
    p.some(([x, z]) => Math.abs(x) > d.width / 2 || Math.abs(z) > d.depth / 2)
  )
    throw Error("Outside scene domain");
}
function atom(v: unknown, rawLength?: number): AtomicConstraint {
  const r = record(v, [
    "key",
    "value",
    "source",
    "span",
    "strength",
    "negated",
  ]);
  let span: [number, number] | null = null;
  if (r.span !== null) {
    span = range(r.span, 0, rawLength ?? L.maxPromptCharacters);
    span.forEach((x) => integer(x, 0, rawLength ?? L.maxPromptCharacters));
    if (span[0] === span[1]) throw Error("Empty source span");
  }
  const src = source(r.source);
  if (src === "user" && span === null)
    throw Error("User source needs original span");
  return {
    key: id(r.key),
    value: structuredClone(r.value) as JsonValue,
    source: src,
    span,
    strength: oneOf(r.strength, ["hard", "suggestion"] as const),
    negated: bool(r.negated),
  };
}
export function parseIntent(value: unknown) {
  checkData(value);
  const r = record(value, [
    "documentType",
    "schemaVersion",
    "requestId",
    "raw",
    "language",
    "operation",
    "baseRevisionId",
    "terrain",
    "features",
    "sourceConstraints",
    "relations",
    "prohibitions",
    "water",
    "seed",
    "unspecified",
    "conflicts",
    "unsupported",
  ]);
  const raw = text(r.raw, L.maxPromptCharacters),
    operation = oneOf(r.operation, ["create", "patch"] as const),
    baseRevisionId = nullableId(r.baseRevisionId),
    water = record(r.water, ["mode", "constraints"]),
    a = (v: unknown) => atom(v, raw.length);
  if ((operation === "create") !== (baseRevisionId === null))
    throw Error("Operation base mismatch");
  const features = list(
    r.features,
    (v) => {
      const f = record(v, [
        "featureId",
        "category",
        "required",
        "quantity",
        "sourceRestriction",
        "constraints",
      ]);
      return {
        featureId: id(f.featureId),
        category: id(f.category),
        required: bool(f.required),
        quantity: f.quantity === null ? null : a(f.quantity),
        sourceRestriction: oneOf(f.sourceRestriction, [
          "either",
          "captured",
          "procedural",
          "generated",
        ] as const),
        constraints: list(f.constraints, a, 64),
      };
    },
    64,
  );
  unique(features.map((f) => f.featureId));
  return freeze({
    documentType: oneOf(r.documentType, ["general-scene-intent"] as const),
    schemaVersion: oneOf(r.schemaVersion, [1] as const),
    requestId: id(r.requestId),
    raw,
    language: id(r.language),
    operation,
    baseRevisionId,
    terrain: list(r.terrain, a, 64),
    features,
    sourceConstraints: list(r.sourceConstraints, a, 64),
    relations: list(r.relations, a, 64),
    prohibitions: list(r.prohibitions, a, 64),
    water: {
      mode: oneOf(water.mode, [
        "unspecified",
        "none",
        "river",
        "surface",
        "conflict",
      ] as const),
      constraints: list(water.constraints, a, 64),
    },
    seed: r.seed === null ? null : a(r.seed),
    unspecified: ids(r.unspecified, 128),
    conflicts: list(r.conflicts, issue, 128),
    unsupported: list(r.unsupported, issue, 128),
  });
}
export type SceneIntent = ReturnType<typeof parseIntent>;

function parseTerrain(v: unknown, d: { width: number; depth: number }) {
  if (!v || typeof v !== "object") throw Error("Missing terrain");
  if ((v as { source?: unknown }).source === "patch") {
    const r = record(v, ["source", "assetRef", "transform"]);
    return {
      source: "patch" as const,
      assetRef: ref(r.assetRef),
      transform: transform(r.transform),
    };
  }
  const r = record(v, [
      "source",
      "elevation",
      "slopeDegrees",
      "slopeAzimuthDegrees",
      "noiseAmplitude",
      "noiseScale",
      "noiseOctaves",
      "spacing",
    ]),
    spacing = oneOf(r.spacing, [0.1, 0.2] as const);
  const nx = Math.round(d.width / spacing) + 1,
    nz = Math.round(d.depth / spacing) + 1;
  if (
    Math.abs((nx - 1) * spacing - d.width) > 1e-9 ||
    Math.abs((nz - 1) * spacing - d.depth) > 1e-9 ||
    nx * nz > L.maxHeightNodes
  )
    throw Error("Spacing must divide extents within node budget");
  return {
    source: oneOf(r.source, ["procedural"] as const),
    elevation: finite(r.elevation, -2, 2),
    slopeDegrees: finite(r.slopeDegrees, 0, 12),
    slopeAzimuthDegrees: finite(r.slopeAzimuthDegrees, 0, 360),
    noiseAmplitude: finite(r.noiseAmplitude, 0, 0.4),
    noiseScale: finite(r.noiseScale, 0.5, 5),
    noiseOctaves: integer(r.noiseOctaves, 1, 4),
    spacing,
  };
}
function parseWater(v: unknown, d: { width: number; depth: number }) {
  if (!v || typeof v !== "object") throw Error("Missing water choice");
  const mode = (v as { mode?: unknown }).mode;
  if (mode === "none" || mode === "unspecified") {
    const r = record(v, ["mode"]);
    return { mode: oneOf(r.mode, ["none", "unspecified"] as const) };
  }
  const common = [
      "mode",
      "waterId",
      "depth",
      "bankWidth",
      "level",
      "levelStatus",
      "levelSource",
      "reshapePolicy",
    ],
    r = record(v, [
      ...common,
      ...(mode === "river" ? ["controlPoints", "width"] : ["polygon"]),
    ]);
  const level = r.level === null ? null : finite(r.level, -2, 2),
    levelStatus = oneOf(r.levelStatus, ["pending", "resolved"] as const),
    levelSource = r.levelSource === null ? null : source(r.levelSource);
  if (
    (levelStatus === "pending") !== (level === null) ||
    (level === null) !== (levelSource === null)
  )
    throw Error("Water level provenance/status mismatch");
  const base = {
    waterId: id(r.waterId),
    depth: finite(r.depth, 0.05, 0.5),
    bankWidth: finite(r.bankWidth, 0.2, 1),
    level,
    levelStatus,
    levelSource,
    reshapePolicy: oneOf(r.reshapePolicy, [
      "cut-and-fill",
      "cut-only",
      "preserve",
    ] as const),
  };
  if (mode === "river") {
    const points = list(r.controlPoints, (v) => rangePoint(v), 8, 2);
    unique(points.map((p) => JSON.stringify(p)));
    const edges = (p: Vec2) =>
      [
        p[0] === 0 ? "west" : null,
        p[0] === 1 ? "east" : null,
        p[1] === 0 ? "south" : null,
        p[1] === 1 ? "north" : null,
      ].filter((x) => x !== null);
    const first = edges(points[0]),
      last = edges(points.at(-1)!);
    if (!first.length || !last.length || first.some((e) => last.includes(e)))
      throw Error("River endpoints need different boundaries");
    for (let i = 0; i < points.length - 1; i++)
      for (let j = i + 2; j < points.length - 1; j++)
        if (intersects(points[i], points[i + 1], points[j], points[j + 1]))
          throw Error("Self-intersecting river control polyline");
    return {
      mode: "river" as const,
      ...base,
      controlPoints: points,
      width: finite(r.width, 0.4, 2),
    };
  }
  const p = polygon(r.polygon);
  inDomain(p, d);
  return { mode: oneOf(r.mode, ["surface"] as const), ...base, polygon: p };
}
function rangePoint(v: unknown): Vec2 {
  const p = vec2(v);
  p.forEach((x) => finite(x, 0, 1));
  return p;
}
function review(v: unknown) {
  const r = record(v, [
    "assumptions",
    "unsupported",
    "missing",
    "substitutions",
    "acceptedSubstitutions",
    "manualOverrides",
    "fieldSources",
  ]);
  const substitutions = list(
    r.substitutions,
    (v) => {
      const s = record(v, [
        "substitutionId",
        "groupId",
        "requested",
        "assetRef",
        "digest",
        "reason",
      ]);
      return {
        substitutionId: id(s.substitutionId),
        groupId: id(s.groupId),
        requested: text(s.requested),
        assetRef: ref(s.assetRef),
        digest: digest(s.digest),
        reason: text(s.reason),
      };
    },
    24,
  );
  const acceptedSubstitutions = list(
    r.acceptedSubstitutions,
    (v) => {
      const s = record(v, [
        "substitutionId",
        "planId",
        "catalogDigest",
        "assetRef",
        "digest",
      ]);
      return {
        substitutionId: id(s.substitutionId),
        planId: id(s.planId),
        catalogDigest: digest(s.catalogDigest),
        assetRef: ref(s.assetRef),
        digest: digest(s.digest),
      };
    },
    24,
  );
  unique(substitutions.map((s) => s.substitutionId));
  unique(acceptedSubstitutions.map((s) => s.substitutionId));
  return {
    assumptions: list(r.assumptions, atom, 128),
    unsupported: list(r.unsupported, issue, 128),
    missing: list(
      r.missing,
      (v) => {
        const m = record(v, ["key", "required", "reason"]);
        return {
          key: id(m.key),
          required: bool(m.required),
          reason: text(m.reason),
        };
      },
      128,
    ),
    substitutions,
    acceptedSubstitutions,
    manualOverrides: list(r.manualOverrides, atom, 128),
    fieldSources: list(r.fieldSources, atom, 256),
  };
}
function relation(v: unknown) {
  const k = (v as { kind?: unknown })?.kind;
  if (k === "within" || k === "outside") {
    const r = record(v, ["kind", "groupId", "regionId"]);
    return {
      kind: oneOf(r.kind, ["within", "outside"] as const),
      groupId: id(r.groupId),
      regionId: id(r.regionId),
    };
  }
  if (k === "nearWater") {
    const r = record(v, ["kind", "groupId", "min", "max"]),
      min = finite(r.min, 0),
      max = finite(r.max, min);
    return { kind: "nearWater" as const, groupId: id(r.groupId), min, max };
  }
  const r = record(v, ["kind", "groupId", "distance"]);
  return {
    kind: oneOf(r.kind, ["minSpacing", "keepDry"] as const),
    groupId: id(r.groupId),
    distance: finite(r.distance, k === "keepDry" ? 0.1 : 0),
  };
}
export function parsePlanDraft(value: unknown) {
  checkData(value);
  const r = record(value, [
      "documentType",
      "schemaVersion",
      "planId",
      "intentDigest",
      "catalogDigest",
      "generatorVersion",
      "rulesVersion",
      "prngVersion",
      "seed",
      "domain",
      "terrain",
      "water",
      "surfaceStyleRef",
      "regions",
      "groups",
      "relations",
      "budgetProfileId",
      "budgetEstimate",
      "review",
    ]),
    d = domain(r.domain),
    terrain = parseTerrain(r.terrain, d),
    water = parseWater(r.water, d);
  if (
    terrain.source === "patch" &&
    "reshapePolicy" in water &&
    water.reshapePolicy !== "preserve"
  )
    throw Error("Patch geometry may not be reshaped");
  const regions = list(
    r.regions,
    (v) => {
      const a = record(v, ["regionId", "shape"]),
        s = a.shape as { kind?: unknown };
      if (s?.kind === "rectangle") {
        const b = record(s, ["kind", "min", "max"]),
          bb = bounds({ min: b.min, max: b.max });
        inDomain([bb.min, bb.max], d);
        return {
          regionId: id(a.regionId),
          shape: { kind: "rectangle" as const, ...bb },
        };
      }
      const b = record(s, ["kind", "polygon"]),
        p = polygon(b.polygon);
      inDomain(p, d);
      return {
        regionId: id(a.regionId),
        shape: { kind: oneOf(b.kind, ["polygon"] as const), polygon: p },
      };
    },
    8,
  );
  unique(regions.map((x) => x.regionId));
  const groups = list(
    r.groups,
    (v) => {
      const g = record(v, [
          "groupId",
          "assetRef",
          "regionId",
          "count",
          "countMode",
          "required",
          "scaleRange",
          "orientation",
          "placementPolicy",
        ]),
        o = record(g.orientation, ["mode", "yawDegrees"]),
        p = record(g.placementPolicy, ["maxSlopeDegrees", "spacingMargin"]);
      return {
        groupId: id(g.groupId),
        assetRef: g.assetRef === null ? null : ref(g.assetRef),
        regionId: nullableId(g.regionId),
        count: integer(g.count, 0, 20),
        countMode: oneOf(g.countMode, ["hard", "suggestion"] as const),
        required: bool(g.required),
        scaleRange: range(g.scaleRange, Number.MIN_VALUE, 1000),
        orientation: {
          mode: oneOf(o.mode, [
            "upright-yaw",
            "surface-normal",
            "fixed",
          ] as const),
          yawDegrees: range(o.yawDegrees, 0, 360),
        },
        placementPolicy: {
          maxSlopeDegrees: finite(p.maxSlopeDegrees, 0, 90),
          spacingMargin: finite(p.spacingMargin, 0),
        },
      };
    },
    8,
  );
  unique(groups.map((g) => g.groupId));
  if (groups.reduce((n, g) => n + g.count, 0) > 20)
    throw Error("Instance count budget");
  for (const g of groups)
    if (g.regionId !== null && !regions.some((r) => r.regionId === g.regionId))
      throw Error("Unknown group region");
  const relations = list(r.relations, relation, 128);
  for (const a of relations)
    if (
      !groups.some((g) => g.groupId === a.groupId) ||
      ("regionId" in a && !regions.some((r) => r.regionId === a.regionId)) ||
      (a.kind === "nearWater" && water.mode === "none")
    )
      throw Error("Unknown/impossible relation reference");
  const reviewed = review(r.review),
    planId = id(r.planId),
    catalogDigest = digest(r.catalogDigest);
  for (const s of reviewed.substitutions) {
    const g = groups.find((g) => g.groupId === s.groupId);
    if (!g?.assetRef || refKey(g.assetRef) !== refKey(s.assetRef))
      throw Error("Substitution group binding mismatch");
  }
  for (const a of reviewed.acceptedSubstitutions) {
    const s = reviewed.substitutions.find(
      (s) => s.substitutionId === a.substitutionId,
    );
    if (
      !s ||
      a.planId !== planId ||
      a.catalogDigest !== catalogDigest ||
      refKey(a.assetRef) !== refKey(s.assetRef) ||
      a.digest !== s.digest
    )
      throw Error("Stale substitution confirmation");
  }
  let estimate = null;
  if (r.budgetEstimate !== null) {
    const e = record(r.budgetEstimate, [
      "instances",
      "worstSplats",
      "candidateCpuBytes",
      "transitionBytes",
      "reservedSurfaceSplats",
    ]);
    const usage = {
      instances: integer(e.instances, 0, 20),
      worstSplats: integer(e.worstSplats, 0, 250000),
      candidateCpuBytes: integer(
        e.candidateCpuBytes,
        0,
        L.maxCandidateCpuBytes,
      ),
      transitionBytes: integer(e.transitionBytes, 0, L.maxTransitionBytes),
    };
    assertBudget(usage, L);
    estimate = {
      ...usage,
      reservedSurfaceSplats: integer(e.reservedSurfaceSplats, 0, 250000),
    };
  }
  return freeze({
    documentType: oneOf(r.documentType, ["general-scene-plan"] as const),
    schemaVersion: oneOf(r.schemaVersion, [1] as const),
    planId,
    intentDigest: digest(r.intentDigest),
    catalogDigest,
    generatorVersion: id(r.generatorVersion),
    rulesVersion: id(r.rulesVersion),
    prngVersion: oneOf(r.prngVersion, ["fnv1a32-v1"] as const),
    seed: integer(r.seed, 0, 0xffffffff),
    domain: d,
    terrain,
    water,
    surfaceStyleRef: r.surfaceStyleRef === null ? null : ref(r.surfaceStyleRef),
    regions,
    groups,
    relations,
    budgetProfileId: oneOf(r.budgetProfileId, ["general-v1"] as const),
    budgetEstimate: estimate,
    review: reviewed,
  });
}
export type PlanDraft = ReturnType<typeof parsePlanDraft>;
type ResolvedWater =
  | { mode: "none" }
  | (Exclude<PlanDraft["water"], { mode: "none" | "unspecified" }> & {
      level: number;
      levelStatus: "resolved";
      levelSource: FieldSource;
    });
export type ScenePlan = Omit<PlanDraft, "water" | "groups"> & {
  water: ResolvedWater;
  groups: (Omit<PlanDraft["groups"][number], "assetRef"> & {
    assetRef: AssetRef;
  })[];
};
export function parseScenePlan(v: unknown): ScenePlan {
  const p = parsePlanDraft(v);
  if (
    p.water.mode === "unspecified" ||
    ("level" in p.water && p.water.level === null) ||
    p.groups.some((g) => g.assetRef === null) ||
    p.review.missing.some((m) => m.required) ||
    p.review.substitutions.some(
      (s) =>
        !p.review.acceptedSubstitutions.some(
          (a) => a.substitutionId === s.substitutionId,
        ),
    )
  )
    throw Error("Unresolved plan");
  if (
    (p.terrain.source === "procedural" || p.water.mode !== "none") &&
    p.surfaceStyleRef === null
  )
    throw Error("Generated surfaces require a bound style");
  return p as ScenePlan;
}

export function parseModelEvidence(value: unknown) {
  checkData(value);
  const r = record(value, [
    "stage",
    "provenance",
    "requestedModel",
    "raw",
    "model",
    "promptVersion",
    "startedAt",
    "endedAt",
    "failureReason",
  ]);
  const time = (v: unknown) => {
    const t = text(v, 80);
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(t) ||
      !Number.isFinite(Date.parse(t))
    )
      throw Error("Invalid UTC evidence time");
    return t;
  };
  const startedAt = time(r.startedAt),
    endedAt = time(r.endedAt);
  if (Date.parse(endedAt) < Date.parse(startedAt))
    throw Error("Evidence end before start");
  const failureReason = r.failureReason === null ? null : text(r.failureReason),
    raw = r.raw === null ? null : text(r.raw, 65536, true),
    // Rejected protocol identities are observed bounded text, not application IDs.
    // Preserve even empty/control/ill-formed UTF-16 strings from a bounded JSON reply.
    model =
      r.model === null
        ? null
        : failureReason === null
          ? id(r.model)
          : text(r.model, 65536, true);
  if (failureReason === null && (raw === null || model === null))
    throw Error("Successful model evidence requires actual reply");
  return freeze({
    stage: oneOf(r.stage, ["intent", "plan", "repair"] as const),
    provenance: oneOf(r.provenance, ["real", "constructed"] as const),
    requestedModel: id(r.requestedModel),
    raw,
    model,
    promptVersion: id(r.promptVersion),
    startedAt,
    endedAt,
    failureReason,
  });
}
export type ModelEvidence = ReturnType<typeof parseModelEvidence>;

/** URL-escaped group identity plus a decimal monotonic slot; encoding is unambiguous. */
export function instanceIdFor(groupId: string, slot: number): string {
  return `${encodeURIComponent(id(groupId))}:${integer(slot, 0, MAX_SAFE)}`;
}
/** A legal group has at most200 UTF-16 units, each expanding to at most9 URI characters.
 * Keep the entire escaped identity plus colon and all16 decimal safe-integer slot digits.
 */
function parseInstanceId(value: unknown): string {
  const encoded = text(value, 200 * 9 + 1 + String(MAX_SAFE).length);
  const split = encoded.lastIndexOf(":");
  if (split < 1) throw Error("Invalid instance identity");
  const groupId = id(decodeURIComponent(encoded.slice(0, split)));
  const rawSlot = encoded.slice(split + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(rawSlot)) throw Error("Invalid slot identity");
  const slot = integer(Number(rawSlot), 0, MAX_SAFE);
  if (instanceIdFor(groupId, slot) !== encoded)
    throw Error("Noncanonical instance identity");
  return encoded;
}
const instanceIds = (value: unknown, max = 10000) =>
  unique(list(value, parseInstanceId, max));

function slotOf(instanceId: string, groupId: string): number {
  parseInstanceId(instanceId);
  const prefix = encodeURIComponent(groupId) + ":";
  if (!instanceId.startsWith(prefix)) throw Error("Instance/group mismatch");
  const raw = instanceId.slice(prefix.length);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw Error("Invalid slot identity");
  return integer(Number(raw), 0, MAX_SAFE);
}
function containsCircle(p: Polygon, center: Vec2, radius: number): boolean {
  return (
    contains(p, center) &&
    p.every((a, i) => {
      const b = p[(i + 1) % p.length],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        t = Math.max(
          0,
          Math.min(
            1,
            ((center[0] - a[0]) * dx + (center[1] - a[1]) * dz) /
              (dx * dx + dz * dz),
          ),
        );
      return (
        Math.hypot(center[0] - a[0] - t * dx, center[1] - a[1] - t * dz) +
          1e-9 >=
        radius
      );
    })
  );
}
function brush(v: unknown) {
  const r = record(v, [
      "sequence",
      "center",
      "radius",
      "delta",
      "requestedRegion",
      "effectiveRegion",
    ]),
    center = vec2(r.center),
    requestedRegion = polygon(r.requestedRegion),
    effectiveRegion = polygon(r.effectiveRegion);
  if (
    !containsCircle(requestedRegion, center, finite(r.radius, 0.2, 1)) ||
    !containsPolygon(effectiveRegion, requestedRegion)
  )
    throw Error("Brush region mismatch");
  return {
    sequence: integer(r.sequence, 1, MAX_SAFE),
    center,
    radius: finite(r.radius, 0.2, 1),
    delta: finite(r.delta, -0.2, 0.2),
    requestedRegion,
    effectiveRegion,
  };
}
export function parseEditableState(value: unknown) {
  checkData(value);
  const r = record(value, [
    "documentType",
    "schemaVersion",
    "groups",
    "tombstones",
    "lockedInstanceIds",
    "overrides",
    "brushes",
    "affectedRegions",
    "deduplications",
  ]);
  const groups = list(r.groups, (v) => {
    const g = record(v, ["groupId", "nextSlot", "retired"]);
    return {
      groupId: id(g.groupId),
      nextSlot: integer(g.nextSlot, 0, MAX_SAFE),
      retired: bool(g.retired),
    };
  });
  unique(groups.map((g) => g.groupId));
  if (groups.filter((g) => !g.retired).length > 8)
    throw Error("Active group limit");
  const tombstones = instanceIds(r.tombstones),
    lockedInstanceIds = instanceIds(r.lockedInstanceIds, 20);
  const allocated = (s: string) => {
    const g = groups.find((g) =>
      s.startsWith(encodeURIComponent(g.groupId) + ":"),
    );
    if (!g || slotOf(s, g.groupId) >= g.nextSlot)
      throw Error("Unallocated instance ID");
    return g;
  };
  tombstones.forEach(allocated);
  for (const s of lockedInstanceIds)
    if (allocated(s).retired || tombstones.includes(s))
      throw Error("Lock on removed instance");
  const overrides = list(r.overrides, (v) => {
    const o = record(v, [
        "instanceId",
        "groupId",
        "kind",
        "assetRef",
        "transform",
      ]),
      instanceId = parseInstanceId(o.instanceId),
      groupId = id(o.groupId),
      kind = oneOf(o.kind, ["add", "remove", "replace", "move"] as const),
      g = allocated(instanceId);
    if (g.groupId !== groupId) throw Error("Override group mismatch");
    const assetRef = o.assetRef === null ? null : ref(o.assetRef),
      t = o.transform === null ? null : transform(o.transform);
    if (
      kind === "remove"
        ? !tombstones.includes(instanceId) || assetRef !== null || t !== null
        : tombstones.includes(instanceId) ||
          g.retired ||
          assetRef === null ||
          t === null
    )
      throw Error("Incomplete cumulative override");
    return { instanceId, groupId, kind, assetRef, transform: t };
  });
  unique(overrides.map((o) => o.instanceId));
  const brushes = list(r.brushes, brush);
  if (brushes.some((b, i) => i > 0 && b.sequence <= brushes[i - 1].sequence))
    throw Error("Brush sequence must increase");
  const affectedRegions = list(r.affectedRegions, (v) => {
    const a = record(v, [
        "requestedRegion",
        "effectiveRegion",
        "tileIds",
        "instanceIds",
      ]),
      requestedRegion = polygon(a.requestedRegion),
      effectiveRegion = polygon(a.effectiveRegion),
      affectedIds = instanceIds(a.instanceIds);
    if (!containsPolygon(effectiveRegion, requestedRegion))
      throw Error("Effective region must contain request");
    affectedIds.forEach(allocated);
    return {
      requestedRegion,
      effectiveRegion,
      tileIds: ids(a.tileIds),
      instanceIds: affectedIds,
    };
  });
  const deduplications = list(r.deduplications, (v) => {
    const a = record(v, [
      "sceneId",
      "baseRevisionId",
      "patchId",
      "operationId",
      "resultRevisionId",
    ]);
    return {
      sceneId: id(a.sceneId),
      baseRevisionId: id(a.baseRevisionId),
      patchId: id(a.patchId),
      operationId: id(a.operationId),
      resultRevisionId: id(a.resultRevisionId),
    };
  });
  unique(
    deduplications.map((a) =>
      JSON.stringify([a.sceneId, a.baseRevisionId, a.patchId]),
    ),
  );
  return freeze({
    documentType: oneOf(r.documentType, [
      "general-scene-editable-state",
    ] as const),
    schemaVersion: oneOf(r.schemaVersion, [1] as const),
    groups,
    tombstones,
    lockedInstanceIds,
    overrides,
    brushes,
    affectedRegions,
    deduplications,
  });
}
export type EditableState = ReturnType<typeof parseEditableState>;

function patchOperation(v: unknown) {
  const kind = (v as { kind?: unknown })?.kind;
  if (kind === "add") {
    const r = record(v, ["kind", "groupId", "assetRef", "count"]);
    return {
      kind: "add" as const,
      groupId: id(r.groupId),
      assetRef: ref(r.assetRef),
      count: integer(r.count, 1, 20),
    };
  }
  if (kind === "remove") {
    const r = record(v, ["kind", "instanceId"]);
    return {
      kind: "remove" as const,
      instanceId: parseInstanceId(r.instanceId),
    };
  }
  if (kind === "replace") {
    const r = record(v, ["kind", "instanceId", "assetRef"]);
    return {
      kind: "replace" as const,
      instanceId: parseInstanceId(r.instanceId),
      assetRef: ref(r.assetRef),
    };
  }
  if (kind === "move") {
    const r = record(v, ["kind", "instanceId", "transform"]);
    return {
      kind: "move" as const,
      instanceId: parseInstanceId(r.instanceId),
      transform: transform(r.transform),
    };
  }
  if (kind === "set-count") {
    const r = record(v, ["kind", "groupId", "count"]);
    return {
      kind: "set-count" as const,
      groupId: id(r.groupId),
      count: integer(r.count, 0, 20),
    };
  }
  const r = record(v, ["kind", "center", "radius", "delta"]);
  return {
    kind: oneOf(r.kind, ["brush"] as const),
    center: vec2(r.center),
    radius: finite(r.radius, 0.2, 1),
    delta: finite(r.delta, -0.2, 0.2),
  };
}
export function parsePatch(value: unknown) {
  checkData(value);
  const r = record(value, [
      "documentType",
      "schemaVersion",
      "patchId",
      "baseRevisionId",
      "raw",
      "requestedRegion",
      "effectiveRegion",
      "targetInstanceIds",
      "lockedInstanceIds",
      "affectedInstanceIds",
      "affectedTileIds",
      "operations",
      "review",
    ]),
    requestedRegion = polygon(r.requestedRegion),
    effectiveRegion = polygon(r.effectiveRegion),
    operations = list(r.operations, patchOperation, 32, 1),
    targetInstanceIds = instanceIds(r.targetInstanceIds, 20),
    lockedInstanceIds = instanceIds(r.lockedInstanceIds, 20),
    affectedInstanceIds = instanceIds(r.affectedInstanceIds, 40);
  if (!containsPolygon(effectiveRegion, requestedRegion))
    throw Error("Patch effect excludes request");
  if (
    !operations.some((o) => o.kind === "brush") &&
    JSON.stringify(requestedRegion) !== JSON.stringify(effectiveRegion)
  )
    throw Error("Object-only H must equal R");
  for (const o of operations) {
    if (
      "instanceId" in o &&
      o.instanceId !== undefined &&
      (!targetInstanceIds.includes(o.instanceId) ||
        !affectedInstanceIds.includes(o.instanceId) ||
        lockedInstanceIds.includes(o.instanceId))
    )
      throw Error("Patch target/lock mismatch");
    if (
      o.kind === "brush" &&
      !containsCircle(requestedRegion, o.center, o.radius)
    )
      throw Error("Brush outside request");
  }
  if (affectedInstanceIds.some((i) => lockedInstanceIds.includes(i)))
    throw Error("Locked instance in changed set");
  const rv = record(r.review, [
      "scopeAccepted",
      "planDigest",
      "catalogDigest",
      "assetBindings",
    ]),
    assetBindings = list(
      rv.assetBindings,
      (v) => {
        if (!Array.isArray(v) || v.length !== 3)
          throw Error("Invalid asset binding tuple");
        return [id(v[0]), id(v[1]), digest(v[2])] as const;
      },
      128,
    );
  unique(assetBindings.map((a) => JSON.stringify(a.slice(0, 2))));
  return freeze({
    documentType: oneOf(r.documentType, ["general-scene-patch"] as const),
    schemaVersion: oneOf(r.schemaVersion, [1] as const),
    patchId: id(r.patchId),
    baseRevisionId: id(r.baseRevisionId),
    raw: text(r.raw, L.maxPromptCharacters),
    requestedRegion,
    effectiveRegion,
    targetInstanceIds,
    lockedInstanceIds,
    affectedInstanceIds,
    affectedTileIds: ids(r.affectedTileIds),
    operations,
    review: {
      scopeAccepted: bool(rv.scopeAccepted),
      planDigest: digest(rv.planDigest),
      catalogDigest: digest(rv.catalogDigest),
      assetBindings,
    },
  });
}
export type ScenePatch = ReturnType<typeof parsePatch>;

/** All float buffers are f32; indices are u32; masks are u8. Digest bytes use little endian.
 * Grid i = iz*nx+ix starts at (-width/2,-depth/2); packed normals use 3*i+[x,y,z].
 * Node indices may share tile boundaries; outputIndices have exactly one owner.
 */
function f32(
  v: unknown,
  length: number,
  min = -Infinity,
  max = Infinity,
): Float32Array {
  const data = inspectCpuBuffer(v).value;
  if (!(data instanceof Float32Array) || data.length !== length)
    throw Error("Float32 buffer length mismatch");
  for (const n of data) finite(n, min, max);
  return data;
}
function indices(v: unknown, max: number): Uint32Array {
  const data = inspectCpuBuffer(v).value;
  if (!(data instanceof Uint32Array) || data.length < 1 || data.length > max)
    throw Error("Invalid index buffer");
  const set = new Set<number>();
  for (const n of data) {
    integer(n, 0, max - 1);
    if (set.has(n)) throw Error("Duplicate output/node index");
    set.add(n);
  }
  return data;
}
function ownership(sets: readonly Uint32Array[], count: number): void {
  const owned = new Uint8Array(count);
  let total = 0;
  for (const set of sets)
    for (const i of set) {
      if (i >= count || owned[i])
        throw Error("Duplicate/out-of-range ownership");
      owned[i] = 1;
      total++;
    }
  if (total !== count) throw Error("Missing output ownership");
}
function parseHeightModel(
  v: unknown,
  n: number,
  space: string,
  domain: { width: number; depth: number },
): HeightModel {
  if (v === undefined) return { kind: "bilinear" };
  if ((v as { kind?: unknown })?.kind === "bilinear") {
    record(v, ["kind"]);
    return { kind: "bilinear" };
  }
  const r = record(v, ["kind", "version", "baseHeights", "water"]);
  oneOf(r.kind, ["water-profile"]);
  oneOf(r.version, [1]);
  if (space !== "world")
    throw Error("Analytic profiles cannot deform canonical patches");
  const water = parseWater(r.water, domain);
  if (
    (water.mode !== "river" && water.mode !== "surface") ||
    water.level === null ||
    water.reshapePolicy === "preserve"
  )
    throw Error("Analytic profile requires resolved reshaping water");
  return {
    kind: "water-profile",
    version: 1,
    baseHeights: f32(r.baseHeights, n, -2, 2),
    water: water as ProfileWater,
  };
}
function parseGrid(v: unknown) {
  const r = record(v, [
      "space",
      "transform",
      "width",
      "depth",
      "spacing",
      "nx",
      "nz",
      "layout",
      "heights",
      "normals",
      "proxyError",
      "digest",
      "tiles",
      ...(Object.hasOwn(v as object, "heightModel") ? ["heightModel"] : []),
    ]),
    space = oneOf(r.space, ["world", "canonical"] as const),
    t = r.transform === null ? null : transform(r.transform),
    width = finite(r.width, 4, 10),
    depth = finite(r.depth, 4, 10),
    spacing = oneOf(r.spacing, [0.1, 0.2] as const),
    nx = integer(r.nx, 2, 101),
    nz = integer(r.nz, 2, 101),
    n = nx * nz;
  if (
    (space === "world") !== (t === null) ||
    n > L.maxHeightNodes ||
    Math.abs((nx - 1) * spacing - width) > 1e-9 ||
    Math.abs((nz - 1) * spacing - depth) > 1e-9
  )
    throw Error("Grid dimensions/space/transform mismatch");
  const heights = f32(
      r.heights,
      n,
      space === "world" ? -2 : -Infinity,
      space === "world" ? 2 : Infinity,
    ),
    normals = f32(r.normals, 3 * n, -1, 1);
  if (t) {
    const [qx, qy, qz, qw] = t.quaternion;
    for (let i = 0; i < n; i++) {
      const x = -width / 2 + (i % nx) * spacing;
      const z = -depth / 2 + Math.floor(i / nx) * spacing;
      // D acts on canonical proxy coordinates once. Source normalization is already baked into this grid.
      const y =
        t.position[1] +
        t.scale *
          ((2 * qx * qy + 2 * qz * qw) * x +
            (1 - 2 * qx * qx - 2 * qz * qz) * heights[i] +
            (2 * qy * qz - 2 * qx * qw) * z);
      finite(y, L.minElevation, L.maxElevation);
    }
  }
  for (let i = 0; i < n; i++)
    if (
      Math.abs(
        Math.hypot(normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]) - 1,
      ) > 1e-4
    )
      throw Error("Non-unit packed normal");
  const tiles = list(
    r.tiles,
    (v) => {
      const a = record(v, [
          "id",
          "bounds",
          "nodeIndices",
          "outputIndices",
          "digest",
        ]),
        b = bounds(a.bounds),
        nodeIndices = indices(a.nodeIndices, n),
        outputIndices = indices(a.outputIndices, n),
        nodes = new Set(nodeIndices);
      inDomain([b.min, b.max], { width, depth });
      for (const i of nodeIndices) {
        const x = -width / 2 + (i % nx) * spacing,
          z = -depth / 2 + Math.floor(i / nx) * spacing;
        if (
          x < b.min[0] - 1e-6 ||
          x > b.max[0] + 1e-6 ||
          z < b.min[1] - 1e-6 ||
          z > b.max[1] + 1e-6
        )
          throw Error("Tile node outside bounds");
      }
      for (const i of outputIndices)
        if (!nodes.has(i))
          throw Error("Tile output must reference its own nodes");
      return {
        id: id(a.id),
        bounds: b,
        nodeIndices,
        outputIndices,
        digest: digest(a.digest),
      };
    },
    10201,
    1,
  );
  unique(tiles.map((t) => t.id));
  ownership(
    tiles.map((t) => t.outputIndices),
    n,
  );
  return {
    space,
    transform: t,
    width,
    depth,
    spacing,
    nx,
    nz,
    layout: oneOf(r.layout, ["row-major-zx"] as const),
    heights,
    normals,
    proxyError: finite(r.proxyError, 0),
    heightModel: parseHeightModel(r.heightModel, n, space, { width, depth }),
    digest: digest(r.digest),
    tiles,
  };
}
export type HeightGridResult = ReturnType<typeof parseGrid>;
function parseWaterResult(v: unknown, grid: HeightGridResult | null) {
  if ((v as { mode?: unknown })?.mode === "none") {
    record(v, ["mode"]);
    return { mode: "none" as const };
  }
  const r = record(v, [
      "mode",
      "waterId",
      "level",
      "nx",
      "nz",
      "mask",
      "bankMask",
      "signedDistance",
      "digest",
    ]),
    nx = integer(r.nx, 2, 101),
    nz = integer(r.nz, 2, 101);
  if (!grid || grid.nx !== nx || grid.nz !== nz)
    throw Error("Water grid mismatch");
  const mask = (v: unknown) => {
    const data = inspectCpuBuffer(v).value;
    if (
      !(data instanceof Uint8Array) ||
      data.length !== nx * nz ||
      data.some((x) => x > 1)
    )
      throw Error("Invalid binary water mask");
    return data;
  };
  return {
    mode: oneOf(r.mode, ["river", "surface"] as const),
    waterId: id(r.waterId),
    level: finite(r.level, -2, 2),
    nx,
    nz,
    mask: mask(r.mask),
    bankMask: mask(r.bankMask),
    signedDistance: f32(r.signedDistance, nx * nz),
    digest: digest(r.digest),
  };
}
export type WaterResult = ReturnType<typeof parseWaterResult>;
function parseSurface(v: unknown, grid: HeightGridResult | null) {
  const r = record(v, [
      "role",
      "waterId",
      "format",
      "count",
      "data",
      "digest",
      "tiles",
    ]),
    role = oneOf(r.role, ["terrain", "water"] as const),
    waterId = nullableId(r.waterId),
    count = integer(r.count, 1, L.maxWorstSplats),
    data = f32(r.data, count * 14);
  if ((role === "terrain") !== (waterId === null))
    throw Error("Surface role/water identity mismatch");
  for (let i = 0; i < data.length; i += 14) {
    for (let k = 3; k < 6; k++) finite(data[i + k], Number.MIN_VALUE);
    if (
      Math.abs(
        Math.hypot(data[i + 6], data[i + 7], data[i + 8], data[i + 9]) - 1,
      ) > 1e-4
    )
      throw Error("Gaussian quaternion");
    for (let k = 10; k < 14; k++) finite(data[i + k], 0, 1);
    finite(data[i + 1], -2, 2);
  }
  const tiles = list(
    r.tiles,
    (v) => {
      const a = record(v, ["tileId", "outputIndices", "digest"]),
        tileId = id(a.tileId);
      if (!grid?.tiles.some((t) => t.id === tileId))
        throw Error("Unknown surface tile");
      return {
        tileId,
        outputIndices: indices(a.outputIndices, count),
        digest: digest(a.digest),
      };
    },
    10201,
    1,
  );
  unique(tiles.map((t) => t.tileId));
  ownership(
    tiles.map((t) => t.outputIndices),
    count,
  );
  return {
    role,
    waterId,
    format: oneOf(r.format, ["float14"] as const),
    count,
    data,
    digest: digest(r.digest),
    tiles,
  };
}
export type SurfaceResult = ReturnType<typeof parseSurface>;
function parseInstance(v: unknown): SceneInstance {
  const r = record(v, [
      "instanceId",
      "groupId",
      "assetRef",
      "transform",
      "locked",
    ]),
    groupId = id(r.groupId),
    instanceId = parseInstanceId(r.instanceId);
  slotOf(instanceId, groupId);
  return {
    instanceId,
    groupId,
    assetRef: ref(r.assetRef),
    transform: transform(r.transform),
    locked: bool(r.locked),
  };
}
function qualityCheck(v: unknown): QualityCheck {
  const r = record(v, ["status", "evidenceRefs", "issues"]),
    status = oneOf(r.status, [
      "pass",
      "fail",
      "pending",
      "not-applicable",
    ] as const),
    evidenceRefs = ids(r.evidenceRefs, 128),
    issues = list(r.issues, issue, 128);
  if (
    (status === "pass" && (!evidenceRefs.length || issues.length)) ||
    (status === "fail" && !issues.length)
  )
    throw Error("Quality check lacks truthful evidence/issues");
  return { status, evidenceRefs, issues };
}
function parseQuality(v: unknown): QualityReport {
  const r = record(v, [
      "geometryDigest",
      "semanticMode",
      "semantic",
      "assets",
      "geometry",
      "visual",
      "performance",
    ]),
    semantic = qualityCheck(r.semantic),
    semanticMode = oneOf(r.semanticMode, [
      "model-verified",
      "manual-corrected",
      "unverified",
    ] as const);
  if (semantic.status === "pass" && semanticMode === "unverified")
    throw Error("Unverified semantics cannot pass");
  return {
    geometryDigest: digest(r.geometryDigest),
    semanticMode,
    semantic,
    assets: qualityCheck(r.assets),
    geometry: qualityCheck(r.geometry),
    visual: qualityCheck(r.visual),
    performance: qualityCheck(r.performance),
  };
}
/** actualSourceBytes sums the byteLength of distinct immutable decoded Gaussian source arrays
 * actually used by the candidate, including generated terrain/water. Shared sources count once.
 * It excludes archive/metadata/license bytes, proxy grids, CPU copies and upload/GPU storage.
 * T9 supplies measured array lengths (as in render/source-bank.sourceBytes), not manifest estimates.
 * The ceiling is 128 MiB; candidate/transition residency accounting remains separate in usage.
 */
function validation(v: unknown) {
  const r = record(v, [
      "requested",
      "accepted",
      "shortfall",
      "rejections",
      "usage",
      "actualSourceBytes",
      "buildMs",
    ]),
    requested = integer(r.requested, 0, 20),
    accepted = integer(r.accepted, 0, 20),
    shortfall = integer(r.shortfall, 0, 20);
  if (requested - accepted !== shortfall) throw Error("Count report mismatch");
  const u = record(r.usage, [
      "instances",
      "worstSplats",
      "candidateCpuBytes",
      "transitionBytes",
    ]),
    usage = {
      instances: integer(u.instances, 0, 20),
      worstSplats: integer(u.worstSplats, 0, L.maxWorstSplats),
      candidateCpuBytes: integer(
        u.candidateCpuBytes,
        0,
        L.maxCandidateCpuBytes,
      ),
      transitionBytes: integer(u.transitionBytes, 0, L.maxTransitionBytes),
    };
  assertBudget(usage, L);
  if (
    usage.instances !== accepted ||
    usage.transitionBytes < usage.candidateCpuBytes
  )
    throw Error("Usage report mismatch");
  return {
    requested,
    accepted,
    shortfall,
    rejections: list(r.rejections, (v) => {
      const a = record(v, ["groupId", "instanceId", "reason"]);
      return {
        groupId: id(a.groupId),
        instanceId:
          a.instanceId === null ? null : parseInstanceId(a.instanceId),
        reason: issue(a.reason),
      };
    }),
    usage,
    actualSourceBytes: integer(
      r.actualSourceBytes,
      0,
      L.maxExpandedPackageBytes,
    ),
    buildMs: finite(r.buildMs, 0),
  };
}
const SNAPSHOT_KEYS = [
  "documentType",
  "schemaVersion",
  "capability",
  "sceneId",
  "revisionId",
  "parentRevisionId",
  "operationId",
  "intent",
  "plan",
  "state",
  "modelEvidence",
  "patch",
  "assets",
  "surfaceStyle",
  "terrain",
  "water",
  "surfaces",
  "instances",
  "geometryDigest",
  "camera",
  "reviewStatus",
  "quality",
  "validation",
];
/** Structural/runtime validation only: downstream verifies actual digests and acceptance evidence.
 * Buffers must be complete, exclusively backed views. Fresh native wrappers borrow the same bytes;
 * input view properties are discarded without access or binary copying. Owners must not mutate borrowed bytes.
 * T10 must rehydrate blobs first; metadata-only archives are not runtime SceneSnapshots.
 */
export function parseSnapshot(value: unknown) {
  const ownedBytes = checkData(value, true);
  const legacy =
      (value as { capability?: unknown }).capability === "legacy-readonly",
    r = record(value, [
      ...SNAPSHOT_KEYS,
      ...(legacy ? ["originVersion", "original"] : []),
    ]);
  const terrain = r.terrain === null ? null : parseGrid(r.terrain),
    water = r.water === null ? null : parseWaterResult(r.water, terrain),
    surfaces = list(r.surfaces, (v) => parseSurface(v, terrain), 2),
    instances = list(r.instances, parseInstance, 20);
  unique(instances.map((i) => i.instanceId));
  unique(surfaces.map((s) => s.role));
  const assets = list(
    r.assets,
    (v) => {
      const a = record(v, ["assetRef", "digest", "manifest"]),
        assetRef = ref(a.assetRef),
        manifest = parseAssetManifest(a.manifest);
      if (refKey(assetRef) !== refKey(manifest))
        throw Error("Manifest reference mismatch");
      return { assetRef, digest: digest(a.digest), manifest };
    },
    128,
  );
  unique(assets.map((a) => refKey(a.assetRef)));
  let surfaceStyle: {
    assetRef: AssetRef;
    digest: string;
    descriptor: SurfaceStyle;
  } | null = null;
  if (r.surfaceStyle !== null) {
    const a = record(r.surfaceStyle, ["assetRef", "digest", "descriptor"]),
      assetRef = ref(a.assetRef),
      descriptor = parseSurfaceStyle(a.descriptor);
    if (refKey(assetRef) !== refKey(descriptor))
      throw Error("Style reference mismatch");
    surfaceStyle = { assetRef, digest: digest(a.digest), descriptor };
  }
  const manifestFor = (ref: AssetRef): AssetManifestV2 => {
    const m = assets.find((a) => refKey(a.assetRef) === refKey(ref))?.manifest;
    if (!m) throw Error("Missing asset descriptor");
    return m;
  };
  let worstSplats = surfaces.reduce((n, s) => n + s.count, 0);
  for (const i of instances) {
    const m = manifestFor(i.assetRef);
    if (m.kind !== "object") throw Error("Instance must be object");
    worstSplats += Math.max(
      m.gaussian.full.points,
      m.gaussian.coarse?.points ?? 0,
    );
  }
  const geometryDigest = digest(r.geometryDigest),
    quality = parseQuality(r.quality),
    reviewStatus = oneOf(r.reviewStatus, ["draft", "accepted"] as const),
    report = validation(r.validation),
    parentRevisionId = nullableId(r.parentRevisionId),
    revisionId = id(r.revisionId);
  if (
    revisionId === parentRevisionId ||
    quality.geometryDigest !== geometryDigest ||
    report.accepted !== instances.length
  )
    throw Error("Snapshot identity/report mismatch");
  if (
    reviewStatus === "accepted" &&
    [
      quality.semantic,
      quality.assets,
      quality.geometry,
      quality.visual,
      quality.performance,
    ].some((c) => c.status !== "pass")
  )
    throw Error("Accepted snapshot requires all five checks");
  if (report.usage.candidateCpuBytes < ownedBytes)
    throw Error("Underreported result buffer byte budget");
  if (
    reviewStatus === "accepted" &&
    (assets.some((a) => a.manifest.quality.status !== "accepted") ||
      (surfaceStyle && surfaceStyle.descriptor.quality.status !== "accepted"))
  )
    throw Error("Accepted scene requires accepted asset/style descriptors");
  const base = {
    documentType: oneOf(r.documentType, ["general-scene-snapshot"] as const),
    schemaVersion: oneOf(r.schemaVersion, [1] as const),
    sceneId: id(r.sceneId),
    revisionId,
    parentRevisionId,
    operationId: id(r.operationId),
    modelEvidence: list(r.modelEvidence, parseModelEvidence, 3),
    patch: r.patch === null ? null : parsePatch(r.patch),
    assets,
    surfaceStyle,
    terrain,
    water,
    surfaces,
    instances,
    geometryDigest,
    camera: camera(r.camera),
    reviewStatus,
    quality,
    validation: report,
  };
  if (legacy) {
    if (terrain?.heightModel.kind === "water-profile")
      throw Error(
        "Legacy readonly snapshots cannot carry an unbound analytic profile",
      );
    if (r.intent !== null || r.plan !== null || r.state !== null)
      throw Error("Legacy intent/plan/state cannot be invented");
    const o = record(r.original, ["digest", "bytes"]),
      bytes = inspectCpuBuffer(o.bytes).value;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > L.maxCompressedPackageBytes
    )
      throw Error("Missing original legacy package");
    if (report.usage.worstSplats < worstSplats)
      throw Error("Underreported legacy point budget");
    return freeze({
      ...base,
      capability: "legacy-readonly" as const,
      intent: null,
      plan: null,
      state: null,
      originVersion: id(r.originVersion),
      original: { digest: digest(o.digest), bytes },
    });
  }
  oneOf(r.capability, ["editable"]);
  const intent = parseIntent(r.intent),
    plan = parseScenePlan(r.plan),
    state = parseEditableState(r.state);
  if (!terrain || !water)
    throw Error("Editable snapshot requires terrain and water results");
  if (
    terrain.heightModel.kind === "water-profile" &&
    (plan.terrain.source !== "procedural" ||
      JSON.stringify(terrain.heightModel.water) !== JSON.stringify(plan.water))
  )
    throw Error("Analytic profile water/plan binding mismatch");
  if (plan.terrain.source === "procedural") {
    if (
      terrain.space !== "world" ||
      terrain.width !== plan.domain.width ||
      terrain.depth !== plan.domain.depth ||
      terrain.spacing !== plan.terrain.spacing ||
      !surfaces.some((s) => s.role === "terrain")
    )
      throw Error("Procedural result mismatch");
  } else {
    const m = manifestFor(plan.terrain.assetRef);
    if (
      m.kind !== "patch" ||
      JSON.stringify(plan.terrain.transform) !==
        JSON.stringify(m.patch.displayTransform) ||
      terrain.space !== "canonical" ||
      JSON.stringify(terrain.transform) !==
        JSON.stringify(plan.terrain.transform) ||
      terrain.width !== 4 ||
      terrain.depth !== 4 ||
      terrain.spacing !== 0.1 ||
      terrain.proxyError !== m.patch.heightProxy.maxError
    )
      throw Error("Patch fixed transform/proxy mismatch");
    if (surfaces.some((s) => s.role === "terrain") || state.brushes.length)
      throw Error("Rigid patch cannot have generated terrain or brushes");
    worstSplats += Math.max(
      m.gaussian.full.points,
      m.gaussian.coarse?.points ?? 0,
    );
  }
  if (
    (plan.surfaceStyleRef === null) !== (surfaceStyle === null) ||
    (surfaceStyle &&
      plan.surfaceStyleRef &&
      refKey(surfaceStyle.assetRef) !== refKey(plan.surfaceStyleRef))
  )
    throw Error("Missing/mismatched surface style");
  if (
    water.mode !== plan.water.mode ||
    (water.mode !== "none" &&
      "waterId" in plan.water &&
      (water.waterId !== plan.water.waterId ||
        water.level !== plan.water.level))
  )
    throw Error("Water plan/result mismatch");
  const waterSurface = surfaces.find((s) => s.role === "water");
  if (
    water.mode === "none"
      ? !!waterSurface
      : !waterSurface || waterSurface.waterId !== water.waterId
  )
    throw Error("Water sampling result mismatch");
  if (
    report.usage.worstSplats !== worstSplats ||
    worstSplats > L.maxWorstSplats
  )
    throw Error("Incorrect per-instance worst LOD budget");
  for (const g of plan.groups) {
    if (!state.groups.some((s) => s.groupId === g.groupId && !s.retired))
      throw Error("Missing persistent group allocator");
    if (manifestFor(g.assetRef).kind !== "object")
      throw Error("Plan group asset must be object");
    if (instances.filter((i) => i.groupId === g.groupId).length > g.count)
      throw Error("Instance group count exceeds plan");
  }
  if (report.requested !== plan.groups.reduce((n, g) => n + g.count, 0))
    throw Error("Requested count differs from plan");
  for (const i of instances) {
    const pg = plan.groups.find((g) => g.groupId === i.groupId),
      override = state.overrides.find((o) => o.instanceId === i.instanceId);
    if (!pg || refKey(i.assetRef) !== refKey(override?.assetRef ?? pg.assetRef))
      throw Error("Instance plan binding mismatch");
    const g = state.groups.find((g) => g.groupId === i.groupId);
    if (
      !g ||
      g.retired ||
      slotOf(i.instanceId, i.groupId) >= g.nextSlot ||
      state.tombstones.includes(i.instanceId) ||
      i.locked !== state.lockedInstanceIds.includes(i.instanceId)
    )
      throw Error("Instance allocator/tombstone/lock mismatch");
  }
  for (const id of state.lockedInstanceIds)
    if (!instances.some((i) => i.instanceId === id))
      throw Error("Dangling lock");
  for (const o of state.overrides) {
    const i = instances.find((i) => i.instanceId === o.instanceId);
    if (
      o.kind === "remove"
        ? !!i
        : !i ||
          JSON.stringify(i.assetRef) !== JSON.stringify(o.assetRef) ||
          JSON.stringify(i.transform) !== JSON.stringify(o.transform)
    )
      throw Error("Snapshot loses cumulative object override");
  }
  if (base.patch && base.patch.baseRevisionId !== parentRevisionId)
    throw Error("Patch parent mismatch");
  return freeze({
    ...base,
    capability: "editable" as const,
    intent,
    plan,
    state,
    terrain,
    water,
  });
}
export type SceneSnapshot = ReturnType<typeof parseSnapshot>;
export type EditableSnapshot = Extract<
  SceneSnapshot,
  { capability: "editable" }
>;
export type LegacySnapshot = Extract<
  SceneSnapshot,
  { capability: "legacy-readonly" }
>;

/** Transient load access never overwrites a snapshot's persisted capability. */
export type SnapshotLoadResult = {
  snapshot: SceneSnapshot;
  access: "editable" | "readonly";
  issues: readonly Issue[];
};
export function parseCompileContext(value: unknown): CompileContext {
  const r = record(value, [
      "operationId",
      "baseRevisionId",
      "sceneId",
      "revisionId",
      "signal",
      "intent",
      "modelEvidence",
      "patch",
      "camera",
      "resources",
      "baseSnapshot",
    ]),
    resource = record(r.resources, ["retainedBytes"]);
  if (!(r.signal instanceof AbortSignal)) throw Error("Missing AbortSignal");
  const sceneId = id(r.sceneId),
    revisionId = id(r.revisionId),
    baseRevisionId = nullableId(r.baseRevisionId),
    patch = r.patch === null ? null : parsePatch(r.patch),
    base = r.baseSnapshot === null ? null : parseSnapshot(r.baseSnapshot);
  if (base && base.capability !== "editable")
    throw Error("Legacy snapshot cannot compile");
  if (
    revisionId === baseRevisionId ||
    (base &&
      (base.sceneId !== sceneId || base.revisionId !== baseRevisionId)) ||
    (patch && (!base || patch.baseRevisionId !== baseRevisionId))
  )
    throw Error("Compile base/patch identity mismatch");
  return {
    operationId: id(r.operationId),
    baseRevisionId,
    sceneId,
    revisionId,
    signal: r.signal,
    intent: parseIntent(r.intent),
    modelEvidence: list(r.modelEvidence, parseModelEvidence, 3),
    patch,
    camera: camera(r.camera),
    resources: { retainedBytes: integer(resource.retainedBytes, 0, MAX_SAFE) },
    baseSnapshot: base,
  };
}

/** T9 frozen instances use the same strict runtime contract as saved instances. */
export { parseInstance as parseSceneInstance };
