import { evaluateWaterProfile, type HeightModel } from "./water-profile.ts";
import { finite, integer } from "../data-validation.ts";
import { sampleHeight, sampleNormal } from "../terrain/heightfield.ts";
import type { PatchProxy } from "./asset-loader.ts";
import {
  inspectCpuBuffer,
  parseEditableState,
  parsePlanDraft,
  type EditableState,
  type HeightGridResult,
  type PlanDraft,
  type ScenePlan,
} from "./contracts.ts";
import { quantizeGeometry } from "./canonical.ts";
import { randomSample } from "./random.ts";
import {
  GENERAL_LIMITS as L,
  type Result,
  type Transform,
  type Vec2,
  type Vec3,
} from "./core.ts";

/** Generated value-noise (smoothstep, doubling frequency/halving weight), radial
 * smoothstep brushes, 1e-6 sample quantization; no scene-dependent normalization.
 * Tile IDs are domain-origin-relative; changing the domain is a global edit.
 */
export const TERRAIN_ALGORITHM_VERSION = "general-terrain-v1" as const;
export type TerrainTile = Omit<HeightGridResult["tiles"][number], "digest">;
export type TerrainField = Omit<HeightGridResult, "digest" | "tiles"> & {
  /** World scene rectangle. Canonical patch grid width/depth are separate. */
  domain: PlanDraft["domain"];
  tiles: TerrainTile[];
  /** Geometric proxy support only. Manifest waterMask/edgeBuffer remain T9's responsibility. */
  patchSupport: Pick<PatchProxy, "validPolygon" | "voidMask"> | null;
};
export type TerrainSample = {
  height: number;
  normal: Vec3;
  worldError: number;
  /** Conservative slope for safety consumers; analytic normals are nominal. */
  slopeBound?: number;
};
type Grid = Pick<
  TerrainField,
  "width" | "depth" | "spacing" | "nx" | "nz" | "heights"
> & { heightModel?: HeightModel };
class TerrainError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}
const reject = (code: string, path: string, message: string): never => {
  throw new TerrainError(code, path, message);
};
const failure = (e: unknown): Result<never> => ({
  ok: false,
  issues: [
    {
      code: e instanceof TerrainError ? e.code : "terrain-input",
      path: e instanceof TerrainError ? e.path : "terrain",
      message: e instanceof Error ? e.message : "Invalid terrain input",
    },
  ],
});
// Existing canonical grid/support coordinate tolerance; not a proxy measurement error.
const QUERY_COORDINATE_TOLERANCE = 1e-9;
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function noise(seed: number, x: number, z: number, octave: number): number {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    u = smooth(x - ix),
    v = smooth(z - iz);
  const at = (a: number, b: number) =>
    2 * randomSample(seed, `${a},${b}`, `terrain-noise:${octave}`, 0) - 1;
  return lerp(
    lerp(at(ix, iz), at(ix + 1, iz), u),
    lerp(at(ix, iz + 1), at(ix + 1, iz + 1), u),
    v,
  );
}
function dimensions(width: number, depth: number, spacing: number) {
  finite(width, L.minExtent, L.maxExtent);
  finite(depth, L.minExtent, L.maxExtent);
  if (!L.spacings.some((s) => s === spacing))
    reject("terrain-input", "terrain.spacing", "Unsupported terrain spacing");
  const nx = Math.round(width / spacing) + 1,
    nz = Math.round(depth / spacing) + 1;
  if (
    Math.abs((nx - 1) * spacing - width) > 1e-9 ||
    Math.abs((nz - 1) * spacing - depth) > 1e-9 ||
    nx * nz > L.maxHeightNodes
  )
    reject(
      "terrain-budget",
      "terrain",
      "Spacing must divide extents within 10,201 nodes",
    );
  return { nx, nz };
}
/** Bounds include shared edges; east/north tiles own those edges except at the far scene boundary. */
function tileLayout(
  width: number,
  depth: number,
  spacing: number,
  nx: number,
  nz: number,
) {
  const result: {
    id: string;
    bounds: TerrainTile["bounds"];
    x0: number;
    x1: number;
    z0: number;
    z1: number;
    ox1: number;
    oz1: number;
  }[] = [];
  const txCount = Math.ceil(width),
    tzCount = Math.ceil(depth);
  for (let tz = 0; tz < tzCount; tz++)
    for (let tx = 0; tx < txCount; tx++) {
      const x0 = Math.round(tx / spacing),
        z0 = Math.round(tz / spacing),
        x1 = Math.min(nx - 1, Math.round((tx + 1) / spacing)),
        z1 = Math.min(nz - 1, Math.round((tz + 1) / spacing));
      result.push({
        id: `tile:${tx}:${tz}`,
        bounds: {
          min: [
            quantizeGeometry(-width / 2 + x0 * spacing),
            quantizeGeometry(-depth / 2 + z0 * spacing),
          ],
          max: [
            quantizeGeometry(-width / 2 + x1 * spacing),
            quantizeGeometry(-depth / 2 + z1 * spacing),
          ],
        },
        x0,
        x1,
        z0,
        z1,
        ox1: tx === txCount - 1 ? x1 : x1 - 1,
        oz1: tz === tzCount - 1 ? z1 : z1 - 1,
      });
    }
  return result;
}
function byteBudget(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes > L.maxCandidateCpuBytes)
    reject(
      "terrain-budget",
      "terrain",
      "Terrain arrays and retained proxy exceed the 128 MiB candidate budget",
    );
}
/** Shared global finite differences use a one-node halo, never per-tile edge derivatives. */
export function terrainNormals(field: Grid): Float32Array {
  const { nx, nz } = dimensions(field.width, field.depth, field.spacing),
    meta = inspectCpuBuffer(field.heights);
  if (
    field.nx !== nx ||
    field.nz !== nz ||
    meta.format !== "f32le" ||
    meta.length !== nx * nz
  )
    reject(
      "terrain-input",
      "terrain.heights",
      "Invalid grid dimensions/buffer",
    );
  byteBudget(meta.backingByteLength + nx * nz * 3 * 4);
  const grid = { ...field, heights: meta.value as Float32Array };
  for (const h of grid.heights) finite(h);
  const normals = new Float32Array(nx * nz * 3);
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const n =
          field.heightModel?.kind === "water-profile"
            ? evaluateWaterProfile(
                field,
                field.heightModel,
                quantizeGeometry(-field.width / 2 + ix * field.spacing),
                quantizeGeometry(-field.depth / 2 + iz * field.spacing),
              ).normal
            : sampleNormal(grid, ix, iz),
        off = 3 * (iz * nx + ix);
      for (let k = 0; k < 3; k++) normals[off + k] = quantizeGeometry(n[k]);
    }
  return normals;
}
// The same rotation matrix as the persisted grid contract. Exact inverse handles
// the small quaternion-unit tolerance without silently normalizing the registered D.
function yaw(t: Transform) {
  if (t.quaternion[0] !== 0 || t.quaternion[2] !== 0)
    reject(
      "patch-transform",
      "terrain.transform",
      "Tilted patch height support is not supported; preserve the registered transform and choose an up-preserving patch",
    );
  const [, y, , w] = t.quaternion,
    c = 1 - 2 * y * y,
    s = 2 * y * w,
    determinant = c * c + s * s;
  if (!Number.isFinite(determinant) || determinant <= 0)
    reject(
      "patch-transform",
      "terrain.transform",
      "Invalid fixed patch rotation",
    );
  return { c, s, determinant };
}
/** Bound canonical-coordinate roundoff for the complete forward/inverse map.
 * c/s are the registered matrix coefficients used by both maps, never normalized.
 * A conservative operation budget is 5 forward scalar operations (two products,
 * sum, scale, translation), 2 inverse subtraction/division operations, 4 inverse
 * products/sum/determinant-division operations, and 3 determinant operations.
 * gamma(16) leaves two operations of slack. u=EPSILON/2 is binary64 unit roundoff.
 *
 * Taking absolute values before cancellation bounds the inverse numerator by
 * ||A^-1||inf * (2*||translation||inf/scale + ||A||inf*||grid||inf).
 * This includes translation rounding and the later subtract/divide; checking
 * distinct nodes alone would miss between-node and near-boundary query error.
 * The extra MIN_VALUE term conservatively covers subnormal absolute roundoff.
 * This proves grid distinguishability/existing query precision, not survey error.
 */
function validateWorldGridPrecision(
  transform: Transform,
  rotation: ReturnType<typeof yaw>,
  width: number,
  depth: number,
  spacing: number,
): void {
  const u = Number.EPSILON / 2,
    gamma = (16 * u) / (1 - 16 * u),
    matrixNorm = Math.abs(rotation.c) + Math.abs(rotation.s),
    inverseNorm = matrixNorm / rotation.determinant,
    translation = Math.max(
      Math.abs(transform.position[0]),
      Math.abs(transform.position[2]),
    ),
    gridRadius = Math.max(width, depth) / 2,
    magnitude =
      inverseNorm *
      ((2 * translation) / transform.scale + matrixNorm * gridRadius),
    roundoff =
      gamma * magnitude +
      ((16 * Number.MIN_VALUE) / transform.scale) * inverseNorm;
  if (
    !Number.isFinite(roundoff) ||
    roundoff > QUERY_COORDINATE_TOLERANCE ||
    2 * roundoff >= spacing
  )
    reject(
      "patch-transform",
      "terrain.transform",
      "Fixed patch world coordinates lose numerical precision; the registered grid cannot support reliable inverse height queries",
    );
}
function pointInPolygon(
  polygon: readonly Vec2[],
  x: number,
  z: number,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j],
      b = polygon[i],
      cross = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (
      Math.abs(cross) <= 1e-9 &&
      x >= Math.min(a[0], b[0]) - 1e-9 &&
      x <= Math.max(a[0], b[0]) + 1e-9 &&
      z >= Math.min(a[1], b[1]) - 1e-9 &&
      z <= Math.max(a[1], b[1]) + 1e-9
    )
      return true;
    if (
      a[1] > z !== b[1] > z &&
      x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function supportPolygon(value: readonly Vec2[]): readonly Vec2[] {
  // Asset manifests permit up to 128 vertices (unlike the 12-point scene polygons).
  if (!Array.isArray(value) || value.length < 3 || value.length > 128)
    reject(
      "terrain-input",
      "terrain.patchSupport",
      "Invalid support polygon size",
    );
  const p = value.map((v) => {
    if (!Array.isArray(v) || v.length !== 2)
      reject(
        "terrain-input",
        "terrain.patchSupport",
        "Invalid support coordinate",
      );
    return [finite(v[0]), finite(v[1])] as Vec2;
  });
  let area = 0;
  const cross = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const on = (a: Vec2, b: Vec2, c: Vec2) =>
    Math.abs(cross(a, b, c)) <= 1e-9 &&
    c[0] >= Math.min(a[0], b[0]) - 1e-9 &&
    c[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    c[1] >= Math.min(a[1], b[1]) - 1e-9 &&
    c[1] <= Math.max(a[1], b[1]) + 1e-9;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    if (a[0] === b[0] && a[1] === b[1])
      reject(
        "terrain-input",
        "terrain.patchSupport",
        "Zero support polygon edge",
      );
    area = finite(area + a[0] * b[1] - a[1] * b[0]);
    for (let j = i + 2; j < p.length; j++)
      if (!(i === 0 && j === p.length - 1)) {
        const c = p[j],
          d = p[(j + 1) % p.length];
        if (
          (Math.sign(cross(a, b, c)) * Math.sign(cross(a, b, d)) < 0 &&
            Math.sign(cross(c, d, a)) * Math.sign(cross(c, d, b)) < 0) ||
          on(a, b, c) ||
          on(a, b, d) ||
          on(c, d, a) ||
          on(c, d, b)
        )
          reject(
            "terrain-input",
            "terrain.patchSupport",
            "Self-intersecting support polygon",
          );
      }
  }
  if (Math.abs(area) <= 1e-9)
    reject("terrain-input", "terrain.patchSupport", "Empty support polygon");
  return Object.freeze(p.map((v) => Object.freeze(v)));
}
export function buildTerrain(
  plan: ScenePlan | PlanDraft,
  state: EditableState,
  patchProxy: PatchProxy | null,
): Result<TerrainField> {
  try {
    const p = parsePlanDraft(plan),
      edits = parseEditableState(state),
      terrain = p.terrain;
    const patch = terrain.source === "patch";
    if (patch !== (patchProxy !== null))
      reject(
        "terrain-input",
        "terrain.source",
        "A patch requires its fixed proxy; a procedural site must not receive one",
      );
    if (patch && edits.brushes.length)
      reject(
        "terrain-input",
        "state.brushes",
        "Rigid patch geometry cannot be brushed",
      );
    const width = patch ? 4 : p.domain.width,
      depth = patch ? 4 : p.domain.depth,
      spacing = terrain.source === "procedural" ? terrain.spacing : 0.1,
      { nx, nz } = dimensions(width, depth, spacing),
      n = nx * nz,
      layout = tileLayout(width, depth, spacing, nx, nz);
    let source: Float32Array | null = null,
      sourceBytes = 0,
      proxyError = 0,
      support: TerrainField["patchSupport"] = null;
    const transform = terrain.source === "patch" ? terrain.transform : null;
    if (patchProxy && transform) {
      if (
        patchProxy.width !== 4 ||
        patchProxy.depth !== 4 ||
        patchProxy.spacing !== 0.1
      )
        reject(
          "terrain-input",
          "terrain.patchProxy",
          "Fixed patch proxy must be canonical 41x41, 4x4 at spacing 0.1",
        );
      if (
        patchProxy.transform.scale !== transform.scale ||
        !transform.position.every(
          (n, i) => patchProxy.transform.position[i] === n,
        ) ||
        !transform.quaternion.every(
          (n, i) => patchProxy.transform.quaternion[i] === n,
        )
      )
        reject(
          "patch-transform",
          "terrain.transform",
          "Plan and verified proxy display transforms must match exactly",
        );
      const rotation = yaw(transform);
      const areaScale = transform.scale ** 2 * rotation.determinant;
      if (!Number.isFinite(areaScale) || spacing ** 2 * 0.25 * areaScale <= 0)
        reject(
          "patch-transform",
          "terrain.transform",
          "Fixed patch transform must yield finite, positive world sample areas",
        );
      for (const x of [-width / 2, width / 2])
        for (const z of [-depth / 2, depth / 2]) {
          if (
            !Number.isFinite(
              transform.position[0] +
                transform.scale * (rotation.c * x + rotation.s * z),
            ) ||
            !Number.isFinite(
              transform.position[2] +
                transform.scale * (-rotation.s * x + rotation.c * z),
            )
          )
            reject(
              "patch-transform",
              "terrain.transform",
              "Fixed patch transform has nonfinite world grid coordinates",
            );
        }
      validateWorldGridPrecision(transform, rotation, width, depth, spacing);
      const meta = inspectCpuBuffer(patchProxy.heights);
      if (meta.format !== "f32le" || meta.length !== n)
        reject(
          "terrain-input",
          "terrain.heights",
          "Fixed proxy must contain 1,681 Float32 heights",
        );
      source = meta.value as Float32Array;
      sourceBytes = meta.backingByteLength;
      proxyError = finite(patchProxy.errorBound, 0, 1000);
      finite(proxyError * transform.scale);
      if (
        !Array.isArray(patchProxy.voidMask) ||
        patchProxy.voidMask.length > 128
      )
        reject("terrain-input", "terrain.patchSupport", "Invalid void masks");
      support = {
        validPolygon: supportPolygon(patchProxy.validPolygon),
        voidMask: Object.freeze(patchProxy.voidMask.map(supportPolygon)),
      };
    }
    // Check known source + output + temporary normal arrays + tile index buffers
    // before allocating any grid-sized output. Whole-scene/transitional accounting is T9/T12.
    const indexCount = layout.reduce(
      (sum, t) =>
        sum +
        (t.x1 - t.x0 + 1) * (t.z1 - t.z0 + 1) +
        (t.ox1 - t.x0 + 1) * (t.oz1 - t.z0 + 1),
      0,
    );
    byteBudget(sourceBytes + n * 4 * 4 + indexCount * 4);
    for (const b of edits.brushes)
      if (
        Math.abs(b.center[0]) + b.radius > width / 2 + 1e-9 ||
        Math.abs(b.center[1]) + b.radius > depth / 2 + 1e-9
      )
        reject(
          "terrain-input",
          "state.brushes",
          "Brush extends outside the scene; do not silently clip its request",
        );
    const heights = new Float32Array(n);
    for (let iz = 0; iz < nz; iz++)
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix,
          x = quantizeGeometry(-width / 2 + ix * spacing),
          z = quantizeGeometry(-depth / 2 + iz * spacing);
        let h: number;
        if (source) {
          h = finite(source[i], -2, 2);
        } else if (terrain.source === "procedural") {
          const angle = (terrain.slopeAzimuthDegrees * Math.PI) / 180;
          h =
            terrain.elevation +
            Math.tan((terrain.slopeDegrees * Math.PI) / 180) *
              (Math.sin(angle) * x + Math.cos(angle) * z);
          if (terrain.noiseAmplitude !== 0) {
            let sum = 0,
              total = 0,
              weight = 1,
              frequency = 1 / terrain.noiseScale;
            for (let octave = 0; octave < terrain.noiseOctaves; octave++) {
              sum +=
                weight * noise(p.seed, x * frequency, z * frequency, octave);
              total += weight;
              weight *= 0.5;
              frequency *= 2;
            }
            h += (terrain.noiseAmplitude * sum) / total;
          }
          for (const b of edits.brushes) {
            const d = Math.hypot(x - b.center[0], z - b.center[1]);
            if (d < b.radius) h += b.delta * (1 - smooth(d / b.radius));
          }
          // Bounds are checked before quantization, not used as clamps.
          if (!Number.isFinite(h) || h < L.minElevation || h > L.maxElevation)
            reject(
              "terrain-elevation",
              `terrain.heights[${i}]`,
              "Generated height is outside [-2,+2]; reduce elevation/slope/noise/brush strength",
            );
          h = quantizeGeometry(h);
        } else {
          throw new TerrainError(
            "terrain-input",
            "terrain.source",
            "Missing fixed patch heights",
          );
        }
        const worldHeight = transform
          ? transform.position[1] + transform.scale * h
          : h;
        if (
          !Number.isFinite(worldHeight) ||
          worldHeight < -2 ||
          worldHeight > 2
        )
          reject(
            "terrain-elevation",
            `terrain.heights[${i}]`,
            "Fixed transformed proxy height is outside [-2,+2]",
          );
        heights[i] = h;
      }
    const tiles = layout.map((t) => {
      const nodes = new Uint32Array((t.x1 - t.x0 + 1) * (t.z1 - t.z0 + 1)),
        out = new Uint32Array((t.ox1 - t.x0 + 1) * (t.oz1 - t.z0 + 1));
      let a = 0,
        b = 0;
      for (let iz = t.z0; iz <= t.z1; iz++)
        for (let ix = t.x0; ix <= t.x1; ix++) {
          const i = iz * nx + ix;
          nodes[a++] = i;
          if (ix <= t.ox1 && iz <= t.oz1) out[b++] = i;
        }
      return {
        id: t.id,
        bounds: t.bounds,
        nodeIndices: nodes,
        outputIndices: out,
      };
    });
    const grid = { width, depth, spacing, nx, nz, heights };
    return {
      ok: true,
      value: {
        ...grid,
        domain: p.domain,
        space: patch ? "canonical" : "world",
        transform,
        layout: "row-major-zx",
        heightModel: { kind: "bilinear" },
        normals: terrainNormals(grid),
        tiles,
        proxyError,
        patchSupport: support,
      },
    };
  } catch (e) {
    return failure(e);
  }
}
function node(field: TerrainField, index: number): [number, number] {
  integer(index, 0, field.nx * field.nz - 1);
  return [
    quantizeGeometry(-field.width / 2 + (index % field.nx) * field.spacing),
    quantizeGeometry(
      -field.depth / 2 + Math.floor(index / field.nx) * field.spacing,
    ),
  ];
}
/** Maps every node, including unsupported ones. Use sampleTerrainWorld to certify support. */
export function terrainNodeWorld(field: TerrainField, index: number): Vec3 {
  const [x, z] = node(field, index),
    h =
      field.heightModel?.kind === "water-profile"
        ? evaluateWaterProfile(field, field.heightModel, x, z).height
        : finite(field.heights[index]),
    t = field.transform;
  if (!t) return [x, h, z];
  const { c, s } = yaw(t);
  return [
    finite(t.position[0] + t.scale * (c * x + s * z)),
    finite(t.position[1] + t.scale * h),
    finite(t.position[2] + t.scale * (-s * x + c * z)),
  ];
}
/** Trapezoid area in world XZ display units (half at edges, quarter at corners).
 * Unsupported/outside nodes still have area; the consumer must gate its integration domain.
 */
export function terrainNodeWorldArea(
  field: TerrainField,
  index: number,
): number {
  node(field, index);
  const ix = index % field.nx,
    iz = Math.floor(index / field.nx),
    t = field.transform;
  return finite(
    field.spacing ** 2 *
      (ix === 0 || ix === field.nx - 1 ? 0.5 : 1) *
      (iz === 0 || iz === field.nz - 1 ? 0.5 : 1) *
      (t ? t.scale ** 2 * yaw(t).determinant : 1),
  );
}
/** One bilinear path for program fields and up-preserving fixed patches.
 * Includes usablePolygon/void checks, NOT manifest waterMask or edgeBuffer admission.
 */
export function sampleTerrainWorld(
  field: TerrainField,
  x: number,
  z: number,
): Result<TerrainSample> {
  try {
    finite(x);
    finite(z);
    if (
      Math.abs(x) > field.domain.width / 2 + 1e-9 ||
      Math.abs(z) > field.domain.depth / 2 + 1e-9
    )
      reject(
        "terrain-support",
        "terrain.domain",
        "World query is outside the scene domain",
      );
    const t = field.transform,
      r = t ? yaw(t) : null;
    let cx = x,
      cz = z;
    if (t && r) {
      const dx = (x - t.position[0]) / t.scale,
        dz = (z - t.position[2]) / t.scale;
      cx = (r.c * dx - r.s * dz) / r.determinant;
      cz = (r.s * dx + r.c * dz) / r.determinant;
    }
    if (
      Math.abs(cx) > field.width / 2 + QUERY_COORDINATE_TOLERANCE ||
      Math.abs(cz) > field.depth / 2 + QUERY_COORDINATE_TOLERANCE
    )
      reject(
        "terrain-support",
        "terrain.grid",
        "World query is outside the transformed proxy grid",
      );
    const support = field.patchSupport;
    if (
      support &&
      (!pointInPolygon(support.validPolygon, cx, cz) ||
        support.voidMask.some((p) => pointInPolygon(p, cx, cz)))
    )
      reject(
        "terrain-support",
        "terrain.patchSupport",
        "World query is outside the usable polygon or inside/on a void",
      );
    if (field.heightModel?.kind === "water-profile") {
      if (t || field.space !== "world")
        reject(
          "terrain-query",
          "terrain.heightModel",
          "Analytic profile cannot transform a patch",
        );
      const q = evaluateWaterProfile(field, field.heightModel, x, z);
      return {
        ok: true,
        value: {
          height: q.height,
          normal: q.normal,
          worldError: q.worldError + field.proxyError,
          slopeBound: q.slopeBound,
        },
      };
    }
    const height = sampleHeight(field, cx, cz),
      gx = Math.max(
        0,
        Math.min(field.nx - 1, (cx + field.width / 2) / field.spacing),
      ),
      gz = Math.max(
        0,
        Math.min(field.nz - 1, (cz + field.depth / 2) / field.spacing),
      ),
      ix = Math.min(field.nx - 2, Math.floor(gx)),
      iz = Math.min(field.nz - 2, Math.floor(gz)),
      tx = gx - ix,
      tz = gz - iz;
    const component = (k: number) => {
      const at = (a: number, b: number) =>
        field.normals[3 * (b * field.nx + a) + k];
      return lerp(
        lerp(at(ix, iz), at(ix + 1, iz), tx),
        lerp(at(ix, iz + 1), at(ix + 1, iz + 1), tx),
        tz,
      );
    };
    let normal: Vec3 = [component(0), component(1), component(2)];
    if (r)
      normal = [
        (r.c * normal[0] + r.s * normal[2]) / r.determinant,
        normal[1],
        (-r.s * normal[0] + r.c * normal[2]) / r.determinant,
      ];
    const length = Math.hypot(...normal);
    if (!Number.isFinite(length) || length === 0)
      reject("terrain-query", "terrain.normals", "Invalid sampled normal");
    normal = [normal[0] / length, normal[1] / length, normal[2] / length];
    return {
      ok: true,
      value: {
        height: finite(t ? t.position[1] + t.scale * height : height),
        normal,
        worldError: finite(field.proxyError * (t?.scale ?? 1), 0),
      },
    };
  } catch (e) {
    return failure(e);
  }
}
