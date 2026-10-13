import type { Vec2, Vec3 } from "./core.ts";

/** v1: original bilinear source + uniform-knot Hermite distance + smoothstep
 * cross-section. Grid heights/normals are caches, never another height source.
 * All data are structured-cloneable; this module has no solver/parser imports. */
export type ProfileWater = {
  waterId: string;
  depth: number;
  bankWidth: number;
  level: number;
  levelStatus: "resolved";
  levelSource: "user" | "model" | "default" | "manual";
  reshapePolicy: "cut-and-fill" | "cut-only";
} & (
  | { mode: "river"; width: number; controlPoints: readonly Vec2[] }
  | { mode: "surface"; polygon: readonly Vec2[] }
);
export type HeightModel =
  | { kind: "bilinear" }
  | {
      kind: "water-profile";
      version: 1;
      baseHeights: Float32Array;
      water: ProfileWater;
    };
export type ProfileGrid = {
  width: number;
  depth: number;
  spacing: number;
  nx: number;
  nz: number;
};
export type Cubic = readonly [Vec2, Vec2, Vec2, Vec2];
export type ProfileGeometry =
  | { mode: "river"; radius: number; cubics: readonly Cubic[] }
  | { mode: "surface"; polygon: readonly Vec2[] };
export type ProfileDistance = {
  signed: number;
  lower: number;
  upper: number;
  error: number;
  gradient: Vec2;
  classification: "wet" | "dry" | "boundary" | "uncertain";
};
const EPS = Number.EPSILON;
const DISTANCE_ACCURACY = 1e-10;
const MAX_WORK = 4096;
const mix = (a: Vec2, b: Vec2, t: number): Vec2 => [
  a[0] + t * (b[0] - a[0]),
  a[1] + t * (b[1] - a[1]),
];
function segment(p: Vec2, a: Vec2, b: Vec2) {
  const x = b[0] - a[0],
    z = b[1] - a[1],
    den = x * x + z * z;
  if (x === 0 && z !== 0) {
    const q = Math.max(
      Math.min(a[1], b[1]),
      Math.min(Math.max(a[1], b[1]), p[1]),
    );
    return {
      point: [a[0], q] as Vec2,
      t: (q - a[1]) / z,
      distance: Math.hypot(p[0] - a[0], p[1] - q),
    };
  }
  if (z === 0 && x !== 0) {
    const q = Math.max(
      Math.min(a[0], b[0]),
      Math.min(Math.max(a[0], b[0]), p[0]),
    );
    return {
      point: [q, a[1]] as Vec2,
      t: (q - a[0]) / x,
      distance: Math.hypot(p[0] - q, p[1] - a[1]),
    };
  }
  const t = den
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * x + (p[1] - a[1]) * z) / den))
    : 0;
  const point = mix(a, b, t);
  return { point, t, distance: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}
export function cubicPoint(b: Cubic, t: number): Vec2 {
  return mix(
    mix(mix(b[0], b[1], t), mix(b[1], b[2], t), t),
    mix(mix(b[1], b[2], t), mix(b[2], b[3], t), t),
    t,
  );
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
export function profileGeometry(
  w:
    | { mode: "river"; width: number; controlPoints: readonly Vec2[] }
    | { mode: "surface"; polygon: readonly Vec2[] },
  grid: Pick<ProfileGrid, "width" | "depth">,
): ProfileGeometry {
  if (w.mode === "surface")
    return {
      mode: "surface",
      polygon: (w as Extract<ProfileWater, { mode: "surface" }>).polygon,
    };
  const river = w as Extract<ProfileWater, { mode: "river" }>;
  const ps = river.controlPoints.map(([x, z]): Vec2 => [
    (x - 0.5) * grid.width,
    (z - 0.5) * grid.depth,
  ]);
  const tangents = ps.map((p, i): Vec2 =>
    i === 0
      ? [ps[1][0] - p[0], ps[1][1] - p[1]]
      : i === ps.length - 1
        ? [p[0] - ps[i - 1][0], p[1] - ps[i - 1][1]]
        : [
            (ps[i + 1][0] - ps[i - 1][0]) / 2,
            (ps[i + 1][1] - ps[i - 1][1]) / 2,
          ],
  );
  return {
    mode: "river",
    radius: river.width / 2,
    cubics: ps
      .slice(1)
      .map((q, i): Cubic => [
        ps[i],
        [ps[i][0] + tangents[i][0] / 3, ps[i][1] + tangents[i][1] / 3],
        [q[0] - tangents[i + 1][0] / 3, q[1] - tangents[i + 1][1] / 3],
        q,
      ]),
  };
}
/** Convex-hull distance to the endpoint chord is a Hausdorff bound in both
 * directions (continuous chord projection spans both endpoints). Upper bounds
 * use actual cubic witnesses. Subdivision stops on a distance interval, never
 * substitutes the chord as geometry. Roundoff is included in every bound. */
function closestCubics(cubics: readonly Cubic[], p: Vec2) {
  const scale = Math.max(
    1,
    ...p.map(Math.abs),
    ...cubics.flat(2).map(Math.abs),
  );
  const round = 512 * EPS * scale;
  let best = Infinity,
    point: Vec2 = [0, 0],
    exactLine = true;
  type Item = { b: Cubic; low: number; depth: number };
  const queue: Item[] = [];
  const add = (b: Cubic, depth: number) => {
    const q = segment(p, b[0], b[3]),
      w = cubicPoint(b, q.t);
    for (const v of [b[0], b[3], w]) {
      const d = Math.hypot(p[0] - v[0], p[1] - v[1]);
      if (d < best) {
        best = d;
        point = v;
      }
    }
    const flat = Math.max(
      segment(b[1], b[0], b[3]).distance,
      segment(b[2], b[0], b[3]).distance,
    );
    if (flat === 0) {
      if (q.distance < best) {
        best = q.distance;
        point = q.point;
      }
      queue.push({ b, depth, low: Math.max(0, q.distance - round) });
    } else {
      exactLine = false;
      queue.push({ b, depth, low: Math.max(0, q.distance - flat - round) });
    }
  };
  for (const b of cubics) add(b, 0);
  let low = 0;
  for (let work = 0; work < MAX_WORK; work++) {
    let at = 0;
    for (let i = 1; i < queue.length; i++)
      if (queue[i].low < queue[at].low) at = i;
    low = queue[at].low;
    if (best + round - low <= DISTANCE_ACCURACY)
      return {
        distance: best,
        lower: low,
        upper: best + round,
        point,
        exactLine,
      };
    const item = queue.splice(at, 1)[0];
    if (item.depth >= 32)
      throw Error(
        "water-precision: cubic distance subdivision depth exhausted",
      );
    for (const b of split(item.b)) add(b, item.depth + 1);
    for (let i = queue.length - 1; i >= 0; i--)
      if (queue[i].low > best + round) queue.splice(i, 1);
  }
  throw Error("water-precision: cubic distance work bound exhausted");
}
export function profileDistance(g: ProfileGeometry, p: Vec2): ProfileDistance {
  let signed: number,
    lower: number,
    upper: number,
    gradient: Vec2,
    boundary = false;
  if (g.mode === "river") {
    const q = closestCubics(g.cubics, p);
    signed = q.distance - g.radius;
    lower = q.lower - g.radius;
    upper = q.upper - g.radius;
    gradient = q.distance
      ? [(p[0] - q.point[0]) / q.distance, (p[1] - q.point[1]) / q.distance]
      : [0, 0];
    // Exact axis-aligned endpoint contact: a supporting half-plane proves the
    // incident cubic cannot enter the tangent disk; distant cubics use a hull
    // lower bound. This resolves equality structurally, not with a tolerance.
    const vx = q.point[0] - p[0],
      vz = q.point[1] - p[1];
    const endpoint = g.cubics.some((b) =>
      [b[0], b[3]].some((v) => v[0] === q.point[0] && v[1] === q.point[1]),
    );
    const contact =
      endpoint &&
      (vx === 0 || vz === 0) &&
      g.cubics.every((b) => {
        if (
          b.every((v) =>
            vx === 0
              ? (v[1] - q.point[1]) * vz >= 0
              : (v[0] - q.point[0]) * vx >= 0,
          )
        )
          return true;
        const flat = Math.max(
          segment(b[1], b[0], b[3]).distance,
          segment(b[2], b[0], b[3]).distance,
        );
        return (
          segment(p, b[0], b[3]).distance -
            flat -
            1024 * EPS * Math.max(1, ...p.map(Math.abs)) >
          g.radius
        );
      });
    boundary = signed === 0 && (q.exactLine || contact);
  } else {
    let best = Infinity,
      point: Vec2 = [0, 0],
      inside = false;
    for (let i = 0, j = g.polygon.length - 1; i < g.polygon.length; j = i++) {
      const a = g.polygon[j],
        b = g.polygon[i],
        q = segment(p, a, b);
      if (q.distance < best) {
        best = q.distance;
        point = q.point;
      }
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
    }
    const sign = inside ? -1 : 1,
      e =
        512 *
        EPS *
        Math.max(1, ...p.map(Math.abs), ...g.polygon.flat().map(Math.abs));
    signed = sign * best;
    lower = signed - e;
    upper = signed + e;
    gradient = best
      ? [(sign * (p[0] - point[0])) / best, (sign * (p[1] - point[1])) / best]
      : [0, 0];
    boundary = best === 0;
  }
  return {
    signed,
    lower,
    upper,
    error: Math.max(signed - lower, upper - signed),
    gradient,
    classification: boundary
      ? "boundary"
      : upper < 0
        ? "wet"
        : lower > 0
          ? "dry"
          : "uncertain",
  };
}
/** At grid seams use the east/north cell, except the far boundary. This is a
 * deterministic one-sided derivative of the original bilinear source. */
export function profileBase(
  grid: ProfileGrid,
  heights: Float32Array,
  x: number,
  z: number,
) {
  const coordinate = (
    p: number,
    extent: number,
    spacing: number,
    count: number,
  ) => {
    const raw = Math.max(0, Math.min(count - 1, (p + extent / 2) / spacing)),
      nearest = Math.round(raw);
    // The terrain contract names decimal grid nodes at 1e-6 precision. Recognize
    // that exact coordinate, not a neighbourhood/tolerance around the seam.
    return p === Math.round((-extent / 2 + nearest * spacing) * 1e6) / 1e6
      ? nearest
      : raw;
  };
  const gx = coordinate(x, grid.width, grid.spacing, grid.nx),
    gz = coordinate(z, grid.depth, grid.spacing, grid.nz);
  const ix = Math.min(grid.nx - 2, Math.floor(gx)),
    iz = Math.min(grid.nz - 2, Math.floor(gz)),
    u = gx - ix,
    v = gz - iz,
    i = iz * grid.nx + ix;
  const a = heights[i],
    b = heights[i + 1],
    c = heights[i + grid.nx],
    d = heights[i + grid.nx + 1];
  let slopeBound = 0;
  const xs = gx === Math.floor(gx) ? [Math.max(0, ix - 1), ix] : [ix];
  const zs = gz === Math.floor(gz) ? [Math.max(0, iz - 1), iz] : [iz];
  for (const sx of xs)
    for (const sz of zs) {
      const j = sz * grid.nx + sx,
        A = heights[j],
        B = heights[j + 1],
        C = heights[j + grid.nx],
        D = heights[j + grid.nx + 1];
      slopeBound = Math.max(
        slopeBound,
        Math.hypot(
          Math.max(Math.abs(B - A), Math.abs(D - C)),
          Math.max(Math.abs(C - A), Math.abs(D - B)),
        ) / grid.spacing,
      );
    }
  return {
    height: (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v,
    gradient: [
      ((b - a) * (1 - v) + (d - c) * v) / grid.spacing,
      ((c - a) * (1 - u) + (d - b) * u) / grid.spacing,
    ] as Vec2,
    slopeBound,
  };
}
const smooth = (t: number) => t * t * (3 - 2 * t);
const derivative = (t: number) => 6 * t * (1 - t);
export function profileSection(old: number, d: number, w: ProfileWater) {
  const l = w.level,
    b = w.bankWidth;
  if (d >= b) return { height: old, pb: 1, pd: 0, pdBound: 0 };
  if (d < 0) {
    const reach = w.mode === "river" ? w.width / 8 : b,
      t = Math.min(1, -d / reach);
    return {
      height: l - w.depth * smooth(t),
      pb: 0,
      pd: t === 1 ? 0 : (w.depth * derivative(t)) / reach,
      pdBound: (1.5 * w.depth) / reach,
    };
  }
  const crest = old >= l ? old : 3 * l - 2 * old,
    cb = old >= l ? 1 : -2,
    t = d / b;
  if (t <= 0.5) {
    const s = smooth(2 * t);
    return {
      height: l + (crest - l) * s,
      pb: cb * s,
      pd: ((crest - l) * derivative(2 * t) * 2) / b,
      pdBound: (3 * Math.abs(crest - l)) / b,
    };
  }
  const s = smooth(2 * t - 1);
  return {
    height: crest + (old - crest) * s,
    pb: cb + (1 - cb) * s,
    pd: ((old - crest) * derivative(2 * t - 1) * 2) / b,
    pdBound: (3 * Math.abs(old - crest)) / b,
  };
}
export function evaluateWaterProfile(
  grid: ProfileGrid,
  model: Extract<HeightModel, { kind: "water-profile" }>,
  x: number,
  z: number,
  precomputed?: ProfileDistance,
) {
  const base = profileBase(grid, model.baseHeights, x, z),
    q =
      precomputed ??
      profileDistance(profileGeometry(model.water, grid), [x, z]);
  const s = profileSection(base.height, q.signed, model.water),
    dx = s.pb * base.gradient[0] + s.pd * q.gradient[0],
    dz = s.pb * base.gradient[1] + s.pd * q.gradient[1],
    size = Math.hypot(dx, 1, dz);
  const arithmetic =
    1024 *
    EPS *
    Math.max(
      1,
      Math.abs(base.height),
      Math.abs(model.water.level),
      Math.abs(s.height),
    );
  // Use a global cross-section derivative bound across the distance interval,
  // including branch/crest crossings; do not relabel numeric error as zero.
  const reach =
    model.water.mode === "river"
      ? model.water.width / 8
      : model.water.bankWidth;
  const lipschitz = Math.max(
    (1.5 * model.water.depth) / reach,
    (9 * Math.abs(base.height - model.water.level)) / model.water.bankWidth,
  );
  return {
    height: s.height,
    normal: [-dx / size, 1 / size, -dz / size] as Vec3,
    worldError: arithmetic + lipschitz * q.error,
    slopeBound: 2 * base.slopeBound + lipschitz,
    distance: q,
  };
}
/** Nominal shoreline display witness, not an assertion that floating coordinates
 * have a decidable strict wet/dry sign. Consumers retain coordinateError and use
 * the same model for H/normal. River end cross-sections are scene portals. */
export function profileBoundaryWitness(
  g: ProfileGeometry,
  segmentIndex: number,
  t: number,
  side: -1 | 1,
): { point: Vec2; coordinateError: number } {
  if (
    !Number.isInteger(segmentIndex) ||
    segmentIndex < 0 ||
    !Number.isFinite(t) ||
    t < 0 ||
    t > 1 ||
    (side !== -1 && side !== 1)
  )
    throw Error("Invalid boundary parameter");
  let point: Vec2;
  if (g.mode === "surface") {
    if (segmentIndex >= g.polygon.length)
      throw Error("Invalid polygon segment");
    point = mix(
      g.polygon[segmentIndex],
      g.polygon[(segmentIndex + 1) % g.polygon.length],
      t,
    );
  } else {
    const b = g.cubics[segmentIndex];
    if (!b) throw Error("Invalid cubic segment");
    const u = 1 - t,
      p = cubicPoint(b, t),
      dx =
        3 *
        (u * u * (b[1][0] - b[0][0]) +
          2 * u * t * (b[2][0] - b[1][0]) +
          t * t * (b[3][0] - b[2][0])),
      dz =
        3 *
        (u * u * (b[1][1] - b[0][1]) +
          2 * u * t * (b[2][1] - b[1][1]) +
          t * t * (b[3][1] - b[2][1]));
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length === 0)
      throw Error("water-precision: zero boundary tangent");
    point = [
      p[0] - (side * g.radius * dz) / length,
      p[1] + (side * g.radius * dx) / length,
    ];
  }
  return {
    point,
    coordinateError: 1024 * EPS * Math.max(1, ...point.map(Math.abs)),
  };
}

// Outward-rounded interval arithmetic for the continuous strip certificate.
// Inputs are the authoritative finite cubic coordinates. Exact zero/identity
// operations retain structural endpoint equalities; no epsilon enlarges a bank.
type Interval = readonly [number, number];
type IntervalPoint = readonly [Interval, Interval];
type IntervalCubic = readonly [
  IntervalPoint,
  IntervalPoint,
  IntervalPoint,
  IntervalPoint,
];
const roundFloat = new Float64Array(1);
const roundBits = new BigUint64Array(roundFloat.buffer);
function outward(x: number, up: boolean) {
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  roundFloat[0] = x;
  roundBits[0] += x > 0 === up ? 1n : -1n;
  return roundFloat[0];
}
const exact = (x: number): Interval => [x, x];
const zero = (a: Interval) => a[0] === 0 && a[1] === 0;
const negate = (a: Interval): Interval => [-a[1], -a[0]];
function plus(a: Interval, b: Interval): Interval {
  if (zero(a)) return b;
  if (zero(b)) return a;
  return [outward(a[0] + b[0], false), outward(a[1] + b[1], true)];
}
function minus(a: Interval, b: Interval): Interval {
  if (a[0] === a[1] && a[0] === b[0] && b[0] === b[1]) return exact(0);
  return plus(a, negate(b));
}
function times(a: Interval, b: Interval): Interval {
  if (zero(a) || zero(b)) return exact(0);
  if (a[0] === 1 && a[1] === 1) return b;
  if (b[0] === 1 && b[1] === 1) return a;
  const values = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [
    outward(Math.min(...values), false),
    outward(Math.max(...values), true),
  ];
}
function intervalMid(a: IntervalPoint, b: IntervalPoint): IntervalPoint {
  return [0, 1].map((k) =>
    a[k][0] === a[k][1] && a[k][0] === b[k][0] && b[k][0] === b[k][1]
      ? a[k]
      : times(plus(a[k], b[k]), exact(0.5)),
  ) as unknown as IntervalPoint;
}
function intervalSplit(b: IntervalCubic): [IntervalCubic, IntervalCubic] {
  const a = intervalMid(b[0], b[1]),
    c = intervalMid(b[1], b[2]),
    d = intervalMid(b[2], b[3]),
    e = intervalMid(a, c),
    f = intervalMid(c, d),
    m = intervalMid(e, f);
  return [
    [b[0], a, e, m],
    [m, f, d, b[3]],
  ];
}
/** Prove C(t)+q*N(t) stays inside every scene half-plane for all |q|<=r.
 * Far hulls use s>=r. Otherwise Bernstein coefficients prove s*|v|±r*u>=0,
 * where s is inward clearance, v the inward-axis derivative and u the transverse
 * derivative. Since |v|<=||C'|| this is sufficient, conservatively stronger than
 * the exact normal condition. Derivative signs must be bounded, never guessed.
 * Degree5 products use integer-scaled Bernstein coefficients (positive scale).
 * DFS uses <=4096 nodes and depth24; an unresolved proof rejects. No dense samples.
 */
export function certifyRiverStrip(
  geometry: Extract<ProfileGeometry, { mode: "river" }>,
  domain: Pick<ProfileGrid, "width" | "depth">,
  bank: number,
): { ok: boolean; reason: string; work: number } {
  const radius = plus(exact(geometry.radius), exact(bank));
  const planes = [
    [0, 1, domain.width / 2],
    [0, -1, domain.width / 2],
    [1, 1, domain.depth / 2],
    [1, -1, domain.depth / 2],
  ] as const;
  let work = 0;
  const planeProved = (
    b: IntervalCubic,
    axis: 0 | 1,
    sign: number,
    extent: number,
  ) => {
    const s = b.map((q) =>
      sign > 0 ? minus(q[axis], exact(-extent)) : minus(exact(extent), q[axis]),
    );
    if (s.every((q) => q[0] >= radius[1])) return true;
    if (s.some((q) => q[0] < 0)) return false;
    let v = b
      .slice(1)
      .map((q, i) => times(minus(q[axis], b[i][axis]), exact(3 * sign)));
    if (v.every((q) => q[1] <= 0)) v = v.map(negate);
    if (!v.every((q) => q[0] >= 0) || v.every(zero)) return false;
    const u = b
      .slice(1)
      .map((q, i) => times(minus(q[1 - axis], b[i][1 - axis]), exact(3)));
    for (let k = 0; k <= 5; k++) {
      let positive = exact(0),
        negative = exact(0);
      for (let i = Math.max(0, k - 2); i <= Math.min(3, k); i++) {
        const j = k - i,
          weight = exact([1, 3, 3, 1][i] * [1, 2, 1][j]),
          sv = times(s[i], v[j]),
          ru = times(radius, u[j]);
        positive = plus(positive, times(weight, plus(sv, ru)));
        negative = plus(negative, times(weight, minus(sv, ru)));
      }
      if (positive[0] < 0 || negative[0] < 0) return false;
    }
    return true;
  };
  // A nonnormal boundary endpoint already has one lateral collar outside the
  // scene. Only its longitudinal terminal cap is truncated, never this collar.
  for (const [b, i, j] of [
    [geometry.cubics[0], 0, 1],
    [geometry.cubics.at(-1)!, 3, 2],
  ] as const)
    for (const [axis, sign, extent] of planes)
      if (sign * b[i][axis] + extent === 0 && b[i][1 - axis] !== b[j][1 - axis])
        return {
          ok: false,
          reason:
            "Oblique terminal tangent has an unsupported lateral dry bank",
          work,
        };
  const visit = (b: IntervalCubic, depth: number): boolean => {
    if (work >= 4096) return false;
    work++;
    if (
      planes.every(([axis, sign, extent]) => planeProved(b, axis, sign, extent))
    )
      return true;
    if (depth >= 24) return false;
    const [a, c] = intervalSplit(b);
    return visit(a, depth + 1) && visit(c, depth + 1);
  };
  for (const b of geometry.cubics) {
    const q = b.map((v) => [
      exact(v[0]),
      exact(v[1]),
    ]) as unknown as IntervalCubic;
    if (!visit(q, 0))
      return {
        ok: false,
        reason:
          "Cannot certify the full continuous lateral dry-bank strip inside the scene within the fixed interval budget",
        work,
      };
  }
  return { ok: true, reason: "Continuous full strip certified", work };
}
