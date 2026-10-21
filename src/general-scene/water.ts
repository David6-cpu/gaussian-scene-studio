import {
  profileGeometry,
  certifyRiverStrip,
  profileDistance,
  profileSection,
  evaluateWaterProfile,
  type HeightModel,
  type ProfileWater,
  type ProfileGeometry,
} from "./water-profile.ts";
import {
  inspectCpuBuffer,
  parsePlanDraft,
  type PlanDraft,
  type ScenePlan,
} from "./contracts.ts";
import { quantizeGeometry } from "./canonical.ts";
import { GENERAL_LIMITS as L, type Result, type Vec2 } from "./core.ts";
import {
  terrainNodeWorld,
  terrainNodeWorldArea,
  sampleTerrainWorld,
  terrainNormals,
  type TerrainField,
} from "./terrain.ts";
export type WaterDomain = {
  version: string;
  /** Analytic cache is checked against the field heightModel before every public query. */
  geometry: ProfileGeometry | null;
  activeCells: Uint8Array;
  shore: readonly (readonly [Vec2, Vec2])[];
  distanceError: number;
  shoreIndex: Float32Array;
};
export type WaterReport = {
  algorithmVersion: string;
  levelSource: "absence" | "explicit" | "program-suggestion";
  candidateLevels: number[];
  candidates: {
    level: number;
    feasible: boolean;
    reason: string | null;
    volume: number | null;
  }[];
  components: number;
  wetNodes: number;
  dryAreaFraction: number;
  minimumDryBank: number;
  /** Arithmetic/certified-distance enclosure, never a geometric permission to change width. */
  numericalBoundaryError: number;
  modifiedBounds: { min: Vec2; max: Vec2 } | null;
  summary: string;
  requiresManifestValidation: boolean;
};
export type WaterSolution = {
  resolvedWater: ScenePlan["water"];
  field: TerrainField;
  wetMask: Uint8Array;
  shoreDistance: Float32Array;
  bankMask: Uint8Array;
  cutVolume: number;
  fillVolume: number;
  domain: WaterDomain;
  report: WaterReport;
};

/** Uniform-knot cubic Hermite, certified Bezier geometry and analytic v1
 * bed/bank profiles over immutable bilinear sources. Preserve uses certified
 * rigid bilinear strips. Cache samples never redefine either authority. */
export const WATER_ALGORITHM_VERSION = "general-water-hermite-profile-v5";
const CURVE_ERROR = 1e-5,
  CONTOUR_ERROR = 1e-4,
  MAX_CURVE_LEAVES = 4096,
  MAX_SHORE_SEGMENTS = 65536;
type Present = Exclude<PlanDraft["water"], { mode: "none" | "unspecified" }>;
type Segment = readonly [Vec2, Vec2];
type Cubic = readonly [Vec2, Vec2, Vec2, Vec2];
class WaterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function reject(code: string, message: string): never {
  throw new WaterError(code, message);
}
const failure = (e: unknown): Result<never> => ({
  ok: false,
  issues: [
    {
      code:
        e instanceof WaterError
          ? e.code
          : e instanceof Error && e.message.startsWith("water-precision:")
            ? "water-precision"
            : "water-input",
      path: "water",
      message: e instanceof Error ? e.message : "Invalid water input",
    },
  ],
});
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const mix = (a: Vec2, b: Vec2, t: number): Vec2 =>
  add(mul(a, 1 - t), mul(b, t));
const length = (a: Vec2) => Math.hypot(...a);
function distanceSquared(p: Vec2, a: Vec2, b: Vec2) {
  const x = b[0] - a[0],
    z = b[1] - a[1],
    d = x * x + z * z,
    t = d
      ? Math.max(0, Math.min(1, ((p[0] - a[0]) * x + (p[1] - a[1]) * z) / d))
      : 0;
  const dx = p[0] - a[0] - t * x,
    dz = p[1] - a[1] - t * z;
  return dx * dx + dz * dz;
}
function distance(p: Vec2, a: Vec2, b: Vec2) {
  return Math.sqrt(distanceSquared(p, a, b));
}
const cross = (a: Vec2, b: Vec2, c: Vec2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  if (
    cross(a, b, c) * cross(a, b, d) < 0 &&
    cross(c, d, a) * cross(c, d, b) < 0
  )
    return 0;
  return Math.min(
    distance(a, c, d),
    distance(b, c, d),
    distance(c, a, b),
    distance(d, a, b),
  );
}
function polygonContains(p: readonly Vec2[], v: Vec2) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[j],
      b = p[i];
    if (distance(v, a, b) < 1e-10) return true;
    if (
      a[1] > v[1] !== b[1] > v[1] &&
      v[0] < ((b[0] - a[0]) * (v[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function split(b: Cubic): [Cubic, Cubic] {
  const a = mix(b[0], b[1], 0.5),
    c = mix(b[1], b[2], 0.5),
    d = mix(b[2], b[3], 0.5),
    e = mix(a, c, 0.5),
    f = mix(c, d, 0.5),
    m = mix(e, f, 0.5);
  return [
    [b[0], a, e, m],
    [m, f, d, b[3]],
  ];
}
function derivativeBounds(b: Cubic) {
  const d = [
      mul(sub(b[1], b[0]), 3),
      mul(sub(b[2], b[1]), 3),
      mul(sub(b[3], b[2]), 3),
    ],
    dd = [mul(sub(d[1], d[0]), 2), mul(sub(d[2], d[1]), 2)];
  const range = (xs: Vec2[], k: number) =>
    [
      Math.min(...xs.map((p) => p[k])),
      Math.max(...xs.map((p) => p[k])),
    ] as const;
  const x = range(d, 0),
    z = range(d, 1),
    xx = range(dd, 0),
    zz = range(dd, 1),
    low = (r: readonly number[]) => (r[0] > 0 ? r[0] : r[1] < 0 ? -r[1] : 0),
    product = (a: readonly number[], b: readonly number[]) => {
      const vs = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
      return [Math.min(...vs), Math.max(...vs)];
    },
    a = product(x, zz),
    c = product(z, xx),
    speed = Math.hypot(low(x), low(z));
  return {
    upper: speed
      ? Math.max(Math.abs(a[0] - c[1]), Math.abs(a[1] - c[0])) / speed ** 3
      : Infinity,
    speed,
  };
}
/** Convex hull bounds cover the entire cubic, not sparse point samples. Derivative
 * Bernstein hulls bound curvature on each accepted interval. A finite cap rejects
 * unresolved precision instead of claiming the curve is safe. */
function riverLine(
  w: Extract<Present, { mode: "river" }>,
  p: PlanDraft,
): Vec2[] {
  const points = w.controlPoints.map(
      ([u, v]) =>
        [(u - 0.5) * p.domain.width, (v - 0.5) * p.domain.depth] as Vec2,
    ),
    tangents = points.map((_, i) =>
      i === 0
        ? sub(points[1], points[0])
        : i === points.length - 1
          ? sub(points[i], points[i - 1])
          : mul(sub(points[i + 1], points[i - 1]), 0.5),
    );
  const line: Vec2[] = [points[0]],
    radius = w.width / 2 + w.bankWidth,
    minRadius = Math.max(w.width, radius),
    limit = 1 / minRadius;
  const visit = (b: Cubic, depth: number) => {
    if (line.length > MAX_CURVE_LEAVES)
      reject(
        "water-curve-precision",
        "Curve proof exceeded bounded subdivision; simplify the requested controls",
      );
    const within = b.every(
        ([x, z]) =>
          Math.abs(x) <= p.domain.width / 2 + 1e-12 &&
          Math.abs(z) <= p.domain.depth / 2 + 1e-12,
      ),
      { upper } = derivativeBounds(b),
      flat = Math.max(distance(b[1], b[0], b[3]), distance(b[2], b[0], b[3]));
    const half = split(b),
      mid = half[0][3];
    if (
      Math.abs(mid[0]) > p.domain.width / 2 + 1e-10 ||
      Math.abs(mid[1]) > p.domain.depth / 2 + 1e-10
    )
      reject(
        "water-curve-escape",
        "Interpolated river leaves the scene; controls were not clipped",
      );
    const d = mul(
        sub(
          mix(mix(b[1], b[2], 0.5), mix(b[2], b[3], 0.5), 0.5),
          mix(mix(b[0], b[1], 0.5), mix(b[1], b[2], 0.5), 0.5),
        ),
        3,
      ),
      dd = mul(add(sub(b[3], mul(b[2], 2)), b[1]), 3); // midpoint second derivative below uses both endpoint values
    const second = mul(add(sub(b[2], mul(b[1], 2)), b[0]), 3),
      acc = add(second, dd),
      speed = length(d),
      curvature = speed
        ? Math.abs(d[0] * acc[1] - d[1] * acc[0]) / speed ** 3
        : Infinity;
    if (curvature > limit + 1e-9)
      reject(
        "water-curvature",
        "Interpolated river radius is smaller than width or its bank buffer; controls unchanged",
      );
    if (
      within &&
      upper <= limit + 1e-12 &&
      flat <= CURVE_ERROR &&
      length(sub(b[3], b[0])) <= 0.05
    ) {
      line.push(b[3]);
      return;
    }
    if (depth >= 20)
      reject(
        "water-curve-precision",
        "Cannot certify continuous river curvature/domain within the subdivision bound",
      );
    visit(half[0], depth + 1);
    visit(half[1], depth + 1);
  };
  for (let i = 0; i < points.length - 1; i++)
    visit(
      [
        points[i],
        add(points[i], mul(tangents[i], 1 / 3)),
        sub(points[i + 1], mul(tangents[i + 1], 1 / 3)),
        points[i + 1],
      ],
      0,
    );
  const arc = [0];
  for (let i = 1; i < line.length; i++)
    arc.push(arc[i - 1] + length(sub(line[i], line[i - 1])));
  for (let i = 0; i < line.length - 1; i++)
    for (let j = i + 2; j < line.length - 1; j++) {
      const separation = segmentDistance(
        line[i],
        line[i + 1],
        line[j],
        line[j + 1],
      );
      if (
        separation <= 2 * CURVE_ERROR &&
        arc[j] - arc[i + 1] > 4 * CURVE_ERROR
      )
        reject(
          "water-self-intersection",
          "Interpolated centerline intersects or cannot be separated at certified precision",
        );
      // Local offset uniqueness is covered by radius > buffer radius. A nonlocal
      // double-normal contact needs >=pi total turning between contacts; check all
      // farther arc pairs using chord hull error on BOTH intervals.
      if (
        arc[j] - arc[i + 1] >= Math.PI * radius &&
        separation <= 2 * radius + 2 * CURVE_ERROR
      )
        reject(
          "water-buffer-overlap",
          "Nonlocal river/bank buffers overlap; controls unchanged",
        );
    }
  return line;
}
function requestedDomain(w: Present, p: PlanDraft) {
  const line = w.mode === "river" ? riverLine(w, p) : w.polygon;
  const edges: Segment[] = line.slice(1).map((b, i) => [line[i], b]);
  if (w.mode === "surface") edges.push([line.at(-1)!, line[0]]);
  return {
    line,
    edges,
    signed: (v: Vec2) => {
      let squared = Infinity;
      for (const [a, b] of edges)
        squared = Math.min(squared, distanceSquared(v, a, b));
      const d = Math.sqrt(squared);
      return w.mode === "river"
        ? d - w.width / 2
        : polygonContains(line, v)
          ? -d
          : d;
    },
  };
}
function nodeData(field: TerrainField) {
  const n = field.nx * field.nz,
    x = new Float64Array(n),
    z = new Float64Array(n),
    h = new Float64Array(n),
    error = new Float64Array(n),
    area = new Float64Array(n),
    valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const q = terrainNodeWorld(field, i);
    x[i] = q[0];
    h[i] = q[1];
    z[i] = q[2];
    area[i] = terrainNodeWorldArea(field, i);
    const s = sampleTerrainWorld(field, q[0], q[2]);
    if (s.ok) {
      valid[i] = 1;
      error[i] = s.value.worldError;
    }
  }
  return { x, z, h, error, area, valid };
}
function validateInput(p: PlanDraft, f: TerrainField) {
  if (f.heightModel?.kind === "water-profile")
    reject(
      "water-input",
      "Re-solve from immutable pre-water terrain, not a previous analytic result or final cache",
    );
  if (
    f.domain.width !== p.domain.width ||
    f.domain.depth !== p.domain.depth ||
    f.layout !== "row-major-zx" ||
    (p.terrain.source === "patch") !== (f.space === "canonical") ||
    (f.space === "world") !== (f.transform === null) ||
    (p.terrain.source === "patch") !== (f.patchSupport !== null)
  )
    reject("water-input", "Terrain and draft domain/source disagree");
  if (
    p.terrain.source === "procedural" &&
    (f.width !== p.domain.width ||
      f.depth !== p.domain.depth ||
      f.spacing !== p.terrain.spacing)
  )
    reject("water-input", "Procedural grid does not match draft");
  if (
    f.nx * f.nz > L.maxHeightNodes ||
    f.nx < 2 ||
    f.nz < 2 ||
    Math.abs((f.nx - 1) * f.spacing - f.width) > 1e-9 ||
    Math.abs((f.nz - 1) * f.spacing - f.depth) > 1e-9
  )
    reject("water-input", "Invalid height dimensions");
  const buffers = [
      f.heights,
      f.normals,
      ...f.tiles.flatMap((t) => [t.nodeIndices, t.outputIndices]),
    ],
    backings = new Set<ArrayBuffer>();
  let bytes = 0;
  for (const b of buffers) {
    const m = inspectCpuBuffer(b);
    if (!backings.has(m.buffer)) {
      bytes += m.backingByteLength;
      backings.add(m.buffer);
    }
  }
  if (
    !(f.heights instanceof Float32Array) ||
    f.heights.length !== f.nx * f.nz ||
    !(f.normals instanceof Float32Array) ||
    f.normals.length !== 3 * f.nx * f.nz ||
    f.heights.some((x) => !Number.isFinite(x))
  )
    reject("water-input", "Invalid terrain arrays");
  if (p.terrain.source === "patch") {
    const t = p.terrain.transform,
      actual = f.transform!;
    if (
      f.width !== 4 ||
      f.depth !== 4 ||
      f.spacing !== 0.1 ||
      actual.scale !== t.scale ||
      !actual.position.every((v, i) => v === t.position[i]) ||
      !actual.quaternion.every((v, i) => v === t.quaternion[i])
    )
      reject(
        "water-input",
        "Fixed patch grid/transform does not match the draft",
      );
  }
  for (let i = 0; i < f.heights.length; i++) {
    const h = terrainNodeWorld(f, i)[1];
    if (h < -2 || h > 2)
      reject("water-elevation", "Input terrain elevation is outside [-2,+2]");
  }
  let supportEdgeCount = 0,
    supportPolygonCount = 0;
  if (f.patchSupport) {
    if (
      !Array.isArray(f.patchSupport.voidMask) ||
      f.patchSupport.voidMask.length > 128
    )
      reject("water-input", "Patch support exceeds its bounded polygon count");
    for (const polygon of [
      f.patchSupport.validPolygon,
      ...f.patchSupport.voidMask,
    ]) {
      if (
        !Array.isArray(polygon) ||
        polygon.length < 3 ||
        polygon.length > 128 ||
        polygon.some(
          (q) =>
            !Array.isArray(q) ||
            q.length !== 2 ||
            q.some((x) => !Number.isFinite(x)),
        )
      )
        reject(
          "water-input",
          "Patch support must contain bounded finite polygons",
        );
      supportEdgeCount += polygon.length;
      supportPolygonCount++;
    }
  }
  // Retained terrain + precomputed world data + two candidate fields + masks +
  // maximum bounded contour/curve storage, plus 1152B per support edge (the
  // previous 1KiB plus 128B for query bounds), 128B per polygon and 80KiB
  // exact clipping/anchor scratch. The cell bitmap and named
  // coordinate rationals fit the existing per-node allowance. Metadata are not
  // duplicated per candidate level; no per-level array history is retained.
  if (
    bytes +
      f.nx * f.nz * 1024 +
      MAX_SHORE_SEGMENTS * 384 +
      MAX_CURVE_LEAVES * 96 +
      supportEdgeCount * 1152 +
      supportPolygonCount * 128 +
      (supportEdgeCount ? 81920 : 0) >
    L.maxCandidateCpuBytes
  )
    reject(
      "water-budget",
      "Water working arrays exceed the candidate CPU budget",
    );
}
const f32buf = new ArrayBuffer(4),
  f32 = new Float32Array(f32buf),
  u32 = new Uint32Array(f32buf);
function neighbors(i: number, nx: number, nz: number) {
  const x = i % nx,
    z = Math.floor(i / nx);
  return [
    ...(x ? [i - 1] : []),
    ...(x < nx - 1 ? [i + 1] : []),
    ...(z ? [i - nx] : []),
    ...(z < nz - 1 ? [i + nx] : []),
  ];
}
function cellsAt(f: TerrainField, index: number) {
  const x = index % (f.nx - 1),
    z = Math.floor(index / (f.nx - 1)),
    a = z * f.nx + x;
  return [a, a + 1, a + f.nx + 1, a + f.nx];
}
function cellCorners(f: TerrainField, index: number): Vec2[] {
  return cellsAt(f, index).map((i) => {
    const [x, , z] = terrainNodeWorld(f, i);
    return [x, z];
  });
}
function polygonEdges(p: readonly Vec2[]): Segment[] {
  return p.map((v, i) => [v, p[(i + 1) % p.length]]);
}
function rectPolygonDistance(corners: Vec2[], boundary: readonly Segment[]) {
  let best = Infinity;
  for (const [a, b] of polygonEdges(corners))
    for (const [c, d] of boundary)
      best = Math.min(best, segmentDistance(a, b, c, d));
  return best;
}
type Dyadic = { integer: bigint; exponent: number };
type SupportRectangle = { min: Vec2; max: Vec2 };
type SupportEdge = {
  segment: Segment;
  closed: boolean;
  exact: readonly [readonly Dyadic[], readonly Dyadic[]];
  query: SupportRectangle | null;
};
type SupportPolygon = SupportRectangle & {
  edges: SupportEdge[];
  closed: boolean;
};
/** @internal Encloses T6's on-edge bbox and exact/computed ray crossings.
 * The tolerance and operation order mirror terrain.ts pointInPolygon. Dropping
 * the rounded cross-product constraint is deliberately conservative. Finite
 * endpoint evaluations bound the monotone ordered ray expression throughout
 * the closed straddle interval; no division or product is rearranged.
 */
export function supportQueryRectangle(
  [a, b]: Segment,
  gridZ: readonly [number, number],
): SupportRectangle {
  const min: [number, number] = [
      Math.min(a[0], b[0]) - 1e-9,
      Math.min(a[1], b[1]) - 1e-9,
    ],
    max: [number, number] = [
      Math.max(a[0], b[0]) + 1e-9,
      Math.max(a[1], b[1]) + 1e-9,
    ],
    lo = Math.max(Math.min(a[1], b[1]), gridZ[0]),
    hi = Math.min(Math.max(a[1], b[1]), gridZ[1]);
  if (![...a, ...b, ...gridZ, ...min, ...max].every(Number.isFinite))
    reject(
      "water-support-precision",
      "Cannot certify finite support query bounds",
    );
  if (a[1] !== b[1] && lo <= hi) {
    const dx = b[0] - a[0],
      dz = b[1] - a[1];
    for (const z of [lo, hi]) {
      const offset = z - a[1],
        product = dx * offset,
        quotient = product / dz,
        ray = quotient + a[0];
      if (
        dz === 0 ||
        ![dx, dz, offset, product, quotient, ray].every(Number.isFinite)
      )
        reject(
          "water-support-precision",
          "Cannot certify finite ordered support ray arithmetic",
        );
      min[0] = Math.min(min[0], a[0], b[0], ray);
      max[0] = Math.max(max[0], a[0], b[0], ray);
    }
  }
  return { min, max };
}
function supportPolygons(f: TerrainField): SupportPolygon[] {
  if (!f.patchSupport) return [];
  const prepare = (
    polygon: readonly Vec2[],
    closed: boolean,
  ): SupportPolygon => ({
    closed,
    min: [
      Math.min(...polygon.map((p) => p[0])),
      Math.min(...polygon.map((p) => p[1])),
    ],
    max: [
      Math.max(...polygon.map((p) => p[0])),
      Math.max(...polygon.map((p) => p[1])),
    ],
    edges: polygonEdges(polygon).map((segment) => {
      const [a, b] = segment,
        axisValid = !closed && (a[0] === b[0] || a[1] === b[1]);
      if (
        axisValid &&
        ![
          b[0] - a[0],
          b[1] - a[1],
          -f.width / 2 - a[0],
          f.width / 2 - a[0],
          -f.depth / 2 - a[1],
          f.depth / 2 - a[1],
        ].every(Number.isFinite)
      )
        reject(
          "water-support-precision",
          "Cannot certify finite axis-boundary support arithmetic",
        );
      return {
        segment,
        closed,
        exact: [a.map(supportDyadic), b.map(supportDyadic)],
        // Axis valid boundaries have exact parity and can only ADD query
        // acceptance. Finite subtractions prevent 0*Infinity on the boundary.
        query: axisValid
          ? null
          : supportQueryRectangle(segment, [-f.depth / 2, f.depth / 2]),
      };
    }),
  });
  // Edge rationals/query rectangles are built once before all level candidates.
  return [
    prepare(f.patchSupport.validPolygon, false),
    ...f.patchSupport.voidMask.map((p) => prepare(p, true)),
  ];
}
const supportFloat = new Float64Array(1);
const supportBits = new BigUint64Array(supportFloat.buffer);
/** Exact dyadic coordinates: finite Float64 = integer*2^exponent. Aligned
 * Float64 coordinates use <=2098 bits. An exact midpoint can reach exponent
 * -1075: aligned coordinates <=2099, differences <=2100, comparisons <=4201 bits.
 * AABB exclusions use exact order of the stored numbers. No geometric epsilon.
 */
function supportDyadic(value: number): Dyadic {
  if (value === 0) return { integer: 0n, exponent: 0 };
  supportFloat[0] = value;
  const bits = supportBits[0],
    biased = Number((bits >> 52n) & 2047n),
    fraction = bits & ((1n << 52n) - 1n),
    integer =
      (biased ? (1n << 52n) | fraction : fraction) * (bits >> 63n ? -1n : 1n);
  return { integer, exponent: biased ? biased - 1075 : -1074 };
}
function supportIntegers(parts: readonly Dyadic[]): bigint[] {
  const exponent = Math.min(
    ...parts.filter((p) => p.integer !== 0n).map((p) => p.exponent),
  );
  return parts.map((p) =>
    p.integer === 0n ? 0n : p.integer << BigInt(p.exponent - exponent),
  );
}
/** Liang-Barsky parameter clipping with exact rational bound comparisons.
 * Valid-polygon edges invalidate only an OPEN cell: a coincident usable outer
 * boundary remains legal. A void is CLOSED, so even a corner/edge touch makes
 * the cell unavailable. Both axes and the complete finite t interval are used.
 */
function supportEdgeIntersectsCell(
  edge: SupportEdge,
  min: Vec2,
  max: Vec2,
  exactBounds: readonly [readonly Dyadic[], readonly Dyadic[]],
): boolean {
  const [a, b] = edge.segment;
  for (const k of [0, 1]) {
    const low = Math.min(a[k], b[k]),
      high = Math.max(a[k], b[k]);
    if (
      edge.closed
        ? high < min[k] || low > max[k]
        : high <= min[k] || low >= max[k]
    )
      return false;
  }
  type Bound = { n: bigint; d: bigint; open: boolean };
  let low: Bound = { n: 0n, d: 1n, open: false },
    high: Bound = { n: 1n, d: 1n, open: false };
  const compare = (a: Bound, b: Bound) => a.n * b.d - b.n * a.d;
  for (const k of [0, 1]) {
    const [x, y, lo, hi] = supportIntegers([
        edge.exact[0][k],
        edge.exact[1][k],
        exactBounds[0][k],
        exactBounds[1][k],
      ]),
      d = y - x;
    if (d === 0n) {
      if (edge.closed ? x < lo || x > hi : x <= lo || x >= hi) return false;
      continue;
    }
    const enter: Bound = {
        n: d > 0n ? lo - x : x - hi,
        d: d > 0n ? d : -d,
        open: !edge.closed,
      },
      leave: Bound = {
        n: d > 0n ? hi - x : x - lo,
        d: enter.d,
        open: !edge.closed,
      };
    const c0 = compare(enter, low),
      c1 = compare(leave, high);
    if (c0 > 0n) low = enter;
    else if (c0 === 0n) low = { ...low, open: low.open || enter.open };
    if (c1 < 0n) high = leave;
    else if (c1 === 0n) high = { ...high, open: high.open || leave.open };
    const gap = compare(low, high);
    if (gap > 0n || (gap === 0n && (low.open || high.open))) return false;
  }
  return true;
}
/** Exact half-open odd-even parity at a strictly interior dyadic anchor.
 * This is a topology witness ONLY AFTER excluding every boundary from the
 * cell. It does not substitute a sample for whole-cell boundary exclusion.
 */
function supportContainsAnchor(
  polygon: SupportPolygon,
  anchor: readonly Dyadic[],
) {
  let inside = false;
  for (const edge of polygon.edges) {
    const [ax, az, bx, bz, x, z] = supportIntegers([
      ...edge.exact[0],
      ...edge.exact[1],
      ...anchor,
    ]);
    if (az > z !== bz > z) {
      const left = (x - ax) * (bz - az),
        right = (bx - ax) * (z - az);
      if (bz > az ? left < right : left > right) inside = !inside;
    }
  }
  return inside;
}
function supportRectanglesMeet(a: SupportRectangle, b: SupportRectangle) {
  return (
    a.max[0] >= b.min[0] &&
    a.min[0] <= b.max[0] &&
    a.max[1] >= b.min[1] &&
    a.min[1] <= b.max[1]
  );
}
/** Conservative preimage of T6's actual fl(fl(x+extent/2)/spacing)
 * cell selector. One adjacent Float64 encloses each rounding step; product and
 * subtraction are also rounded outward. Include named and raw forward nodes,
 * and restrict to the original finite grid support (never extend that support).
 * This enlarges only the area checked for obstructions, not the terrain/grid.
 */
function supportBoundaryEnvelope(
  index: number,
  extent: number,
  spacing: number,
) {
  const adjacent = (x: number, up: boolean) => {
    if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    supportFloat[0] = x;
    supportBits[0] += x > 0 === up ? 1n : -1n;
    return supportFloat[0];
  };
  const raw = -extent / 2 + index * spacing,
    named = quantizeGeometry(raw),
    lower = adjacent(
      adjacent(adjacent(adjacent(index, false) * spacing, false), false) -
        extent / 2,
      false,
    ),
    upper = adjacent(
      adjacent(adjacent(adjacent(index, true) * spacing, true), true) -
        extent / 2,
      true,
    );
  return {
    lower: Math.max(-extent / 2, Math.min(lower, named, raw)),
    upper: Math.min(extent / 2, Math.max(upper, named, raw)),
  };
}
/** @internal Complete-cell support certificate; node validity is only an early filter. */
export function prepareSupportCells(
  f: TerrainField,
  valid: Uint8Array,
): Uint8Array {
  const polygons = supportPolygons(f),
    out = new Uint8Array((f.nx - 1) * (f.nz - 1));
  const xs = Array.from({ length: f.nx }, (_, x) =>
      supportBoundaryEnvelope(x, f.width, f.spacing),
    ),
    zs = Array.from({ length: f.nz }, (_, z) =>
      supportBoundaryEnvelope(z, f.depth, f.spacing),
    ),
    dx = xs.map((v) => ({
      lower: supportDyadic(v.lower),
      upper: supportDyadic(v.upper),
    })),
    dz = zs.map((v) => ({
      lower: supportDyadic(v.lower),
      upper: supportDyadic(v.upper),
    }));
  for (let j = 0; j < out.length; j++) {
    if (!cellsAt(f, j).every((i) => valid[i])) continue;
    const x = j % (f.nx - 1),
      z = Math.floor(j / (f.nx - 1)),
      min: Vec2 = [xs[x].lower, zs[z].lower],
      max: Vec2 = [xs[x + 1].upper, zs[z + 1].upper],
      exactBounds: readonly [readonly Dyadic[], readonly Dyadic[]] = [
        [dx[x].lower, dz[z].lower],
        [dx[x + 1].upper, dz[z + 1].upper],
      ];
    const cell = { min, max };
    if (
      polygons.some((p) =>
        p.edges.some((edge) =>
          edge.query
            ? supportRectanglesMeet(edge.query, cell)
            : supportEdgeIntersectsCell(edge, min, max, exactBounds),
        ),
      )
    )
      continue;
    // Exactly (lo+hi)/2, including adjacent Float64 endpoints. No rounded
    // midpoint can land on a boundary; each selector cell has positive extent.
    const anchor = [0, 1].map((k) => {
      const parts = [exactBounds[0][k], exactBounds[1][k]],
        [lo, hi] = supportIntegers(parts),
        exponent = Math.min(
          ...parts.filter((p) => p.integer !== 0n).map((p) => p.exponent),
        );
      return { integer: lo + hi, exponent: exponent - 1 };
    });
    out[j] = +polygons.every((p) => {
      if (!supportRectanglesMeet(p, cell)) return p.closed;
      return supportContainsAnchor(p, anchor) !== p.closed;
    });
  }
  return out;
}
function contour(
  field: TerrainField,
  active: Uint8Array,
  level: number,
): Segment[] {
  const segments: Segment[] = [];
  const push = (a: Vec2, b: Vec2) => {
    if (length(sub(a, b)) > 1e-12) segments.push([a, b]);
    if (segments.length > MAX_SHORE_SEGMENTS)
      reject(
        "water-contour-budget",
        "Final shoreline exceeds the bounded contour budget",
      );
  };
  const quad = (p: Vec2[], h: number[], depth: number) => {
    const wet = h.map((v) => v < level);
    if (wet.every(Boolean) || wet.every((v) => !v)) return;
    const intersections: Vec2[] = [];
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      if (wet[k] !== wet[j])
        intersections.push(mix(p[k], p[j], (level - h[k]) / (h[j] - h[k])));
    }
    const b = h[1] - h[0],
      c = h[3] - h[0],
      d = h[0] - h[1] + h[2] - h[3],
      minimum = (a: number, b: number) =>
        a * b > 0 ? Math.min(Math.abs(a), Math.abs(b)) : 0,
      gradient = Math.max(minimum(b, b + d), minimum(c, c + d)),
      side = Math.max(length(sub(p[1], p[0])), length(sub(p[3], p[0]))),
      bound = gradient ? (Math.abs(d) * side) / (4 * gradient) : Infinity;
    // The bilinear zero set is a monotone graph if one derivative has a fixed
    // nonzero sign. Its chord residual <=abs(d)/4, so graph displacement is
    // bounded by residual/minDerivative. Degenerate/saddle cells subdivide.
    if (
      intersections.length === 2 &&
      (d === 0 || bound <= CONTOUR_ERROR || side * Math.SQRT2 <= CONTOUR_ERROR)
    ) {
      push(intersections[0], intersections[1]);
      return;
    }
    if (depth >= 18)
      reject(
        "water-contour-precision",
        "Cannot bound final bilinear shoreline precision",
      );
    const m = [
        mix(p[0], p[1], 0.5),
        mix(p[1], p[2], 0.5),
        mix(p[2], p[3], 0.5),
        mix(p[3], p[0], 0.5),
      ],
      hm = h.map((v, i) => (v + h[(i + 1) % 4]) / 2),
      center = mix(p[0], p[2], 0.5),
      hc = (h[0] + h[1] + h[2] + h[3]) / 4;
    for (let k = 0; k < 4; k++)
      quad(
        [p[k], m[k], center, m[(k + 3) % 4]],
        [h[k], hm[k], hc, hm[(k + 3) % 4]],
        depth + 1,
      );
  };
  for (let j = 0; j < active.length; j++)
    if (active[j]) {
      const ids = cellsAt(field, j),
        points = cellCorners(field, j),
        heights = ids.map((i) => terrainNodeWorld(field, i)[1]);
      quad(points, heights, 0);
      const x = j % (field.nx - 1),
        z = Math.floor(j / (field.nx - 1));
      for (const k of [0, 1, 2, 3])
        if (
          (k === 0 && z === 0) ||
          (k === 1 && x === field.nx - 2) ||
          (k === 2 && z === field.nz - 2) ||
          (k === 3 && x === 0)
        ) {
          const next = (k + 1) % 4,
            a = heights[k],
            b = heights[next];
          if (a < level && b < level) push(points[k], points[next]);
          else if (a < level !== b < level) {
            const q = mix(points[k], points[next], (level - a) / (b - a));
            push(a < level ? points[k] : q, a < level ? q : points[next]);
          }
        }
    }
  return segments;
}
function continuousBanks(
  p: PlanDraft,
  w: Present,
  f: TerrainField,
  active: Uint8Array,
  wet: Uint8Array,
  supportedCells: Uint8Array,
  errors: Float64Array,
  level: number,
  vertical: boolean,
) {
  const count = (f.nx - 1) * (f.nz - 1),
    other = new Uint8Array(count),
    selected: number[] = [],
    fullyDry: number[] = [];
  // Every support/void edge participates in complete-cell validity. No edge
  // is removed merely because a river endpoint lies on its supporting line.
  const step = length(sub(cellCorners(f, 0)[1], cellCorners(f, 0)[0]));
  let dryArea = 0,
    minimum = Infinity;
  for (let j = 0; j < count; j++) {
    const ids = cellsAt(f, j),
      supported = !!supportedCells[j];
    if (active[j]) {
      if (!supported)
        reject(
          "water-support",
          "Cannot certify complete terrain support for every final water cell",
        );
      selected.push(j);
      // preserveBoundary certifies a complete longitudinal bilinear strip.
      // Its only terminal truncations are the two actual grid end sections;
      // transverse grid edges still bound the entire lateral dry-cell cover.
      const crossIndex = vertical ? j % (f.nx - 1) : Math.floor(j / (f.nx - 1)),
        crossCells = vertical ? f.nx - 1 : f.nz - 1,
        bank = Math.min(crossIndex, crossCells - crossIndex - 1) * step;
      minimum = Math.min(minimum, bank);
    } else {
      const dry =
        supported &&
        ids.every((i) => terrainNodeWorld(f, i)[1] - errors[i] >= level);
      if (!dry) other[j] = 1;
      else fullyDry.push(j);
    }
  }
  // Every omitted cell is either continuously dry (bilinear convex combination)
  // or an obstacle. Distance from the COVER of water cells to every obstacle and
  // transverse grid boundary is a lower bound on the actual continuous bank.
  // Scene support is separately proved for the full true-Hermite lateral strip.
  const reach = Math.min(
    Math.max(f.nx, f.nz),
    Math.ceil(L.minDryBankWidth / step) + 1,
  );
  for (const j of selected) {
    const x = j % (f.nx - 1),
      z = Math.floor(j / (f.nx - 1));
    for (
      let oz = Math.max(0, z - reach);
      oz <= Math.min(f.nz - 2, z + reach);
      oz++
    )
      for (
        let ox = Math.max(0, x - reach);
        ox <= Math.min(f.nx - 2, x + reach);
        ox++
      )
        if (other[oz * (f.nx - 1) + ox]) {
          const d =
            Math.hypot(
              Math.max(0, Math.abs(x - ox) - 1),
              Math.max(0, Math.abs(z - oz) - 1),
            ) * step;
          if (d + 1e-9 < L.minDryBankWidth)
            reject(
              "water-bank",
              "Cannot certify a continuous 0.2 dry bank from supported dry cells; use finer spacing or a wider bank",
            );
        }
  }
  // All farther cell covers are at least 0.2 away; report the proven lower bound.
  minimum = Math.min(minimum, L.minDryBankWidth);
  if (minimum + 1e-9 < L.minDryBankWidth)
    reject(
      "water-bank",
      "Water or its continuous dry bank reaches a transverse grid boundary",
    );
  dryArea = fullyDry.length * terrainNodeWorldArea(f, 0) * 4;
  const fraction = dryArea / (p.domain.width * p.domain.depth);
  if (fraction + 1e-9 < L.minDryAreaFraction)
    reject(
      "water-dry-area",
      "Cannot certify continuously dry supported cells over at least 25% of the scene",
    );
  // Ports must be reached by the same selected component; no Z-only shortcut.
  if (w.mode === "river")
    for (const [u, v] of [w.controlPoints[0], w.controlPoints.at(-1)!]) {
      const ex = (u - 0.5) * p.domain.width,
        ez = (v - 0.5) * p.domain.depth;
      let reached = false;
      for (let i = 0; i < wet.length; i++)
        if (wet[i]) {
          const [x, , z] = terrainNodeWorld(f, i);
          if (
            Math.hypot(x - ex, z - ez) <= w.width / 2 + 1e-9 &&
            (u === 0 || u === 1
              ? Math.abs(x - ex) < 1e-8
              : Math.abs(z - ez) < 1e-8)
          ) {
            reached = true;
            break;
          }
        }
      if (!reached)
        reject(
          "water-connectivity",
          "The actual water does not reach both requested endpoint cross-sections",
        );
    }
  return {
    dryAreaFraction: Math.min(1, fraction),
    minimumDryBank: Number.isFinite(minimum)
      ? minimum
      : Math.hypot(p.domain.width, p.domain.depth),
  };
}
function centerlineCells(f: TerrainField, line: readonly Vec2[]): number[] {
  const covered = new Set<number>(),
    step = length(sub(cellCorners(f, 0)[1], cellCorners(f, 0)[0])),
    padding = CURVE_ERROR / step;
  for (let k = 0; k < line.length - 1; k++) {
    const a = line[k],
      b = line[k + 1],
      ga = gridCoordinates(f, a[0], a[1]),
      gb = gridCoordinates(f, b[0], b[1]);
    for (
      let z = Math.max(0, Math.floor(Math.min(ga[1], gb[1]) - padding));
      z <= Math.min(f.nz - 2, Math.floor(Math.max(ga[1], gb[1]) + padding));
      z++
    )
      for (
        let x = Math.max(0, Math.floor(Math.min(ga[0], gb[0]) - padding));
        x <= Math.min(f.nx - 2, Math.floor(Math.max(ga[0], gb[0]) + padding));
        x++
      ) {
        const j = z * (f.nx - 1) + x,
          corners = cellCorners(f, j);
        if (
          polygonContains(corners, a) ||
          polygonContains(corners, b) ||
          rectPolygonDistance(corners, [[a, b]]) <= CURVE_ERROR
        )
          covered.add(j);
      }
  }
  return [...covered];
}
/** Geometry is independent of candidate level. Cell enclosures use the 1-Lipschitz
 * signed distance, so a dry-area certificate covers every point of a cell. */
function analyticPreparation(
  p: PlanDraft,
  w: Present,
  f: TerrainField,
  data: ReturnType<typeof nodeData>,
  requested: ReturnType<typeof requestedDomain>,
) {
  const geometry = profileGeometry(w, p.domain);
  const distances = Array.from({ length: data.h.length }, (_, i) =>
    profileDistance(geometry, [data.x[i], data.z[i]]),
  );
  const cells = Array.from({ length: (f.nx - 1) * (f.nz - 1) }, (_, j) => {
    const ids = cellsAt(f, j),
      corners = cellCorners(f, j),
      x = (corners[0][0] + corners[2][0]) / 2,
      z = (corners[0][1] + corners[2][1]) / 2;
    const d = profileDistance(geometry, [x, z]),
      radius = (Math.SQRT2 * f.spacing) / 2;
    return {
      low: d.lower - radius,
      high: d.upper + radius,
      min: Math.min(...ids.map((i) => data.h[i])),
    };
  });
  const scene: Vec2[] = [
    [-p.domain.width / 2, -p.domain.depth / 2],
    [p.domain.width / 2, -p.domain.depth / 2],
    [p.domain.width / 2, p.domain.depth / 2],
    [-p.domain.width / 2, p.domain.depth / 2],
  ];
  // Rivers use the shared full-strip proof before any level candidates.
  // Closed surfaces retain every scene edge and their complete dry collar.
  if (w.mode === "surface") {
    let clearance = Infinity;
    for (const [a, b] of requested.edges)
      for (const [c, d] of polygonEdges(scene))
        clearance = Math.min(clearance, segmentDistance(a, b, c, d));
    if (clearance < L.minDryBankWidth)
      reject(
        "water-bank",
        "Closed water domain lacks a supported continuous 0.2 dry bank",
      );
  }
  return { geometry, distances, cells };
}
function analyticCandidate(
  p: PlanDraft,
  w: Present,
  input: TerrainField,
  data: ReturnType<typeof nodeData>,
  prep: ReturnType<typeof analyticPreparation>,
  level: number,
) {
  if (w.reshapePolicy === "preserve")
    throw Error("Preserve cannot create a profile");
  const water = {
    ...w,
    level,
    levelStatus: "resolved" as const,
    levelSource: w.levelSource ?? "default",
  } as ProfileWater;
  const minimum = Math.min(...data.h);
  // Bilinear B is a convex combination of its four corners. These structural
  // bounds prove every profile branch, including equality, without sampling it.
  const arithmetic =
    64 * Number.EPSILON * Math.max(1, Math.abs(level), Math.abs(minimum));
  if (
    level - w.depth - arithmetic < -2 ||
    (minimum < level && 3 * level - 2 * minimum + arithmetic > 2)
  )
    reject(
      "water-elevation",
      "Continuous bed/bank arithmetic enclosure cannot certify [-2,+2]; parameters unchanged",
    );
  if (w.reshapePolicy === "cut-only" && minimum < level)
    reject(
      "water-policy",
      "Cannot certify continuous cut-only: original bilinear ground falls below this level",
    );
  const dry = (lo: number, hi: number, bmin: number) => {
    if (lo < 0) return false;
    if (bmin >= level || hi <= w.bankWidth / 2) return true;
    if (hi >= w.bankWidth) return false;
    // For B<L the outer branch factors as H-L=(B-L)*(-2+3*s).
    // Hence dry iff s<=2/3, independently of B; this avoids subtractive
    // cancellation certifying a tiny submerged bank as equal to the level.
    const t = (2 * hi) / w.bankWidth - 1,
      s = t * t * (3 - 2 * t);
    return s + 64 * Number.EPSILON <= 2 / 3;
  };
  if (!dry(0, L.minDryBankWidth, minimum))
    reject(
      "water-bank",
      "Current base/profile cannot certify the full continuous 0.2 dry collar; bankWidth unchanged",
    );
  let dryCells = 0;
  const active = new Uint8Array(prep.cells.length);
  for (let j = 0; j < prep.cells.length; j++) {
    const c = prep.cells[j];
    if (c.low < 0) active[j] = 1;
    if (dry(c.low, c.high, c.min)) dryCells++;
  }
  const fraction =
    (dryCells * input.spacing ** 2) / (p.domain.width * p.domain.depth);
  if (fraction < L.minDryAreaFraction)
    reject(
      "water-dry-area",
      "Certified continuously dry whole cells cover less than 25%; finer spacing may resolve conservative cell coverage",
    );
  const model: Extract<HeightModel, { kind: "water-profile" }> = {
    kind: "water-profile",
    version: 1,
    baseHeights: input.heights.slice(),
    water,
  };
  const heights = new Float32Array(data.h.length),
    normals = new Float32Array(data.h.length * 3),
    wet = new Uint8Array(data.h.length);
  let cut = 0,
    fill = 0,
    deep = false;
  for (let i = 0; i < heights.length; i++) {
    const d = prep.distances[i],
      q = evaluateWaterProfile(input, model, data.x[i], data.z[i], d);
    if (d.classification === "uncertain")
      reject(
        "water-precision",
        "A grid node's strict wet/dry classification cannot be resolved at the bounded cubic precision; no width tolerance was applied",
      );
    const isWet = d.classification === "wet";
    wet[i] = +isWet;
    // Caches may round. Consumers MUST query model authority, not interpolate these arrays.
    heights[i] = q.height;
    normals.set(q.normal.map(quantizeGeometry), 3 * i);
    const delta = q.height - data.h[i];
    cut += Math.max(0, -delta) * data.area[i];
    fill += Math.max(0, delta) * data.area[i];
    if (d.upper <= -(w.mode === "river" ? w.width / 8 : w.bankWidth))
      deep = true;
  }
  const seed = wet.findIndex((v) => v === 1);
  if (seed < 0 || !deep)
    reject(
      "water-resolution",
      "Actual grid has no resolved wet/deep sample; use a finer spacing or wider domain without silently changing it",
    );
  const visited = new Uint8Array(wet.length),
    queue = [seed];
  visited[seed] = 1;
  for (let j = 0; j < queue.length; j++)
    for (const i of neighbors(queue[j], input.nx, input.nz))
      if (wet[i] && !visited[i]) {
        visited[i] = 1;
        queue.push(i);
      }
  if (wet.some((v, i) => !!v && !visited[i]))
    reject(
      "water-connectivity",
      "Actual grid samples split the continuous water domain; spacing unchanged",
    );
  if (w.mode === "river")
    for (const [u, v] of [w.controlPoints[0], w.controlPoints.at(-1)!]) {
      const ex = (u - 0.5) * p.domain.width,
        ez = (v - 0.5) * p.domain.depth;
      if (
        !queue.some(
          (i) =>
            (u === 0 || u === 1 ? data.x[i] === ex : data.z[i] === ez) &&
            Math.hypot(data.x[i] - ex, data.z[i] - ez) <= w.width / 2,
        )
      )
        reject(
          "water-connectivity",
          "Actual wet samples do not reach both requested ports",
        );
    }
  const points =
    prep.geometry.mode === "river"
      ? prep.geometry.cubics.flat()
      : prep.geometry.polygon;
  const reach = w.bankWidth + (w.mode === "river" ? w.width / 2 : 0);
  const bounds = {
    min: [
      Math.max(
        -p.domain.width / 2,
        Math.min(...points.map((v) => v[0])) - reach,
      ),
      Math.max(
        -p.domain.depth / 2,
        Math.min(...points.map((v) => v[1])) - reach,
      ),
    ] as Vec2,
    max: [
      Math.min(
        p.domain.width / 2,
        Math.max(...points.map((v) => v[0])) + reach,
      ),
      Math.min(
        p.domain.depth / 2,
        Math.max(...points.map((v) => v[1])) + reach,
      ),
    ] as Vec2,
  };
  return {
    field: { ...input, heights, normals, heightModel: model },
    wetMask: wet,
    active,
    banks: {
      dryAreaFraction: fraction,
      minimumDryBank: L.minDryBankWidth,
      numericalBoundaryError: 2e-10,
    },
    cutVolume: cut,
    fillVolume: fill,
    // Zero nodal quadrature does not prove zero continuous modification.
    modifiedBounds: bounds,
  };
}

/** A rigid bilinear proxy can certify a straight channel when the two shores
 * are complete zero-height grid lines and every intervening node is strictly
 * wet. Bilinear convex combinations then prove the entire strip, not samples.
 * Other preserved geometry is conservatively unresolved, never reshaped. */
function preserveBoundary(
  p: PlanDraft,
  w: Present,
  f: TerrainField,
  wet: Uint8Array,
  level: number,
) {
  if (w.mode !== "river")
    reject(
      "water-boundary",
      "Preserved polygon shoreline is not certified by the current bilinear strip proof",
    );
  const points = w.controlPoints.map(([u, v]): Vec2 => [
    (u - 0.5) * p.domain.width,
    (v - 0.5) * p.domain.depth,
  ]);
  const first = points[0],
    last = points.at(-1)!;
  const arithmetic =
    256 *
    Number.EPSILON *
    Math.max(
      1,
      p.domain.width,
      p.domain.depth,
      Math.abs(f.transform?.position[0] ?? 0),
      Math.abs(f.transform?.position[2] ?? 0),
    );
  if (points.some((q) => distance(q, first, last) > arithmetic))
    reject(
      "water-boundary",
      "A preserved bilinear grid cannot certify this requested curved half-width without reshaping",
    );
  const a = gridCoordinates(f, ...first),
    b = gridCoordinates(f, ...last);
  const vertical = Math.abs(a[0] - b[0]) * f.spacing <= arithmetic;
  const horizontal = Math.abs(a[1] - b[1]) * f.spacing <= arithmetic;
  if (!vertical && !horizontal)
    reject(
      "water-boundary",
      "Preserved shoreline is not aligned with a certifiable bilinear grid strip",
    );
  const transverse = vertical ? f.nx : f.nz,
    longitudinal = vertical ? f.nz : f.nx;
  const at = (u: number, v: number) => (vertical ? v * f.nx + u : u * f.nx + v);
  let low = transverse,
    high = -1;
  for (let u = 0; u < transverse; u++)
    for (let v = 0; v < longitudinal; v++)
      if (wet[at(u, v)]) {
        low = Math.min(low, u);
        high = Math.max(high, u);
      }
  if (low < 1 || high >= transverse - 1)
    reject(
      "water-boundary",
      "Preserved wet strip has no complete two-sided shoreline",
    );
  for (let v = 0; v < longitudinal; v++) {
    for (let u = low; u <= high; u++)
      if (!wet[at(u, v)])
        reject(
          "water-boundary",
          "Preserved river has a dry hole or incomplete interior strip",
        );
    for (const u of [low - 1, high + 1])
      if (terrainNodeWorld(f, at(u, v))[1] !== level)
        reject(
          "water-boundary",
          "Preserved continuous half-width does not meet the exact requested level",
        );
  }
  for (const u of [low - 1, high + 1])
    for (const v of [0, longitudinal - 1]) {
      const q = terrainNodeWorld(f, at(u, v));
      if (
        Math.abs(distance([q[0], q[2]], first, last) - w.width / 2) > arithmetic
      )
        reject(
          "water-boundary",
          "Preserved continuous shoreline differs from the requested half-width; proxy and width unchanged",
        );
    }
  return { arithmetic, vertical };
}

function candidate(
  p: PlanDraft,
  w: Present,
  input: TerrainField,
  data: ReturnType<typeof nodeData>,
  distanceField: Float64Array,
  covered: readonly number[],
  support: Uint8Array,
  level: number,
) {
  const n = input.nx * input.nz,
    heights = input.heights.slice(),
    world = data.h;
  const f = { ...input, heights },
    submerged = new Uint8Array(n),
    wet = new Uint8Array(n);
  let seed = -1;
  for (let i = 0; i < n; i++) {
    if (data.valid[i] && world[i] + data.error[i] < level) {
      submerged[i] = 1;
      if (distanceField[i] < -1e-8 && seed < 0) seed = i;
    }
    if (distanceField[i] < -1e-8 && !data.valid[i])
      reject("water-support", "Requested water crosses unsupported terrain");
    if (
      distanceField[i] < -1e-8 &&
      data.error[i] > 0 &&
      world[i] - data.error[i] < level &&
      world[i] + data.error[i] >= level
    )
      reject(
        "water-uncertain",
        "Patch height uncertainty straddles the requested water level",
      );
  }
  if (seed < 0)
    reject(
      "water-resolution",
      "No resolved wet samples; keep the water requirement and choose finer spacing or a wider/deeper domain",
    );
  const queue = [seed];
  wet[seed] = 1;
  for (let q = 0; q < queue.length; q++)
    for (const next of neighbors(queue[q], input.nx, input.nz))
      if (submerged[next] && !wet[next]) {
        wet[next] = 1;
        queue.push(next);
      }
  for (let i = 0; i < n; i++) {
    if (wet[i] && distanceField[i] > 1e-6)
      reject(
        "water-bank",
        "Requested bed spills beyond its shoreline into low ground",
      );
    if (distanceField[i] < -1e-6 && submerged[i] && !wet[i])
      reject(
        "water-connectivity",
        "Requested water is split into disconnected components",
      );
  }
  // The convex bilinear corner bound covers every centerline point in an
  // intersected cell, including positions between curve subdivision samples.
  if (w.mode === "river") {
    for (const j of covered)
      if (
        cellsAt(f, j).some(
          (i) =>
            !data.valid[i] || world[i] + data.error[i] > level - w.depth + 1e-6,
        )
      )
        reject(
          "water-depth",
          "Continuous center bed cannot represent the required depth in the actual bilinear grid; use finer spacing or wider water",
        );
  } else if (
    !queue.some((i) => world[i] + data.error[i] <= level - w.depth + 1e-6)
  )
    reject("water-depth", "Surface basin does not contain the requested depth");
  const active = new Uint8Array((input.nx - 1) * (input.nz - 1));
  for (let j = 0; j < active.length; j++) {
    const ids = cellsAt(f, j);
    if (ids.some((i) => wet[i])) {
      if (ids.some((i) => submerged[i] && !wet[i]))
        reject(
          "water-connectivity",
          "Ambiguous diagonal disconnected wet regions share a bilinear cell",
        );
      active[j] = 1;
    }
  }
  if (input.space === "canonical" && input.proxyError > 0)
    reject(
      "water-uncertain",
      "Existing nonzero proxy error cannot certify the continuous shoreline/connectivity; patch is unchanged and still needs the requested water",
    );
  const boundary = preserveBoundary(p, w, f, wet, level);
  const banks = continuousBanks(
    p,
    w,
    f,
    active,
    wet,
    support,
    data.error,
    level,
    boundary.vertical,
  );
  return {
    field: f,
    wetMask: wet,
    active,
    banks: { ...banks, numericalBoundaryError: boundary.arithmetic },
    cutVolume: 0,
    fillVolume: 0,
    modifiedBounds: null,
  };
}
function gridCoordinates(f: TerrainField, x: number, z: number) {
  const a = terrainNodeWorld(f, 0),
    b = terrainNodeWorld(f, 1),
    c = terrainNodeWorld(f, f.nx),
    xx = b[0] - a[0],
    xz = b[2] - a[2],
    zx = c[0] - a[0],
    zz = c[2] - a[2],
    det = xx * zz - xz * zx,
    dx = x - a[0],
    dz = z - a[2];
  return [(dx * zz - dz * zx) / det, (dz * xx - dx * xz) / det];
}
/** Existing bilinear active-cell membership only, with no support/height query.
 * Consumers require a validated T7 active-cell array; false proves no bilinear
 * water output at this point, not that the point is valid/dry terrain. */
export function isWaterActiveCell(
  f: TerrainField,
  active: Uint8Array,
  x: number,
  z: number,
) {
  const [gx, gz] = gridCoordinates(f, x, z),
    ix = Math.min(f.nx - 2, Math.max(0, Math.floor(gx + 1e-10))),
    iz = Math.min(f.nz - 2, Math.max(0, Math.floor(gz + 1e-10)));
  return !!active[iz * (f.nx - 1) + ix];
}
function outwardFloat(value: number, direction: -1 | 1): number {
  const q = Math.fround(value);
  if (direction < 0 ? q <= value : q >= value) return q;
  if (q === 0) return direction * 2 ** -149;
  f32[0] = q;
  u32[0] += q > 0 ? direction : -direction;
  return f32[0];
}
/** Flat, cloneable AABB tree over the final contour. Each six-number node is
 * [minX,minZ,maxX,maxZ,left,right]; a negative left encodes -(segment+1).
 * Bounds only prune segments that provably cannot improve the exact minimum. */
function indexShore(shore: readonly Segment[]): Float32Array {
  const nodes = new Float32Array((2 * shore.length - 1) * 6);
  let next = 0;
  const build = (ids: number[]): number => {
    const node = next++,
      at = node * 6;
    let minX = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxZ = -Infinity;
    for (const id of ids)
      for (const p of shore[id]) {
        minX = Math.min(minX, p[0]);
        minZ = Math.min(minZ, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxZ = Math.max(maxZ, p[1]);
      }
    nodes.set(
      [
        outwardFloat(minX, -1),
        outwardFloat(minZ, -1),
        outwardFloat(maxX, 1),
        outwardFloat(maxZ, 1),
      ],
      at,
    );
    if (ids.length === 1) {
      nodes[at + 4] = -ids[0] - 1;
      nodes[at + 5] = -1;
    } else {
      const axis = maxX - minX >= maxZ - minZ ? 0 : 1;
      ids.sort(
        (a, b) =>
          shore[a][0][axis] +
            shore[a][1][axis] -
            (shore[b][0][axis] + shore[b][1][axis]) || a - b,
      );
      const mid = Math.floor(ids.length / 2);
      nodes[at + 4] = build(ids.slice(0, mid));
      nodes[at + 5] = build(ids.slice(mid));
    }
    return node;
  };
  build(Array.from({ length: shore.length }, (_, i) => i));
  return nodes;
}
function shoreDistance(domain: WaterDomain, p: Vec2) {
  const { shore, shoreIndex: nodes } = domain;
  const lower = (node: number) => {
    const i = node * 6,
      dx = Math.max(0, nodes[i] - p[0], p[0] - nodes[i + 2]),
      dz = Math.max(0, nodes[i + 1] - p[1], p[1] - nodes[i + 3]);
    return dx * dx + dz * dz;
  };
  let best = Infinity;
  const stack = [0];
  while (stack.length) {
    const node = stack.pop()!;
    if (lower(node) > best) continue;
    const i = node * 6,
      left = nodes[i + 4],
      right = nodes[i + 5];
    if (left < 0) {
      const [a, b] = shore[-left - 1];
      best = Math.min(best, distanceSquared(p, a, b));
    } else if (lower(left) <= lower(right)) stack.push(right, left);
    else stack.push(left, right);
  }
  return Math.sqrt(best);
}
export function sampleWaterDomain(
  solution: WaterSolution,
  x: number,
  z: number,
): Result<{
  wet: boolean | null;
  signedDistance: number;
  distanceError: number;
  classification?: "wet" | "dry" | "boundary" | "uncertain";
}> {
  try {
    const q = sampleTerrainWorld(solution.field, x, z);
    if (!q.ok) return q;
    if (solution.resolvedWater.mode === "none")
      return {
        ok: true,
        value: {
          wet: false,
          signedDistance:
            Math.hypot(
              solution.field.domain.width,
              solution.field.domain.depth,
            ) + 1,
          distanceError: 0,
        },
      };
    if (solution.field.heightModel?.kind === "water-profile") {
      const geometry = profileGeometry(
        solution.field.heightModel.water,
        solution.field.domain,
      );
      if (
        JSON.stringify(geometry) !== JSON.stringify(solution.domain.geometry) ||
        JSON.stringify(solution.resolvedWater) !==
          JSON.stringify(solution.field.heightModel.water)
      )
        reject(
          "water-binding",
          "Analytic domain cache and field source disagree",
        );
      const d = profileDistance(geometry, [x, z]);
      return {
        ok: true,
        value: {
          wet:
            d.classification === "uncertain"
              ? null
              : d.classification === "wet",
          signedDistance: d.signed,
          distanceError: d.error,
          classification: d.classification,
        },
      };
    }
    const wet =
        isWaterActiveCell(solution.field, solution.domain.activeCells, x, z) &&
        q.value.height < solution.resolvedWater.level,
      d = shoreDistance(solution.domain, [x, z]);
    return {
      ok: true,
      value: {
        wet,
        signedDistance: d < 1e-9 ? 0 : wet ? -d : d,
        distanceError: solution.domain.distanceError,
      },
    };
  } catch (e) {
    return failure(e);
  }
}
export function solveWater(
  draft: PlanDraft,
  field: TerrainField,
): Result<WaterSolution> {
  try {
    const p = parsePlanDraft(draft);
    validateInput(p, field);
    const n = field.nx * field.nz,
      w = p.water;
    if (w.mode === "unspecified")
      reject(
        "water-unspecified",
        "Water remains unspecified; select water or none before geometry review",
      );
    const baseReport: WaterReport = {
      algorithmVersion: WATER_ALGORITHM_VERSION,
      levelSource: "absence",
      candidateLevels: [],
      candidates: [],
      components: 0,
      wetNodes: 0,
      dryAreaFraction: 1,
      minimumDryBank: 0,
      numericalBoundaryError: 0,
      modifiedBounds: null,
      summary: "No water; no earthworks.",
      requiresManifestValidation: p.terrain.source === "patch",
    };
    if (w.mode === "none")
      return {
        ok: true,
        value: {
          resolvedWater: { mode: "none" },
          field,
          wetMask: new Uint8Array(n),
          bankMask: new Uint8Array(n),
          shoreDistance: new Float32Array(n).fill(
            Math.hypot(p.domain.width, p.domain.depth) + 1,
          ),
          cutVolume: 0,
          fillVolume: 0,
          domain: {
            version: WATER_ALGORITHM_VERSION,
            geometry: null,
            activeCells: new Uint8Array((field.nx - 1) * (field.nz - 1)),
            shore: [],
            shoreIndex: new Float32Array(0),
            distanceError: 0,
          },
          report: baseReport,
        },
      };
    if (w.mode !== "river" && w.mode !== "surface")
      reject(
        "water-unspecified",
        "Water needs an explicit mode before solving",
      );
    if (p.terrain.source === "patch" && w.reshapePolicy !== "preserve")
      reject("water-policy", "Fixed patches cannot be reshaped");
    const requested = requestedDomain(w, p);
    const geometry = profileGeometry(w, p.domain);
    if (geometry.mode === "river") {
      const proof = certifyRiverStrip(geometry, p.domain, L.minDryBankWidth);
      if (!proof.ok) reject("water-bank", proof.reason);
    }
    const covered =
        w.mode === "river" ? centerlineCells(field, requested.line) : [],
      data = nodeData(field),
      analytic =
        w.reshapePolicy !== "preserve"
          ? analyticPreparation(p, w, field, data, requested)
          : null,
      support = analytic ? null : prepareSupportCells(field, data.valid),
      dist = Float64Array.from({ length: n }, (_, i) =>
        requested.signed([data.x[i], data.z[i]]),
      );
    const originals = [...data.h]
      .filter(
        (h, i) => data.valid[i] && Number.isFinite(h) && h >= -2 && h <= 2,
      )
      .sort((a, b) => a - b);
    if (!originals.length)
      reject(
        "water-support",
        "No supported terrain is available for the requested water",
      );
    const median =
      originals.length % 2
        ? originals[(originals.length - 1) / 2]
        : (originals[originals.length / 2 - 1] +
            originals[originals.length / 2]) /
          2;
    const levels =
      w.level === null
        ? [
            ...new Set([
              ...Array.from({ length: 81 }, (_, i) => (i - 40) / 20),
              originals[0],
              median,
              originals.at(-1)!,
            ]),
          ].sort((a, b) => a - b)
        : [w.level];
    let best:
        | ReturnType<typeof candidate>
        | ReturnType<typeof analyticCandidate>
        | null = null,
      bestLevel = 0;
    const candidates: WaterReport["candidates"] = [];
    for (const level of levels) {
      try {
        const c = analytic
            ? analyticCandidate(p, w, field, data, analytic, level)
            : candidate(p, w, field, data, dist, covered, support!, level),
          volume = c.cutVolume + c.fillVolume;
        candidates.push({ level, feasible: true, reason: null, volume });
        if (
          !best ||
          volume < best.cutVolume + best.fillVolume ||
          (volume === best.cutVolume + best.fillVolume && level < bestLevel)
        ) {
          best = c;
          bestLevel = level;
        }
      } catch (e) {
        if (!(e instanceof WaterError)) throw e;
        candidates.push({
          level,
          feasible: false,
          reason: `${e.code}: ${e.message}`,
          volume: null,
        });
      }
    }
    if (!best)
      reject(
        "water-blocked",
        `Required ${w.mode} remains blocked; no allowed level satisfies geometry and reshape policy. ${candidates
          .map((c) => c.reason)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 4)
          .join(" ")}`,
      );
    const resolvedWater: ScenePlan["water"] = {
      ...w,
      level: bestLevel,
      levelStatus: "resolved",
      levelSource: w.level === null ? "default" : w.levelSource!,
    };
    const finalField =
        best.field.space === "world" &&
        best.field.heightModel.kind !== "water-profile"
          ? { ...best.field, normals: terrainNormals(best.field) }
          : best.field,
      shore = analytic ? [] : contour(finalField, best.active, bestLevel);
    if (!analytic && !shore.length)
      reject("water-contour", "Final water has no bounded shoreline");
    const solution: WaterSolution = {
      resolvedWater,
      field: finalField,
      wetMask: best.wetMask,
      bankMask: new Uint8Array(n),
      shoreDistance: new Float32Array(n),
      cutVolume: best.cutVolume,
      fillVolume: best.fillVolume,
      domain: {
        version: WATER_ALGORITHM_VERSION,
        geometry: analytic?.geometry ?? null,
        activeCells: best.active,
        shore,
        shoreIndex: analytic ? new Float32Array(0) : indexShore(shore),
        distanceError: analytic ? 2e-10 : CONTOUR_ERROR,
      },
      report: {
        ...baseReport,
        ...best.banks,
        levelSource: w.level === null ? "program-suggestion" : "explicit",
        candidateLevels: levels,
        candidates,
        components: 1,
        wetNodes: best.wetMask.reduce((s, v) => s + v, 0),
        modifiedBounds: best.modifiedBounds,
        summary: `${w.level === null ? "Program suggested" : "Explicit"} water level ${bestLevel}; cut ${best.cutVolume}, fill ${best.fillVolume}; continuous dry-bank lower bound ${best.banks.minimumDryBank}.`,
      },
    };
    for (let i = 0; i < n; i++) {
      const signed = analytic?.distances[i].signed;
      const d =
          signed === undefined
            ? shoreDistance(solution.domain, [data.x[i], data.z[i]])
            : Math.abs(signed),
        wet = Boolean(best.wetMask[i]);
      solution.shoreDistance[i] = signed ?? (d < 1e-9 ? 0 : wet ? -d : d);
      const certifiedDry =
        analytic && finalField.heightModel.kind === "water-profile"
          ? analytic.distances[i].classification !== "uncertain" &&
            profileSection(
              data.h[i],
              analytic.distances[i].signed,
              finalField.heightModel.water,
            ).height >= bestLevel
          : terrainNodeWorld(finalField, i)[1] - data.error[i] >= bestLevel;
      if (data.valid[i] && !wet && d <= w.bankWidth && certifiedDry)
        solution.bankMask[i] = 1;
    }
    return { ok: true, value: solution };
  } catch (e) {
    return failure(e);
  }
}
