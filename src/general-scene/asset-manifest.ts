import { finite, integer, oneOf, record, vector } from "../data-validation.ts";
import type { AssetMetadata } from "../assets/catalog/metadata.ts";
import {
  GENERAL_LIMITS,
  type AssetRef,
  type CameraState,
  type Quat,
  type Transform,
  type Vec2,
  type Vec3,
} from "./core.ts";

export type AssetKind = "object" | "patch" | "environment";
export type Bounds3 = { readonly min: Vec3; readonly max: Vec3 };
export type AssetFile = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};
export type AssetOperation =
  "place" | "rotate" | "uniform-scale" | "remove" | "browse" | "place-on-patch";
export type AssetQuality = {
  readonly status: "candidate" | "accepted" | "legacy" | "rejected";
  readonly report: string;
  readonly limitations: readonly string[];
  readonly inspectionViews: readonly CameraState[];
  readonly operations: readonly AssetOperation[];
  readonly humanReview: {
    readonly reviewer: string;
    readonly reviewedAt: string;
    readonly asset: AssetRef;
    /** T2 verifies actual bytes and the immutable descriptor identity, excluding mutable review fields. */
    readonly files: readonly {
      readonly path: string;
      readonly sha256: string;
    }[];
    readonly operations: readonly AssetOperation[];
  } | null;
};
export type AssetProvenance = {
  readonly author: string;
  readonly source: string;
  readonly license: {
    readonly id: string;
    readonly summary: string;
    readonly evidence: string | null;
    readonly attribution: string;
    readonly redistributable: boolean;
    readonly redistributionBasis: string;
  };
  readonly changes: string;
  readonly derivedFrom: readonly {
    readonly asset: AssetRef;
    readonly source: string;
    readonly changes: string;
  }[];
};
/** Procedural surface metadata; actual sampling determines its splat count in T8. */
export type SurfaceStyle = {
  readonly id: string;
  readonly contentVersion: string;
  readonly parameters: Readonly<Record<string, number | readonly number[]>>;
  readonly quality: AssetQuality;
  readonly provenance: AssetProvenance;
};
export type LodMetadata = {
  readonly points: number;
  readonly sha256: string;
  readonly quality: {
    readonly status: "unreviewed" | "passed" | "failed";
    readonly report: string | null;
  };
};
type ManifestBase = {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly contentVersion: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly environments: readonly string[];
  readonly origin: "captured" | "procedural" | "generated";
  readonly files: readonly AssetFile[];
  readonly coordinates: {
    readonly handedness: "right";
    readonly upAxis: "+Y";
    readonly forwardAxis: "+Z" | null;
    /** Applied once to all source geometry and its support/proxy data. Bounds below are canonical. */
    readonly sourceToCanonical: Transform;
    readonly normalizationEvidence: string;
    readonly unit: "display-unit" | "metre" | "uncalibrated";
    readonly scaleEvidence: string | null;
    /** Full and usable dimensions are the respective max - min extents. */
    readonly fullBounds: Bounds3;
    readonly usableBounds: Bounds3;
  };
  readonly gaussian: {
    readonly shDegree: 0 | 1 | 2 | 3;
    readonly full: LodMetadata;
    readonly coarse: LodMetadata | null;
    readonly bakedLighting: boolean;
    readonly exposureFamily: string;
    readonly toneFamily: string;
    /** Null means no validated viewing distance; never infer visual acceptance for candidates. */
    readonly validatedDistance: readonly [number, number] | null;
    readonly validatedDirections: readonly Vec3[];
    readonly shRotation: "local-view" | "verified-sh-rotation" | "fixed";
  };
  readonly resources: {
    readonly decodedBytes: number;
    readonly cpuSourceBytes: number;
    readonly uploadBytes: number;
  };
  readonly provenance: AssetProvenance;
  readonly quality: AssetQuality;
};
export type ObjectManifest = ManifestBase & {
  readonly kind: "object";
  readonly loader: "gaussian-object-v2";
  readonly object: {
    /** Instance position is the world landing anchor: position + rotation * scale * (point - anchor). */
    readonly anchor: Vec3;
    /** True means data has already had its anchor subtracted; anchor must then be zero. */
    readonly anchorBaked: boolean;
    readonly supportPoints: readonly {
      readonly id: string;
      readonly role: "root" | "edge";
      readonly position: Vec3;
    }[];
    readonly footprint: readonly Vec2[];
    readonly collisionRadius: number;
    readonly maxSlopeDegrees: number;
    readonly maxTiltDegrees: number;
    readonly contactTolerance: { readonly min: number; readonly max: number };
    readonly allowedBurial: number;
    readonly scaleRange: readonly [number, number];
    readonly scaleRangeEvidence: string | null;
    readonly rotation: "upright-yaw" | "surface-normal" | "fixed";
    readonly verifiedYawDegrees: readonly number[];
  };
};
export type HeightProxy = {
  readonly contentVersion: string;
  readonly heightFile: string;
  readonly normalFile: string;
  /** Uniform absolute vertical error in canonical units, never unknown. */
  readonly maxError: number;
};
export type PatchManifest = ManifestBase & {
  readonly kind: "patch";
  readonly loader: "gaussian-patch-v2";
  readonly patch: {
    /** Placement is limited to this polygon minus voidMask/waterMask and edgeBuffer. */
    readonly usablePolygon: readonly Vec2[];
    readonly heightProxy: HeightProxy;
    readonly voidMask: readonly (readonly Vec2[])[];
    readonly waterMask: readonly (readonly Vec2[])[];
    readonly edgeBuffer: number;
    readonly displayTransform: Transform;
  };
};
export type EnvironmentManifest = ManifestBase & {
  readonly kind: "environment";
  readonly loader: "gaussian-environment-v2";
  readonly environment: {
    readonly displayTransform: Transform;
    readonly browseBounds: Bounds3;
    readonly heightProxy: HeightProxy | null;
    readonly camera: {
      readonly initial: CameraState;
      readonly near: number;
      readonly far: number;
      readonly distance: readonly [number, number];
    };
  };
};
export type AssetManifestV2 =
  ObjectManifest | PatchManifest | EnvironmentManifest;

const EPSILON = 1e-8;
const operationsByKind = {
  object: ["place", "rotate", "uniform-scale", "remove"],
  patch: ["browse", "place-on-patch"],
  environment: ["browse"],
} as const;
const loadersByKind = {
  object: "gaussian-object-v2",
  patch: "gaussian-patch-v2",
  environment: "gaussian-environment-v2",
} as const;
function at<T>(path: string, parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new Error(
      `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
function text(value: unknown, max = 1000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("Invalid text");
  return value;
}
function identifier(value: unknown): string {
  const result = text(value, 80);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result))
    throw Error("Invalid identifier");
  return result;
}
function sha256(value: unknown): string {
  const result = text(value, 64);
  if (!/^[0-9a-f]{64}$/.test(result)) throw Error("Invalid SHA-256");
  return result;
}
function relativePath(value: unknown): string {
  const result = text(value, 250);
  if (
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/.test(
      result,
    ) ||
    result.split("/").some((part) => part === "." || part === "..")
  )
    throw Error("Invalid relative file path");
  return result;
}
function filePath(value: unknown): string {
  const result = relativePath(value);
  if (
    !/\.(?:ply|splat|spz|bin|u32|f32|json|md|txt|png|jpg|jpeg|webp|pdf)$/i.test(
      result,
    )
  )
    throw Error("Unsupported or executable file extension");
  return result;
}
function source(value: unknown): string {
  const result = text(value, 500);
  if (!/^https?:\/\//.test(result)) return relativePath(result);
  const url = new URL(result);
  if (url.username || url.password)
    throw Error("Source URL must not contain credentials");
  return result;
}
function list<T>(
  value: unknown,
  parse: (item: unknown) => T,
  max: number,
  min = 0,
): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw Error("Invalid list length");
  return value.map((item, i) => at(`[${i}]`, () => parse(item)));
}
function unique<T>(items: T[]): T[] {
  if (new Set(items).size !== items.length)
    throw Error("Duplicate identifier or value");
  return items;
}
function vec3(value: unknown): Vec3 {
  return vector(value, 3) as [number, number, number];
}
function vec2(value: unknown): Vec2 {
  return vector(value, 2) as [number, number];
}
function range(
  value: unknown,
  min: number,
  max: number,
): readonly [number, number] {
  const result = vector(value, 2) as [number, number];
  result.forEach((n) => finite(n, min, max));
  if (result[0] > result[1]) throw Error("Reversed range");
  return result;
}
function bounds(value: unknown): Bounds3 {
  const r = record(value, ["min", "max"]),
    min = vec3(r.min),
    max = vec3(r.max);
  if (min.some((n, i) => n >= max[i])) throw Error("Empty or reversed bounds");
  max.forEach((n, i) => finite(n - min[i]));
  return { min, max };
}
function inside(point: Vec3, domain: Bounds3): boolean {
  return point.every(
    (n, i) => n >= domain.min[i] - EPSILON && n <= domain.max[i] + EPSILON,
  );
}
function transform(value: unknown): Transform {
  const r = record(value, ["position", "quaternion", "scale"]);
  const quaternion: Quat = vector(r.quaternion, 4) as [
    number,
    number,
    number,
    number,
  ];
  if (Math.abs(Math.hypot(...quaternion) - 1) > 1e-6)
    throw Error("Quaternion must be normalized");
  return {
    position: vec3(r.position),
    quaternion,
    scale: finite(r.scale, Number.MIN_VALUE, 1000),
  };
}
function cameraState(value: unknown): CameraState {
  const r = record(value, ["position", "target"]),
    position = vec3(r.position),
    target = vec3(r.target);
  if (position.every((n, i) => n === target[i]))
    throw Error("Camera must have a viewing direction");
  return { position, target };
}
function assetRef(value: unknown): AssetRef {
  const r = record(value, ["id", "contentVersion"]);
  return { id: identifier(r.id), contentVersion: identifier(r.contentVersion) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** Reject non-JSON objects before touching their properties or serializing them. */
function assertJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 32) throw Error("JSON nesting exceeds limit");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    finite(value);
    return;
  }
  if (typeof value !== "object") throw Error("Expected pure JSON data");
  if (seen.has(value)) throw Error("Cyclic JSON data");
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (array ? Array.prototype : Object.prototype) &&
    Object.getPrototypeOf(value) !== null
  )
    throw Error("Expected plain JSON data");
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (
      typeof key !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      throw Error("Unsafe JSON key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      throw Error("JSON accessors are not allowed");
    if (array && !/^(0|[1-9][0-9]*)$/.test(key))
      throw Error("Invalid array key");
    assertJson(descriptor.value, seen, depth + 1);
  }
  if (array && Object.keys(value).length !== value.length)
    throw Error("Sparse arrays are not JSON contract values");
  seen.delete(value);
}
function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return finite((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
}
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.abs(cross(a, b, p)) <= EPSILON &&
    p[0] >= Math.min(a[0], b[0]) - EPSILON &&
    p[0] <= Math.max(a[0], b[0]) + EPSILON &&
    p[1] >= Math.min(a[1], b[1]) - EPSILON &&
    p[1] <= Math.max(a[1], b[1]) + EPSILON
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
function polygon(value: unknown): Vec2[] {
  const points = list(value, vec2, 128, 3);
  unique(points.map((p) => p.join(",")));
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    area = finite(area + finite(a[0] * b[1] - a[1] * b[0]));
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (intersects(a, b, points[j], points[(j + 1) % points.length]))
        throw Error("Self-intersecting polygon");
    }
  }
  if (Math.abs(area) <= EPSILON) throw Error("Degenerate polygon");
  return points;
}
function hull(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (items: Vec2[]) => {
    const result: Vec2[] = [];
    for (const point of items) {
      while (
        result.length >= 2 &&
        cross(result.at(-2)!, result.at(-1)!, point) <= EPSILON
      )
        result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}
function polygonWithinBounds(points: readonly Vec2[], domain: Bounds3): void {
  if (points.some(([x, z]) => !inside([x, domain.min[1], z], domain)))
    throw Error("Polygon outside canonical bounds");
}
function parseFiles(value: unknown): AssetFile[] {
  const files = list(
    value,
    (item) => {
      const r = record(item, ["path", "bytes", "sha256"]);
      return {
        path: filePath(r.path),
        bytes: integer(r.bytes, 1, GENERAL_LIMITS.maxExpandedPackageBytes),
        sha256: sha256(r.sha256),
      };
    },
    GENERAL_LIMITS.maxPackageFiles,
    1,
  );
  unique(files.map((f) => f.path));
  if (
    files.reduce((sum, f) => sum + f.bytes, 0) >
    GENERAL_LIMITS.maxExpandedPackageBytes
  )
    throw Error("Expanded asset bytes exceed limit");
  return files;
}
function parseCoordinates(value: unknown): ManifestBase["coordinates"] {
  const r = record(value, [
    "handedness",
    "upAxis",
    "forwardAxis",
    "sourceToCanonical",
    "normalizationEvidence",
    "unit",
    "scaleEvidence",
    "fullBounds",
    "usableBounds",
  ]);
  const unit = oneOf(r.unit, [
    "display-unit",
    "metre",
    "uncalibrated",
  ] as const);
  const scaleEvidence =
    r.scaleEvidence === null ? null : filePath(r.scaleEvidence);
  if ((unit === "metre") !== (scaleEvidence !== null))
    throw Error(
      "Metre units require scale evidence; other units must not claim it",
    );
  const fullBounds = bounds(r.fullBounds),
    usableBounds = bounds(r.usableBounds);
  if (
    !inside(usableBounds.min, fullBounds) ||
    !inside(usableBounds.max, fullBounds)
  )
    throw Error("Usable bounds exceed full data bounds");
  return {
    handedness: oneOf(r.handedness, ["right"] as const),
    upAxis: oneOf(r.upAxis, ["+Y"] as const),
    forwardAxis: oneOf(r.forwardAxis, ["+Z", null] as const),
    sourceToCanonical: transform(r.sourceToCanonical),
    normalizationEvidence: filePath(r.normalizationEvidence),
    unit,
    scaleEvidence,
    fullBounds,
    usableBounds,
  };
}
function parseLod(value: unknown, max: number): LodMetadata {
  const r = record(value, ["points", "sha256", "quality"]),
    q = record(r.quality, ["status", "report"]);
  const status = oneOf(q.status, ["unreviewed", "passed", "failed"] as const),
    report = q.report === null ? null : filePath(q.report);
  if (status !== "unreviewed" && report === null)
    throw Error("LOD quality conclusion needs a report");
  return {
    points: integer(r.points, 1, max),
    sha256: sha256(r.sha256),
    quality: { status, report },
  };
}
function parseGaussian(value: unknown): ManifestBase["gaussian"] {
  const r = record(value, [
    "shDegree",
    "full",
    "coarse",
    "bakedLighting",
    "exposureFamily",
    "toneFamily",
    "validatedDistance",
    "validatedDirections",
    "shRotation",
  ]);
  const full = parseLod(r.full, GENERAL_LIMITS.maxWorstSplats);
  const validatedDirections = list(
    r.validatedDirections,
    (v) => {
      const direction = vec3(v);
      if (Math.abs(Math.hypot(...direction) - 1) > 1e-6)
        throw Error("Viewing direction must be normalized");
      return direction;
    },
    32,
    0,
  );
  unique(validatedDirections.map((p) => p.join(",")));
  return {
    shDegree: oneOf(r.shDegree, [0, 1, 2, 3] as const),
    full,
    coarse: r.coarse === null ? null : parseLod(r.coarse, full.points),
    bakedLighting: oneOf(r.bakedLighting, [true, false]),
    exposureFamily: identifier(r.exposureFamily),
    toneFamily: identifier(r.toneFamily),
    validatedDistance:
      r.validatedDistance === null
        ? null
        : range(r.validatedDistance, Number.MIN_VALUE, 10000),
    validatedDirections,
    shRotation: oneOf(r.shRotation, [
      "local-view",
      "verified-sh-rotation",
      "fixed",
    ] as const),
  };
}
function parseProvenance(value: unknown): AssetProvenance {
  const r = record(value, [
    "author",
    "source",
    "license",
    "changes",
    "derivedFrom",
  ]);
  const l = record(r.license, [
    "id",
    "summary",
    "evidence",
    "attribution",
    "redistributable",
    "redistributionBasis",
  ]);
  const license = {
    id: identifier(l.id),
    summary: text(l.summary, 4000),
    evidence: l.evidence === null ? null : source(l.evidence),
    attribution: text(l.attribution),
    redistributable: oneOf(l.redistributable, [true, false]),
    redistributionBasis: text(l.redistributionBasis, 2000),
  };
  if (license.id !== "unknown" && license.evidence === null)
    throw Error("Known license requires source evidence");
  if (
    ["unknown", "project-internal"].includes(license.id) &&
    license.redistributable
  )
    throw Error("License does not grant redistribution");
  const derivedFrom = list(
    r.derivedFrom,
    (item) => {
      const d = record(item, ["asset", "source", "changes"]);
      return {
        asset: assetRef(d.asset),
        source: source(d.source),
        changes: text(d.changes),
      };
    },
    32,
  );
  unique(derivedFrom.map((d) => `${d.asset.id}/${d.asset.contentVersion}`));
  return {
    author: text(r.author, 120),
    source: source(r.source),
    license,
    changes: text(r.changes, 4000),
    derivedFrom,
  };
}
function parseOperations(value: unknown, kind: AssetKind): AssetOperation[] {
  return unique(
    list(
      value,
      (v) => oneOf(v, operationsByKind[kind] as readonly AssetOperation[]),
      6,
    ),
  );
}
function parseQuality(
  value: unknown,
  kind: AssetKind,
  identity: AssetRef,
): AssetQuality {
  const r = record(value, [
    "status",
    "report",
    "limitations",
    "inspectionViews",
    "operations",
    "humanReview",
  ]);
  const status = oneOf(r.status, [
    "candidate",
    "accepted",
    "legacy",
    "rejected",
  ] as const);
  const operations = parseOperations(r.operations, kind);
  const inspectionViews = list(r.inspectionViews, cameraState, 32);
  let humanReview: AssetQuality["humanReview"] = null;
  if (r.humanReview !== null) {
    const h = record(r.humanReview, [
      "reviewer",
      "reviewedAt",
      "asset",
      "files",
      "operations",
    ]);
    const reviewedAt = text(h.reviewedAt, 30);
    const reviewedDate = new Date(reviewedAt);
    const canonicalReviewedAt =
      reviewedAt.length === 20 ? reviewedAt.replace("Z", ".000Z") : reviewedAt;
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(reviewedAt) ||
      !Number.isFinite(reviewedDate.getTime()) ||
      reviewedDate.toISOString() !== canonicalReviewedAt
    )
      throw Error("Invalid review timestamp");
    humanReview = {
      reviewer: text(h.reviewer, 120),
      reviewedAt,
      asset: assetRef(h.asset),
      files: list(
        h.files,
        (item) => {
          const file = record(item, ["path", "sha256"]);
          return { path: filePath(file.path), sha256: sha256(file.sha256) };
        },
        GENERAL_LIMITS.maxPackageFiles,
        1,
      ),
      operations: parseOperations(h.operations, kind),
    };
    if (
      humanReview.asset.id !== identity.id ||
      humanReview.asset.contentVersion !== identity.contentVersion
    )
      throw Error("Human review identity does not match asset");
    unique(humanReview.files.map((file) => file.path));
    if (operations.some((op) => !humanReview!.operations.includes(op)))
      throw Error("Operations exceed human review scope");
  }
  if (
    status === "accepted" &&
    (!humanReview || !inspectionViews.length || !operations.length)
  )
    throw Error(
      "Accepted assets require corresponding human review, views and operations",
    );
  return {
    status,
    report: filePath(r.report),
    limitations: list(r.limitations, (v) => text(v), 32),
    inspectionViews,
    operations,
    humanReview,
  };
}
function parseObject(
  value: unknown,
  base: ManifestBase,
): ObjectManifest["object"] {
  const r = record(value, [
    "anchor",
    "anchorBaked",
    "supportPoints",
    "footprint",
    "collisionRadius",
    "maxSlopeDegrees",
    "maxTiltDegrees",
    "contactTolerance",
    "allowedBurial",
    "scaleRange",
    "scaleRangeEvidence",
    "rotation",
    "verifiedYawDegrees",
  ]);
  const anchor = vec3(r.anchor),
    anchorBaked = oneOf(r.anchorBaked, [true, false]);
  if (!inside(anchor, base.coordinates.fullBounds))
    throw Error("Anchor outside full bounds");
  if (anchorBaked && anchor.some((n) => n !== 0))
    throw Error("Baked anchor must already be zero");
  const supportPoints = list(
    r.supportPoints,
    (item) => {
      const p = record(item, ["id", "role", "position"]);
      const position = vec3(p.position);
      if (!inside(position, base.coordinates.fullBounds))
        throw Error("Support outside full bounds");
      return {
        id: identifier(p.id),
        role: oneOf(p.role, ["root", "edge"] as const),
        position,
      };
    },
    128,
    3,
  );
  unique(supportPoints.map((p) => p.id));
  unique(supportPoints.map((p) => p.position.join(",")));
  if (
    !supportPoints.some((p) => p.role === "root") ||
    !supportPoints.some((p) => p.role === "edge")
  )
    throw Error("Support must include root and edge samples");
  const footprint = polygon(r.footprint);
  polygonWithinBounds(footprint, base.coordinates.fullBounds);
  const supportHull = hull(
    supportPoints.map((p) => [p.position[0], p.position[2]] as Vec2),
  );
  if (
    supportHull.length < 3 ||
    footprint.some((p) =>
      supportHull.some(
        (a, i) =>
          cross(a, supportHull[(i + 1) % supportHull.length], p) < -EPSILON,
      ),
    )
  )
    throw Error("Support samples must cover the footprint");
  const collisionRadius = finite(r.collisionRadius, Number.MIN_VALUE, 1000);
  if (
    footprint.some(
      ([x, z]) =>
        Math.hypot(x - anchor[0], z - anchor[2]) > collisionRadius + EPSILON,
    )
  )
    throw Error(
      "Collision radius must conservatively cover the footprint around anchor",
    );
  const tolerance = record(r.contactTolerance, ["min", "max"]);
  const contactTolerance = {
    min: finite(tolerance.min, GENERAL_LIMITS.minContactGap, 0),
    max: finite(tolerance.max, 0, GENERAL_LIMITS.maxContactGap),
  };
  const scaleRange = range(r.scaleRange, Number.MIN_VALUE, 1000),
    scaleRangeEvidence =
      r.scaleRangeEvidence === null ? null : filePath(r.scaleRangeEvidence);
  if ((scaleRange[0] !== 1 || scaleRange[1] !== 1) && !scaleRangeEvidence)
    throw Error("Enabling object scaling requires asset report evidence");
  const rotation = oneOf(r.rotation, [
    "upright-yaw",
    "surface-normal",
    "fixed",
  ] as const);
  if (
    base.gaussian.shDegree > 0 &&
    base.gaussian.shRotation === "fixed" &&
    (rotation !== "fixed" || base.quality.operations.includes("rotate"))
  )
    throw Error(
      "View-dependent SH colors require validated rotation handling or fixed orientation",
    );
  return {
    anchor,
    anchorBaked,
    supportPoints,
    footprint,
    collisionRadius,
    maxSlopeDegrees: finite(r.maxSlopeDegrees, 0, 90),
    maxTiltDegrees: finite(r.maxTiltDegrees, 0, 90),
    contactTolerance,
    allowedBurial: finite(r.allowedBurial, 0, -contactTolerance.min),
    scaleRange,
    scaleRangeEvidence,
    rotation,
    verifiedYawDegrees: unique(
      list(
        r.verifiedYawDegrees,
        (v) => {
          const angle = finite(v, 0, 360);
          if (angle === 360)
            throw Error("Heading must be less than 360 degrees");
          return angle;
        },
        32,
        base.quality.status === "accepted" ? 1 : 0,
      ),
    ),
  };
}
function parseProxy(value: unknown, files: readonly AssetFile[]): HeightProxy {
  const r = record(value, [
    "contentVersion",
    "heightFile",
    "normalFile",
    "maxError",
  ]);
  const heightFile = filePath(r.heightFile),
    normalFile = filePath(r.normalFile);
  if (
    heightFile === normalFile ||
    [heightFile, normalFile].some((p) => !files.some((f) => f.path === p))
  )
    throw Error("Proxy height/normal sources must be distinct declared files");
  return {
    contentVersion: identifier(r.contentVersion),
    heightFile,
    normalFile,
    maxError: finite(r.maxError, 0, 1000),
  };
}
function parsePatch(
  value: unknown,
  base: ManifestBase,
): PatchManifest["patch"] {
  const r = record(value, [
    "usablePolygon",
    "heightProxy",
    "voidMask",
    "waterMask",
    "edgeBuffer",
    "displayTransform",
  ]);
  const usablePolygon = polygon(r.usablePolygon);
  polygonWithinBounds(usablePolygon, base.coordinates.usableBounds);
  const mask = (value: unknown) =>
    list(
      value,
      (item) => {
        const p = polygon(item);
        polygonWithinBounds(p, base.coordinates.fullBounds);
        return p;
      },
      128,
    );
  return {
    usablePolygon,
    heightProxy: parseProxy(r.heightProxy, base.files),
    voidMask: mask(r.voidMask),
    waterMask: mask(r.waterMask),
    edgeBuffer: finite(r.edgeBuffer, 0, 1000),
    displayTransform: transform(r.displayTransform),
  };
}
function parseEnvironment(
  value: unknown,
  base: ManifestBase,
): EnvironmentManifest["environment"] {
  const r = record(value, [
      "displayTransform",
      "browseBounds",
      "heightProxy",
      "camera",
    ]),
    c = record(r.camera, ["initial", "near", "far", "distance"]);
  const near = finite(c.near, Number.MIN_VALUE, 10000),
    far = finite(c.far, Number.MIN_VALUE, 10000);
  if (near >= far) throw Error("Camera near plane must precede far plane");
  return {
    displayTransform: transform(r.displayTransform),
    browseBounds: bounds(r.browseBounds),
    heightProxy:
      r.heightProxy === null ? null : parseProxy(r.heightProxy, base.files),
    camera: {
      initial: cameraState(c.initial),
      near,
      far,
      distance: range(c.distance, Number.MIN_VALUE, 10000),
    },
  };
}

/** Structural validation only. Loading verifies actual bytes and reviewed identity independently in T2. */
export function parseAssetManifest(value: unknown): AssetManifestV2 {
  return at("manifest", () => {
    assertJson(value);
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      GENERAL_LIMITS.maxJsonBytes
    )
      throw Error("Manifest JSON exceeds byte limit");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Expected manifest object");
    const kind = oneOf((value as Record<string, unknown>).kind, [
      "object",
      "patch",
      "environment",
    ] as const);
    const r = record(value, [
      "schemaVersion",
      "id",
      "contentVersion",
      "kind",
      "category",
      "tags",
      "environments",
      "origin",
      "files",
      "coordinates",
      "gaussian",
      "resources",
      "provenance",
      "quality",
      "loader",
      kind,
    ]);
    const identity = {
      id: identifier(r.id),
      contentVersion: identifier(r.contentVersion),
    };
    const resources = at("resources", () => {
      const v = record(r.resources, [
        "decodedBytes",
        "cpuSourceBytes",
        "uploadBytes",
      ]);
      const decodedBytes = integer(
          v.decodedBytes,
          1,
          GENERAL_LIMITS.maxCandidateCpuBytes,
        ),
        cpuSourceBytes = integer(
          v.cpuSourceBytes,
          1,
          GENERAL_LIMITS.maxCandidateCpuBytes,
        ),
        uploadBytes = integer(
          v.uploadBytes,
          0,
          GENERAL_LIMITS.maxTransitionBytes,
        );
      if (decodedBytes + cpuSourceBytes > GENERAL_LIMITS.maxCandidateCpuBytes)
        throw Error("Decoded arrays and CPU source exceed candidate budget");
      if (
        decodedBytes + cpuSourceBytes + uploadBytes >
        GENERAL_LIMITS.maxTransitionBytes
      )
        throw Error("Declared memory exceeds transition budget");
      return { decodedBytes, cpuSourceBytes, uploadBytes };
    });
    const base: ManifestBase = {
      schemaVersion: oneOf(r.schemaVersion, [2] as const),
      ...identity,
      category: identifier(r.category),
      tags: unique(list(r.tags, identifier, 32)),
      environments: unique(list(r.environments, identifier, 32, 1)),
      origin: oneOf(r.origin, ["captured", "procedural", "generated"] as const),
      files: at("files", () => parseFiles(r.files)),
      coordinates: at("coordinates", () => parseCoordinates(r.coordinates)),
      gaussian: at("gaussian", () => parseGaussian(r.gaussian)),
      resources,
      provenance: at("provenance", () => parseProvenance(r.provenance)),
      quality: at("quality", () => parseQuality(r.quality, kind, identity)),
    };
    if (
      ["candidate", "accepted"].includes(base.quality.status) &&
      base.provenance.license.id === "unknown"
    )
      throw Error("Unknown license cannot enter new generation candidates");
    if (
      base.quality.status === "accepted" &&
      base.gaussian.full.quality.status !== "passed"
    )
      throw Error("Accepted full LOD needs an independent quality pass");
    if (
      base.quality.status === "accepted" &&
      (base.gaussian.validatedDistance === null ||
        base.gaussian.validatedDirections.length === 0)
    )
      throw Error(
        "Accepted assets need validated viewing distance and directions",
      );
    const reviewedFiles = base.quality.humanReview?.files;
    if (
      reviewedFiles &&
      (reviewedFiles.length !== base.files.length ||
        base.files.some(
          (file) =>
            !reviewedFiles.some(
              (reviewed) =>
                reviewed.path === file.path && reviewed.sha256 === file.sha256,
            ),
        ))
    )
      throw Error(
        "Human review file identities do not match declared asset files",
      );
    oneOf(r.loader, [loadersByKind[kind]]);
    if (kind === "object")
      return freeze({
        ...base,
        kind,
        loader: loadersByKind.object,
        object: at("object", () => parseObject(r.object, base)),
      });
    if (kind === "patch")
      return freeze({
        ...base,
        kind,
        loader: loadersByKind.patch,
        patch: at("patch", () => parsePatch(r.patch, base)),
      });
    return freeze({
      ...base,
      kind,
      loader: loadersByKind.environment,
      environment: at("environment", () =>
        parseEnvironment(r.environment, base),
      ),
    });
  });
}

/** Reference-only bridge. Missing v2 evidence is never synthesized; the old record remains intact. */
export function legacyAssetRef(metadata: AssetMetadata): AssetRef & {
  readonly status: "candidate" | "legacy";
  readonly metadata: AssetMetadata;
} {
  return Object.freeze({
    id: metadata.id,
    contentVersion: metadata.contentVersion,
    status:
      oneOf(metadata.quality.status, ["trial", "legacy"] as const) === "trial"
        ? "candidate"
        : "legacy",
    metadata,
  });
}

/** T2 metadata for future procedural surfaces; identity JSON is the sole reviewable file. */
export function parseSurfaceStyle(value: unknown): SurfaceStyle {
  assertJson(value);
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    GENERAL_LIMITS.maxJsonBytes
  )
    throw Error("Style JSON exceeds limit");
  const r = record(value, [
    "id",
    "contentVersion",
    "parameters",
    "quality",
    "provenance",
  ]);
  const identity = {
    id: identifier(r.id),
    contentVersion: identifier(r.contentVersion),
  };
  if (
    !r.parameters ||
    typeof r.parameters !== "object" ||
    Array.isArray(r.parameters) ||
    Object.keys(r.parameters).length > 64
  )
    throw Error("Invalid style parameters");
  const parameters: Record<string, number | readonly number[]> = {};
  for (const [key, v] of Object.entries(r.parameters)) {
    identifier(key);
    parameters[key] = Array.isArray(v)
      ? list(v, (x) => finite(x), 16, 1)
      : finite(v);
  }
  const provenance = parseProvenance(r.provenance),
    quality = parseQuality(r.quality, "patch", identity);
  if (
    ["candidate", "accepted"].includes(quality.status) &&
    provenance.license.id === "unknown"
  )
    throw Error("Unknown style license");
  if (quality.humanReview) {
    const files = quality.humanReview.files;
    if (
      !/^sha256-[a-f0-9]{64}$/.test(identity.contentVersion) ||
      files.length !== 1 ||
      files[0].path !== "style-identity.json" ||
      files[0].sha256 !== identity.contentVersion.slice(7)
    )
      throw Error("Style review identity file mismatch");
  }
  return freeze({ ...identity, parameters, quality, provenance });
}
