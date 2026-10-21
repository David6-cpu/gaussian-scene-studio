import { Quaternion, Vector3 } from "three";
import { finite, integer, record } from "../data-validation.ts";
import {
  sparkRendererBudget,
  sparkSceneCapacity,
} from "../gaussian/spark-budget.ts";
import type { SplatSource } from "./asset-loader.ts";
import { parseSurfaceStyle, type SurfaceStyle } from "./asset-manifest.ts";
import {
  GENERAL_LIMITS as L,
  type Result,
  type Vec2,
  type Vec3,
} from "./core.ts";
import {
  sampleTerrainWorld,
  terrainNodeWorld,
  type TerrainField,
} from "./terrain.ts";
import {
  isWaterActiveCell,
  WATER_ALGORITHM_VERSION,
  sampleWaterDomain,
  type WaterSolution,
} from "./water.ts";
import {
  profileBoundaryWitness,
  type ProfileGeometry,
} from "./water-profile.ts";

export const SURFACE_SAMPLER_VERSION = 1;
export const SURFACE_CUTOFF = Math.sqrt(8) + 2.8 / 255 + 64 * Number.EPSILON;
export const SURFACE_RENDER_CONFIG = Object.freeze({
  maxStdDev: Math.sqrt(8),
  minAlpha: 0.5 / 255,
  preBlurAmount: 0,
  blurAmount: 0.3,
  falloff: 1,
  accumExtSplats: false,
  covSplats: false,
  enable2DGS: false,
  lodInflate: false,
  focalDistance: 0,
  apertureAngle: 0,
  enableLod: false,
});
export type SurfaceSampling = SurfaceSupport & {
  version: 1;
  samplerVersion: 1;
  codec: string;
  /** World coordinates. Source transforms must be identity. */
  coordinateSpace: "world";
  waterTiles: { tileId: string; outputIndices: Uint32Array }[];
  observedMaxLogicalRadius: number;
  maxCoordinateError: number;
  maxWorldError: number;
  maxFloat32Error: number;
  maxSourceCenterError: number;
  basePoints: number;
  boundaryPoints: number;
  reservedPoints: number;
  /** Sampler-owned typed scratch peak only; excludes input/output buffers and JS/runtime heaps. */
  peakWorkspaceBytes: number;
  retainedInputBytes: number;
  peakKnownCpuBytes: number;
  surfaceRenderReservationBytes: number;
};
export type SurfaceBuffers = {
  terrain: Map<string, SplatSource>;
  water: SplatSource | null;
  pointCount: number;
  ownedBytes: number;
  /** Runtime observation, not a new persisted Snapshot contract. H consumers require version 1. */
  sampling?: SurfaceSampling;
};
class SurfaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const reject = (code: string, message: string): never => {
  throw new SurfaceError(code, message);
};
const value = <T>(r: Result<T>): T => {
  if (!r.ok)
    reject(r.issues[0].code, r.issues.map((i) => i.message).join("; "));
  return (r as { ok: true; value: T }).value;
};
function parameters(style: SurfaceStyle) {
  const s = parseSurfaceStyle(style),
    p = record(s.parameters, [
      "sampler-version",
      "tangent-scale",
      "normal-scale",
      "opacity",
      "terrain-color",
      "water-color",
      "color-variation",
      "shore-step",
    ]);
  if (p["sampler-version"] !== 1)
    reject("surface-style", "Unsupported surface sampler-version");
  const color = (v: unknown): Vec3 => {
    if (!Array.isArray(v) || v.length !== 3)
      reject("surface-style", "Expected RGB triple");
    return (v as unknown[]).map((x) => finite(x, 0, 1)) as unknown as Vec3;
  };
  return {
    tangent: finite(p["tangent-scale"], 0.55, 0.85),
    normal: finite(p["normal-scale"], 0.05, 0.18),
    opacity: finite(p.opacity, 0.7, 1),
    terrain: color(p["terrain-color"]),
    water: color(p["water-color"]),
    variation: finite(p["color-variation"], 0, 0.25),
    shore: finite(p["shore-step"], 0.25, 1),
  };
}
const halfClass = (
  globalThis as unknown as {
    Float16Array?: new (length: number) => { [key: number]: number };
  }
).Float16Array;
const halfScratch = halfClass ? new halfClass(1) : null;
const floatScratch = new Float32Array(1),
  bitsScratch = new Uint32Array(floatScratch.buffer);
export const SURFACE_CODEC = `spark-2.3.1/${halfScratch ? "native-f16" : "js-f16-truncate"}/log8`;
/** Mirrors installed Spark 2.3.1's selected center codec; tested against utils.toHalf/fromHalf. */
export function surfaceHalf(value: number): number {
  finite(value, -65504, 65504);
  if (halfScratch) {
    halfScratch[0] = value;
    return halfScratch[0];
  }
  floatScratch[0] = value;
  const b = bitsScratch[0],
    sign = b >>> 31 ? -1 : 1,
    exponent = ((b >>> 23) & 255) - 127,
    fraction = b & 0x7fffff;
  if (exponent < -24) return sign * 0;
  if (exponent < -14)
    return sign * ((fraction | 0x800000) >>> (-exponent - 1)) * 2 ** -24;
  return sign * (1 + (fraction >>> 13) / 1024) * 2 ** exponent;
}
export function surfacePackedSigma(sigma: number): number {
  finite(sigma, Math.exp(-12), Math.exp(9));
  const k = Math.min(
    254,
    Math.max(0, Math.round((Math.log(sigma) + 12) * (254 / 21))),
  );
  return Math.exp(-12 + k * (21 / 254));
}
/** Finite logical source support, NOT arbitrary-camera pixel or renderer-world support. */
export function surfacePackedSupport(
  center: Vec3,
  scales: Vec3,
  uncertainty = 0,
) {
  finite(uncertainty, 0);
  const centerError = Math.hypot(...center.map((x) => surfaceHalf(x) - x)),
    sigma = Math.max(...scales.map(surfacePackedSigma));
  const radius = centerError + SURFACE_CUTOFF * sigma + uncertainty;
  return {
    centerError,
    maxSigma: sigma,
    radius: radius + 64 * Number.EPSILON * Math.max(1, radius),
  };
}
export type SurfaceSupportField = Pick<
  TerrainField,
  "spacing" | "heightModel" | "proxyError" | "transform" | "space"
>;
export type SurfaceSupport = {
  supportPolicy: "general-surface-support-v1";
  maxLogicalRadius: number;
  candidateLogicalRadius: number;
  nominalErrorBound: number;
  normalReach: number;
  shorelineReach: 0;
  shoreStep: number;
};
const ulp = (bound: number, bits: number, minimum: number) =>
  Math.max(minimum, 2 ** (Math.floor(Math.log2(Math.abs(bound))) - bits));
/** Replayable v1 envelope. No solver, sampling, geometry regeneration or runtime codec choice.
 * Inputs are verified stored float14 sources, original style and saved field descriptor.
 * Actual ownership is restored from SurfaceResult.tiles, never guessed here. */
export function analyzeSurfaceSupport(
  sources: readonly SplatSource[],
  field: SurfaceSupportField,
  style: SurfaceStyle,
): Result<SurfaceSupport> {
  try {
    const p = parameters(style),
      spacing = finite(field.spacing, 0.1, 0.2),
      scale = field.transform
        ? finite(field.transform.scale, Number.MIN_VALUE)
        : 1,
      worldSpacing = spacing * scale;
    if (![0.1, 0.2].includes(spacing))
      reject("surface-support-version", "Unsupported grid spacing");
    const model = field.heightModel;
    if (
      model.kind !== "bilinear" &&
      (model.kind !== "water-profile" || model.version !== 1)
    )
      reject("surface-support-version", "Unknown saved height profile");
    if (
      model.kind === "water-profile" &&
      (field.space !== "world" || field.transform)
    )
      reject(
        "surface-support-version",
        "Analytic profile cannot transform a patch",
      );
    const xzStretch = field.transform
      ? Math.hypot(
          1 - 2 * field.transform.quaternion[1] ** 2,
          2 * field.transform.quaternion[1] * field.transform.quaternion[3],
        )
      : 1;
    finite(xzStretch, Number.MIN_VALUE);
    const epsilon = Number.EPSILON,
      xzBound = L.maxExtent / 2,
      heightBound = Math.max(
        Math.abs(L.minElevation),
        Math.abs(L.maxElevation),
      );
    // Each two nominal coordinates rounding to the same Float32 lie in one bin.
    // Full ULPs also cover asymmetric bins at powers of two and Float32 conversion.
    const xzUlp = ulp(xzBound, 23, 2 ** -149),
      heightUlp = ulp(heightBound, 23, 2 ** -149);
    const float32Bound = Math.hypot(xzUlp, heightUlp, xzUlp);
    // Bilinear derivatives are convex combinations of adjacent height differences.
    let slopeBound = (2 * heightBound * Math.SQRT2) / spacing,
      worldError = finite(field.proxyError, 0) * scale;
    let witnessError = 1e-4; // T7 general-water-hermite-profile-v5 CONTOUR_ERROR, in world units.
    if (model.kind === "water-profile") {
      const w = model.water,
        level = finite(w.level, -2, 2),
        depth = finite(w.depth, 0.05, 0.5),
        bank = finite(w.bankWidth, 0.2, 1),
        reach = w.mode === "river" ? finite(w.width, 0.4, 2) / 8 : bank;
      const lipschitz = Math.max(
        (1.5 * depth) / reach,
        (9 * (heightBound + Math.abs(level))) / bank,
      );
      // closestCubics stops at best + round - low <= 1e-10, round=512ε*scale.
      // Its returned signed/lower/upper each subtract radius, so retain round
      // and subtraction rounding as well as the stop width. Controls are at
      // most maxExtent/6 beyond endpoints (tangents use adjacent differences).
      // The global height bound also covers all permitted future brush bases.
      const controlBound = xzBound + L.maxExtent / 6;
      const distanceError =
        1e-10 +
        512 * epsilon * controlBound +
        8 * epsilon * (2 * Math.SQRT2 * controlBound + 1);
      worldError +=
        1024 * epsilon * Math.max(1, heightBound, Math.abs(level)) +
        lipschitz * distanceError;
      slopeBound = 2 * slopeBound + lipschitz;
      witnessError = 1024 * epsilon * Math.max(1, xzBound);
    }
    const coordinateError = witnessError + Math.SQRT2 * xzUlp;
    const nominalErrorBound =
      coordinateError * (1 + slopeBound) +
      float32Bound +
      worldError +
      256 * epsilon;
    const maxScale = Math.fround(worldSpacing * p.tangent);
    finite(maxScale, Math.exp(-12), Math.exp(9));
    const padding = (radius: number) =>
      radius + 256 * epsilon * Math.max(1, radius);
    const sourceHalfBound = (p: readonly number[]) =>
      Math.hypot(...p.map((x) => ulp(x, 10, 2 ** -24)));
    const candidateLogicalRadius = padding(
      sourceHalfBound([xzBound, heightBound, xzBound]) +
        SURFACE_CUTOFF * surfacePackedSigma(maxScale) +
        nominalErrorBound,
    );
    let maxLogicalRadius = 0,
      total = 0;
    for (const source of sources) {
      if (source.kind !== "float14")
        throw new SurfaceError(
          "surface-support-source",
          "Support policy requires float14 sources",
        );
      if (
        !(source.data instanceof Float32Array) ||
        source.data.length !== source.count * 14
      )
        reject(
          "surface-support-source",
          "Support policy requires exact float14 source buffers",
        );
      integer(source.count, 1, L.maxWorstSplats);
      total += source.count;
      if (total > L.maxWorstSplats)
        reject("surface-support-source", "Stored surface points exceed limit");
      for (let i = 0; i < source.count; i++) {
        const o = i * 14,
          d = source.data;
        // The finite cutoff proof only covers source opacity <= 1.
        finite(d[o + 13], 0, 1);
        const center = [
          finite(d[o], -xzBound, xzBound),
          finite(d[o + 1], -heightBound, heightBound),
          finite(d[o + 2], -xzBound, xzBound),
        ];
        const sigma = Math.max(
          ...[3, 4, 5].map((k) =>
            surfacePackedSigma(finite(d[o + k], Math.exp(-12), maxScale)),
          ),
        );
        maxLogicalRadius = Math.max(
          maxLogicalRadius,
          padding(
            sourceHalfBound(center) +
              SURFACE_CUTOFF * sigma +
              nominalErrorBound,
          ),
        );
      }
    }
    if (maxLogicalRadius > candidateLogicalRadius)
      reject(
        "surface-support-bound",
        "Stored source exceeds candidate support bound",
      );
    return {
      ok: true,
      value: {
        supportPolicy: "general-surface-support-v1",
        maxLogicalRadius,
        candidateLogicalRadius,
        nominalErrorBound,
        normalReach: (2 * Math.SQRT2 + 0.5) * worldSpacing * xzStretch,
        shorelineReach: 0,
        shoreStep: worldSpacing * p.shore,
      },
    };
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          code: e instanceof SurfaceError ? e.code : "surface-support-input",
          path: "surfaces.support",
          message:
            e instanceof Error ? e.message : "Invalid stored surface support",
        },
      ],
    };
  }
}

function inputBytes(solution: WaterSolution) {
  const seen = new Set<ArrayBufferLike>();
  const walk = (v: unknown): number => {
    if (ArrayBuffer.isView(v)) {
      if (seen.has(v.buffer)) return 0;
      seen.add(v.buffer);
      return v.buffer.byteLength;
    }
    if (v && typeof v === "object")
      return Object.values(v).reduce<number>((n, x) => n + walk(x), 0);
    return 0;
  };
  return walk(solution);
}
function shoreParts(solution: WaterSolution, step: number) {
  const g = solution.domain.geometry;
  const parts: { segment: number; side: -1 | 1; intervals: number }[] = [];
  let reserved = 0;
  const add = (segment: number, side: -1 | 1, length: number) => {
    const intervals = Math.max(1, Math.ceil(finite(length, 0) / step));
    reserved += intervals + 1;
    if (reserved > 16384)
      reject(
        "surface-refinement-budget",
        "Shoreline reservation exceeds 16384 witnesses",
      );
    parts.push({ segment, side, intervals });
  };
  if (solution.resolvedWater.mode === "none")
    return { parts, reserved, geometry: null };
  if (g?.mode === "river")
    g.cubics.forEach((b, i) => {
      // T7 certifies curvature radius >= width: offset derivative <= 1.5*center derivative.
      const length =
        4.5 *
        Math.max(
          ...[0, 1, 2].map((k) =>
            Math.hypot(b[k + 1][0] - b[k][0], b[k + 1][1] - b[k][1]),
          ),
        );
      add(i, -1, length);
      add(i, 1, length);
    });
  else if (g?.mode === "surface")
    g.polygon.forEach((p, i) => {
      const q = g.polygon[(i + 1) % g.polygon.length];
      add(i, 1, Math.hypot(q[0] - p[0], q[1] - p[1]));
    });
  else
    solution.domain.shore.forEach(([a, b], i) =>
      add(i, 1, Math.hypot(b[0] - a[0], b[1] - a[1])),
    );
  return { parts, reserved, geometry: g };
}
function witness(
  solution: WaterSolution,
  g: ProfileGeometry | null,
  segment: number,
  t: number,
  side: -1 | 1,
) {
  if (g) return profileBoundaryWitness(g, segment, t, side);
  const [a, b] = solution.domain.shore[segment];
  return {
    point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] as Vec2,
    coordinateError: solution.domain.distanceError,
  };
}

/** Pure deterministic sampling. Counts all new points before output allocation; never changes source geometry. */
export function sampleSurfaces(
  solution: WaterSolution,
  style: SurfaceStyle,
  budget: number,
): Result<SurfaceBuffers> {
  try {
    integer(budget, 0, L.maxWorstSplats);
    const p = parameters(style),
      f = solution.field,
      n = integer(f.nx * f.nz, 4, L.maxHeightNodes);
    if (
      f.heightModel.kind !== "bilinear" &&
      (f.heightModel.kind !== "water-profile" || f.heightModel.version !== 1)
    )
      reject("surface-model", "Unsupported height authority");
    if (
      f.heights.length !== n ||
      f.normals.length !== 3 * n ||
      !L.spacings.includes(f.spacing as 0.1 | 0.2)
    )
      reject("surface-grid", "Invalid source grid");
    if (
      f.heightModel.kind === "water-profile" &&
      solution.resolvedWater.mode === "none"
    )
      reject("surface-model", "Water profile cannot represent absent water");
    const policy = value(analyzeSurfaceSupport([], f, style));
    const generated =
      f.space === "world" && f.transform === null && f.patchSupport === null;
    const tiles = [...f.tiles].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    if (
      tiles.length < 1 ||
      tiles.length > 100 ||
      new Set(tiles.map((t) => t.id)).size !== tiles.length
    )
      reject("surface-tiles", "Invalid tile ownership");
    const step = f.spacing * (f.transform?.scale ?? 1) * p.shore,
      shore = shoreParts(solution, step),
      present = solution.resolvedWater.mode !== "none";
    const activePatch = !generated && present;
    if (
      activePatch &&
      (solution.domain.version !== WATER_ALGORITHM_VERSION ||
        !(solution.domain.activeCells instanceof Uint8Array) ||
        solution.domain.activeCells.length !== (f.nx - 1) * (f.nz - 1) ||
        solution.domain.activeCells.some((v) => v !== 0 && v !== 1))
    )
      reject(
        "surface-active-cells",
        "Missing or incompatible authoritative active-cell evidence",
      );
    const reserved =
        (generated ? n : 0) +
        (present ? n : 0) +
        shore.reserved * (generated ? 2 : 1),
      capacity = Math.min(reserved, budget);
    let hashCapacity = 1;
    while (hashCapacity < Math.max(2, capacity * 2)) hashCapacity *= 2;
    const retainedInputBytes = inputBytes(solution);
    // 4 float64 coordinates/error/spacing + owner uint32 + role byte + closed hash uint32.
    const peakWorkspaceBytes =
      capacity * 37 + hashCapacity * 4 + n + tiles.length * 16 + 16;
    if (
      retainedInputBytes + peakWorkspaceBytes + capacity * 60 >
      L.maxCandidateCpuBytes
    )
      reject(
        "surface-memory",
        "Surface input, scratch and output exceed candidate CPU limit",
      );
    const coords = new Float64Array(capacity * 4),
      owners = new Uint32Array(capacity),
      roles = new Uint8Array(capacity),
      table = new Uint32Array(hashCapacity),
      seenNodes = new Uint8Array(n);
    const counts = new Uint32Array(tiles.length * 2),
      offsets = new Uint32Array(tiles.length * 2),
      keyF32 = new Float32Array(2),
      keyBits = new Uint32Array(keyF32.buffer);
    let count = 0,
      basePoints = 0,
      boundaryPoints = 0;
    const insert = (
      x: number,
      z: number,
      error: number,
      spacing: number,
      tile: number,
      role: number,
      boundary: boolean,
    ) => {
      finite(x);
      finite(z);
      finite(error, 0);
      keyF32[0] = x === 0 ? 0 : x;
      keyF32[1] = z === 0 ? 0 : z;
      const fx = keyF32[0],
        fz = keyF32[1];
      let slot =
        (Math.imul(keyBits[0], 0x9e3779b1) ^
          Math.imul(keyBits[1], 0x85ebca6b) ^
          role) &
        (hashCapacity - 1);
      while (table[slot]) {
        const at = table[slot] - 1;
        if (
          roles[at] === role &&
          Math.fround(coords[4 * at]) === fx &&
          Math.fround(coords[4 * at + 1]) === fz
        ) {
          coords[4 * at + 2] = Math.max(
            coords[4 * at + 2],
            error + Math.hypot(x - coords[4 * at], z - coords[4 * at + 1]),
          );
          return;
        }
        slot = (slot + 1) & (hashCapacity - 1);
      }
      if (count >= capacity)
        reject(
          "surface-point-budget",
          `Actual surface sampling exceeds supplied budget ${budget}`,
        );
      table[slot] = count + 1;
      coords.set([x, z, error, spacing], 4 * count);
      owners[count] = tile;
      roles[count] = role;
      counts[tile * 2 + role]++;
      count++;
      if (boundary) boundaryPoints++;
      else basePoints++;
    };
    for (let ti = 0; ti < tiles.length; ti++)
      for (const index of tiles[ti].outputIndices) {
        integer(index, 0, n - 1);
        if (seenNodes[index])
          reject("surface-ownership", "Duplicate terrain outputIndices");
        seenNodes[index] = 1;
        if (!generated && !present) continue;
        const q = terrainNodeWorld(f, index);
        // A successful T7 preserved-water domain already excludes this cell.
        // Patch terrain is retained, so this node needs no new Gaussian/height.
        if (
          activePatch &&
          !isWaterActiveCell(f, solution.domain.activeCells, q[0], q[2])
        )
          continue;
        const sampled = value(sampleTerrainWorld(f, q[0], q[2]));
        if (generated) insert(q[0], q[2], 0, f.spacing, ti, 0, false);
        if (present) {
          const d = value(sampleWaterDomain(solution, q[0], q[2]));
          if (d.wet === null)
            reject(
              "surface-water-uncertain",
              `Unresolved water sample at ${q[0]},${q[2]}`,
            );
          if (d.wet === true)
            insert(
              q[0],
              q[2],
              0,
              f.spacing * (f.transform?.scale ?? 1),
              ti,
              1,
              false,
            );
        }
        finite(sampled.height, -2, 2);
      }
    if (seenNodes.some((x) => x !== 1))
      reject("surface-ownership", "Incomplete terrain outputIndices");
    const owner = (x: number, z: number) => {
      let cx = x,
        cz = z;
      if (f.transform) {
        // Exact inverse of T6's registered raw-D matrix, including permitted
        // quaternion norm tolerance. Three's conjugate is not this inverse.
        const t = f.transform,
          [, y, , w] = t.quaternion,
          c = 1 - 2 * y * y,
          s = 2 * y * w,
          det = c * c + s * s,
          dx = (x - t.position[0]) / t.scale,
          dz = (z - t.position[2]) / t.scale;
        cx = (c * dx - s * dz) / det;
        cz = (s * dx + c * dz) / det;
      }
      const tile = tiles.findIndex(
        (t) =>
          cx >= t.bounds.min[0] - 1e-12 &&
          cz >= t.bounds.min[1] - 1e-12 &&
          (cx < t.bounds.max[0] ||
            (t.bounds.max[0] === f.width / 2 &&
              cx <= t.bounds.max[0] + 1e-12)) &&
          (cz < t.bounds.max[1] ||
            (t.bounds.max[1] === f.depth / 2 && cz <= t.bounds.max[1] + 1e-12)),
      );
      if (tile < 0)
        reject("surface-ownership", "Shoreline has no declared output tile");
      return tile;
    };
    for (const part of shore.parts)
      for (let i = 0; i <= part.intervals; i++) {
        const w = witness(
            solution,
            shore.geometry,
            part.segment,
            i / part.intervals,
            part.side,
          ),
          [x, z] = w.point;
        // Explicit clipping solely to the declared world scene rectangle.
        if (
          Math.abs(x) > f.domain.width / 2 ||
          Math.abs(z) > f.domain.depth / 2
        )
          continue;
        value(sampleTerrainWorld(f, x, z));
        // This is a declared nominal boundary sample, never a strict wet-sign assertion.
        value(sampleWaterDomain(solution, x, z));
        const ti = owner(x, z);
        if (generated) insert(x, z, w.coordinateError, step, ti, 0, true);
        insert(x, z, w.coordinateError, step, ti, 1, true);
      }
    if (present && !counts.some((c, i) => i % 2 === 1 && c > 0))
      reject("surface-empty-water", "Present water produced no samples");
    const terrain = new Map<string, SplatSource>(),
      waterCount = counts.reduce((sum, c, i) => sum + (i % 2 ? c : 0), 0);
    const waterSource = waterCount
      ? {
          kind: "float14" as const,
          count: waterCount,
          data: new Float32Array(waterCount * 14),
        }
      : null;
    const waterTiles: SurfaceSampling["waterTiles"] = [];
    let waterOffset = 0;
    tiles.forEach((tile, i) => {
      if (counts[i * 2])
        terrain.set(tile.id, {
          kind: "float14",
          count: counts[i * 2],
          data: new Float32Array(counts[i * 2] * 14),
        });
      if (counts[i * 2 + 1]) {
        waterTiles.push({
          tileId: tile.id,
          outputIndices: Uint32Array.from(
            { length: counts[i * 2 + 1] },
            (_, j) => waterOffset + j,
          ),
        });
        offsets[i * 2 + 1] = waterOffset;
        waterOffset += counts[i * 2 + 1];
      }
    });
    let maxLogicalRadius = 0,
      maxCoordinateError = 0,
      maxWorldError = 0,
      maxFloat32Error = 0,
      maxSourceCenterError = 0;
    const quat = new Quaternion(),
      up = new Vector3(0, 0, 1),
      v = new Vector3();
    for (let i = 0; i < count; i++) {
      const x = coords[4 * i],
        z = coords[4 * i + 1],
        error = coords[4 * i + 2],
        spacing = coords[4 * i + 3],
        role = roles[i],
        ti = owners[i];
      const q = value(sampleTerrainWorld(f, x, z));
      let tangent = spacing * p.tangent,
        normal: Vec3 = [0, 1, 0],
        height = present
          ? solution.resolvedWater.mode === "none"
            ? 0
            : solution.resolvedWater.level
          : 0;
      if (role === 0) {
        height = q.height;
        normal = q.normal;
        let curvature = 0;
        for (const [dx, dz] of [
          [-f.spacing / 2, 0],
          [f.spacing / 2, 0],
          [0, -f.spacing / 2],
          [0, f.spacing / 2],
        ]) {
          const nx = Math.max(
              -f.domain.width / 2,
              Math.min(f.domain.width / 2, x + dx),
            ),
            nz = Math.max(
              -f.domain.depth / 2,
              Math.min(f.domain.depth / 2, z + dz),
            );
          const reach = Math.hypot(nx - x, nz - z);
          if (reach) {
            const neighbor = value(sampleTerrainWorld(f, nx, nz));
            curvature = Math.max(
              curvature,
              Math.hypot(...normal.map((a, k) => a - neighbor.normal[k])) /
                reach,
            );
          }
        }
        tangent /= 1 + curvature * spacing;
      }
      const thin = Math.min(spacing * p.normal, tangent * 0.25);
      if (Math.min(tangent, thin) < Math.exp(-12))
        reject(
          "surface-scale",
          "Curvature-constrained scale cannot be encoded",
        );
      quat.setFromUnitVectors(up, v.fromArray(normal)).normalize();
      const variation =
        role === 0
          ? 1 +
            p.variation *
              (Math.sin(x * 2.3 + z * 0.7) * Math.cos(z * 1.9 - x * 0.4))
          : 1;
      const color = (role === 0 ? p.terrain : p.water).map((c) =>
        Math.min(1, c * variation),
      );
      const target = role === 0 ? terrain.get(tiles[ti].id)! : waterSource!;
      if (target.kind !== "float14") throw Error("Unexpected source");
      const at = offsets[ti * 2 + role]++ * 14;
      target.data.set(
        [
          x,
          height,
          z,
          tangent,
          tangent,
          thin,
          quat.x,
          quat.y,
          quat.z,
          quat.w,
          ...color,
          p.opacity,
        ],
        at,
      );
      const center = Array.from(
          target.data.subarray(at, at + 3),
        ) as unknown as Vec3,
        scales = Array.from(
          target.data.subarray(at + 3, at + 6),
        ) as unknown as Vec3;
      const floatError = Math.hypot(
          center[0] - x,
          center[1] - height,
          center[2] - z,
        ),
        worldError = role === 0 ? q.worldError : 0;
      const coordinateHeightError =
        role === 0 ? error * (q.slopeBound ?? (4 * Math.SQRT2) / f.spacing) : 0;
      if (
        error + coordinateHeightError + floatError + worldError >
        policy.nominalErrorBound
      )
        reject(
          "surface-support-error",
          "Observed nominal sampling uncertainty exceeds replayable version-1 envelope",
        );
      const packed = surfacePackedSupport(
        center,
        scales,
        error + coordinateHeightError + floatError + worldError,
      );
      maxLogicalRadius = Math.max(maxLogicalRadius, packed.radius);
      maxCoordinateError = Math.max(maxCoordinateError, error);
      maxWorldError = Math.max(maxWorldError, worldError);
      maxFloat32Error = Math.max(maxFloat32Error, floatError);
      maxSourceCenterError = Math.max(maxSourceCenterError, packed.centerError);
    }
    const sources = [
        ...terrain.values(),
        ...(waterSource ? [waterSource] : []),
      ],
      ownedBytes = count * 56 + waterCount * 4;
    const renderCapacity = sparkSceneCapacity(sources.map((s) => s.count)),
      surfaceRenderReservationBytes =
        sparkRendererBudget(renderCapacity).reservedBytes +
        sources.reduce(
          (bytes, s) =>
            bytes + s.count * 56 + Math.ceil(s.count / 2048) * 2048 * 32,
          0,
        );
    const peakKnownCpuBytes =
      retainedInputBytes + peakWorkspaceBytes + ownedBytes;
    if (
      peakKnownCpuBytes > L.maxCandidateCpuBytes ||
      peakKnownCpuBytes + surfaceRenderReservationBytes > L.maxTransitionBytes
    )
      reject(
        "surface-memory",
        "Surface local build/render reservation exceeds limits",
      );
    const support = value(analyzeSurfaceSupport(sources, f, style));
    return {
      ok: true,
      value: {
        terrain,
        water: waterSource,
        pointCount: count,
        ownedBytes,
        sampling: {
          version: 1,
          samplerVersion: 1,
          codec: SURFACE_CODEC,
          coordinateSpace: "world",
          waterTiles,
          ...support,
          observedMaxLogicalRadius: maxLogicalRadius,
          maxCoordinateError,
          maxWorldError,
          maxFloat32Error,
          maxSourceCenterError,
          basePoints,
          boundaryPoints,
          reservedPoints: reserved,
          peakWorkspaceBytes,
          retainedInputBytes,
          peakKnownCpuBytes,
          surfaceRenderReservationBytes,
        },
      },
    };
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          code: e instanceof SurfaceError ? e.code : "surface-input",
          path: "surfaces",
          message: e instanceof Error ? e.message : "Invalid surface input",
        },
      ],
    };
  }
}
