import { Quaternion, Vector3 } from "three";
import type { LoadedAsset } from "./asset-loader";
import type { ObjectManifest } from "./asset-manifest";
import {
  instanceIdFor,
  parseSceneInstance,
  parseEditableState,
  parseScenePlan,
  type EditableState,
  type ScenePlan,
  type SceneInstance,
} from "./contracts";
import {
  GENERAL_LIMITS as L,
  type Issue,
  type Result,
  type Transform,
  type Vec2,
  type Vec3,
} from "./core";
import { allocateSlot, randomSample } from "./random";
import { worldPoint } from "./render/types";
import { sampleTerrainWorld, type TerrainField } from "./terrain";
import { sampleWaterDomain, type WaterSolution } from "./water";
import { profileDistance } from "./water-profile";

export type PlacementResult = {
  instances: SceneInstance[];
  state: EditableState;
  rejections: Record<string, number>;
  shortfall: Record<string, number>;
  attempts: number;
  groupRejections: Record<string, Record<string, number>>;
};
type Group = ScenePlan["groups"][number];
type Envelope = { center: Vec2; radius: number; min: Vec3; max: Vec3 };
const issue = (code: string, path: string, message: string): Issue => ({
  code,
  path,
  message,
});
const refKey = (r: { id: string; contentVersion: string }) =>
  JSON.stringify([r.id, r.contentVersion]);
const radians = (x: number) => (x * Math.PI) / 180;
function edgeDistance(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    den = dx * dx + dz * dz;
  const t =
    den === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / den),
        );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
function polygonDistance(p: Vec2, polygon: readonly Vec2[]) {
  let inside = false,
    distance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j],
      b = polygon[i];
    distance = Math.min(distance, edgeDistance(p, a, b));
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return { inside: inside || distance === 0, distance };
}
/** Conservative disk: no vertex-only polygon test and no center-only void test. */
export function footprintInPolygon(
  polygon: readonly Vec2[],
  center: Vec2,
  radius: number,
) {
  const q = polygonDistance(center, polygon);
  return q.inside && q.distance >= radius;
}
function outsidePolygon(
  polygon: readonly Vec2[],
  center: Vec2,
  radius: number,
) {
  const q = polygonDistance(center, polygon);
  return !q.inside && q.distance > radius;
}
/** Conservative distance margin for T6's closed cross/bbox query. The cross
 * tolerance is area-valued, so short edges need a larger normal-distance margin.
 * gamma(32) covers bounded ordered cross/ray arithmetic; 1e-9 also covers the
 * certified fixed-D inverse coordinate roundoff. No material error is altered. */
function supportQueryMargin(polygon: readonly Vec2[]) {
  const magnitude = Math.max(1, ...polygon.flatMap((p) => p.map(Math.abs)));
  const arithmetic = 32 * Number.EPSILON * magnitude * magnitude;
  return Math.max(
    ...polygon.map((a, i) => {
      const b = polygon[(i + 1) % polygon.length],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return (1e-9 + arithmetic) / length + 4e-9;
    }),
  );
}
function regionPolygon(region: ScenePlan["regions"][number]): readonly Vec2[] {
  const s = region.shape;
  return s.kind === "polygon"
    ? s.polygon
    : [s.min, [s.max[0], s.min[1]], s.max, [s.min[0], s.max[1]]];
}
/** Canonical support is transformed with precisely the same raw quaternion as rendering. */
export function instanceEnvelope(m: ObjectManifest, t: Transform): Envelope {
  const center: Vec2 = [t.position[0], t.position[2]],
    points: Vec3[] = [];
  for (const x of [
    m.coordinates.fullBounds.min[0],
    m.coordinates.fullBounds.max[0],
  ])
    for (const y of [
      m.coordinates.fullBounds.min[1],
      m.coordinates.fullBounds.max[1],
    ])
      for (const z of [
        m.coordinates.fullBounds.min[2],
        m.coordinates.fullBounds.max[2],
      ])
        points.push(worldPoint([x, y, z], m.object.anchor, t));
  const min = ([0, 1, 2] as const).map((k) =>
    Math.min(...points.map((p) => p[k])),
  ) as [number, number, number];
  const max = ([0, 1, 2] as const).map((k) =>
    Math.max(...points.map((p) => p[k])),
  ) as [number, number, number];
  // A tilted object's full volume may overhang its ground footprint.
  const footprint = m.object.footprint.map((p) =>
    worldPoint([p[0], m.object.anchor[1], p[1]], m.object.anchor, t),
  );
  const tilted = Math.abs(t.quaternion[0]) + Math.abs(t.quaternion[2]) > 1e-12;
  const radius = Math.max(
    m.object.collisionRadius * t.scale,
    ...(tilted ? [...points, ...footprint] : footprint).map((p) =>
      Math.hypot(p[0] - center[0], p[2] - center[1]),
    ),
  );
  return { center, radius, min, max };
}
function gridCircle(field: TerrainField, center: Vec2, radius: number) {
  const t = field.transform;
  if (!t) return { center, radius, horizontalScale: 1 };
  const [qx, qy, qz, qw] = t.quaternion;
  if (Math.abs(qx) > 1e-12 || Math.abs(qz) > 1e-12)
    throw Error("Unsupported tilted height query");
  const c = 1 - 2 * qy * qy,
    s = 2 * qy * qw,
    det = c * c + s * s;
  if (!Number.isFinite(det) || det <= 0)
    throw Error("Invalid fixed patch transform");
  const x = (center[0] - t.position[0]) / t.scale,
    z = (center[1] - t.position[2]) / t.scale;
  return {
    center: [(c * x - s * z) / det, (s * x + c * z) / det] as Vec2,
    radius: radius / (t.scale * Math.sqrt(det)),
    horizontalScale: Math.sqrt(det),
  };
}
/** Every bilinear cell intersecting a conservative disk is covered. For analytic
 * water the saved base and the local profile derivatives are authoritative. */
function footprintSlope(solution: WaterSolution, e: Envelope): number {
  const f = solution.field,
    c = gridCircle(f, e.center, e.radius),
    p = c.center,
    r = c.radius;
  const ix0 = Math.max(0, Math.floor((p[0] - r + f.width / 2) / f.spacing));
  const ix1 = Math.min(
    f.nx - 2,
    Math.floor((p[0] + r + f.width / 2) / f.spacing),
  );
  const iz0 = Math.max(0, Math.floor((p[1] - r + f.depth / 2) / f.spacing));
  const iz1 = Math.min(
    f.nz - 2,
    Math.floor((p[1] + r + f.depth / 2) / f.spacing),
  );
  const model = f.heightModel,
    heights = model.kind === "water-profile" ? model.baseHeights : f.heights;
  let maximum = 0;
  for (let iz = iz0; iz <= iz1; iz++)
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = -f.width / 2 + ix * f.spacing,
        z = -f.depth / 2 + iz * f.spacing;
      const xmin = Math.max(x, p[0] - r),
        xmax = Math.min(x + f.spacing, p[0] + r),
        zmin = Math.max(z, p[1] - r),
        zmax = Math.min(z + f.spacing, p[1] + r);
      const nearX = Math.max(xmin, Math.min(xmax, p[0])),
        nearZ = Math.max(zmin, Math.min(zmax, p[1]));
      if (Math.hypot(nearX - p[0], nearZ - p[1]) > r) continue;
      const i = iz * f.nx + ix,
        values = [
          heights[i],
          heights[i + 1],
          heights[i + f.nx],
          heights[i + f.nx + 1],
        ];
      const [a, b, cc, d] = values;
      let bound =
        Math.hypot(
          Math.max(Math.abs(b - a), Math.abs(d - cc)),
          Math.max(Math.abs(cc - a), Math.abs(d - b)),
        ) / f.spacing;
      if (model.kind === "water-profile") {
        if (!solution.domain.geometry)
          throw Error("Missing authoritative profile geometry");
        const q = profileDistance(solution.domain.geometry, [
            (xmin + xmax) / 2,
            (zmin + zmax) / 2,
          ]),
          reach = Math.hypot(xmax - xmin, zmax - zmin) / 2;
        const lo = q.lower - reach,
          hi = q.upper + reach,
          w = model.water,
          bed = w.mode === "river" ? w.width / 8 : w.bankWidth;
        if (hi <= -bed) bound = 0;
        else if (lo < w.bankWidth) {
          // Intervals crossing profile branches take the largest branch derivative.
          const min = Math.min(...values),
            max = Math.max(...values),
            delta = Math.max(Math.abs(min - w.level), Math.abs(max - w.level));
          let pb = 0,
            pd = 0;
          if (lo < 0 && hi > -bed) pd = Math.max(pd, (1.5 * w.depth) / bed);
          if (hi >= 0 && lo <= w.bankWidth / 2) {
            pb = Math.max(pb, min >= w.level ? 1 : 2);
            pd = Math.max(pd, ((min >= w.level ? 3 : 6) * delta) / w.bankWidth);
          }
          if (hi >= w.bankWidth / 2 && lo < w.bankWidth) {
            pb = Math.max(pb, min >= w.level ? 1 : 2);
            if (min < w.level)
              pd = Math.max(pd, (9 * (w.level - min)) / w.bankWidth);
          }
          if (hi >= w.bankWidth) pb = Math.max(pb, 1);
          bound = pb * bound + pd;
        }
      }
      if (!Number.isFinite(bound)) throw Error("Unknown footprint slope");
      maximum = Math.max(maximum, bound / c.horizontalScale);
    }
  return maximum;
}
function admission(m: ObjectManifest, g: Group, t: Transform): Issue | null {
  const p = `instances.${g.groupId}`,
    o = m.object;
  if (
    m.quality.status !== "accepted" ||
    !m.quality.humanReview ||
    !m.quality.operations.includes("place") ||
    m.gaussian.full.quality.status !== "passed" ||
    (m.gaussian.coarse && m.gaussian.coarse.quality.status !== "passed")
  )
    return issue(
      "asset",
      p,
      "Object has no matching admitted placement/LOD capability",
    );
  if (
    t.scale < o.scaleRange[0] ||
    t.scale > o.scaleRange[1] ||
    t.scale < g.scaleRange[0] ||
    t.scale > g.scaleRange[1] ||
    (t.scale !== 1 && !m.quality.operations.includes("uniform-scale"))
  )
    return issue("asset", p, "Uniform scale is outside admitted limits");
  if (g.orientation.mode !== o.rotation)
    return issue("asset", p, "Orientation strategy disagrees with manifest");
  const up = new Vector3(0, 1, 0)
    .applyQuaternion(new Quaternion(...t.quaternion))
    .normalize();
  const tilt = (Math.acos(Math.max(-1, Math.min(1, up.y))) * 180) / Math.PI;
  if (
    tilt > o.maxTiltDegrees + 1e-10 ||
    (o.rotation !== "surface-normal" && tilt > 1e-10)
  )
    return issue("slope", p, "Object tilt exceeds admitted limit");
  const forward = new Vector3(0, 0, 1).applyQuaternion(
    new Quaternion(...t.quaternion),
  );
  const yaw = ((Math.atan2(forward.x, forward.z) * 180) / Math.PI + 360) % 360;
  const close = (a: number, b: number) =>
    Math.abs(((a - b + 540) % 360) - 180) < 1e-8;
  const [low, high] = g.orientation.yawDegrees;
  if (
    !(yaw >= low - 1e-8 && yaw <= high + 1e-8) &&
    !(close(yaw, 360) && high === 360)
  )
    return issue("asset", p, "Yaw is outside plan range");
  if (o.rotation === "fixed") {
    if (low !== high || !o.verifiedYawDegrees.some((v) => close(v, yaw)))
      return issue("asset", p, "Fixed heading is not verified");
  } else if (!m.quality.operations.includes("rotate")) {
    if (!close(yaw, 0) || tilt > 1e-10 || !o.verifiedYawDegrees.includes(0))
      return issue("asset", p, "Rotation is not admitted");
  } else if (m.gaussian.shDegree > 0 && m.gaussian.shRotation === "fixed")
    return issue("asset", p, "Continuous rotation is not SH-safe");
  return null;
}
function constraintIssue(
  plan: ScenePlan,
  solution: WaterSolution,
  m: ObjectManifest,
  g: Group,
  t: Transform,
  patch: LoadedAsset | undefined,
): Issue | null {
  const path = `instances.${g.groupId}`,
    e = instanceEnvelope(m, t),
    [x, z] = e.center,
    r = e.radius;
  if (
    Math.abs(x) + r > plan.domain.width / 2 ||
    Math.abs(z) + r > plan.domain.depth / 2
  )
    return issue("boundary", path, "Full footprint crosses scene boundary");
  const regions = plan.regions.filter(
    (a) =>
      a.regionId === g.regionId ||
      plan.relations.some(
        (q) =>
          q.kind === "within" &&
          q.groupId === g.groupId &&
          q.regionId === a.regionId,
      ),
  );
  if (regions.some((a) => !footprintInPolygon(regionPolygon(a), e.center, r)))
    return issue("boundary", path, "Full footprint crosses required region");
  for (const q of plan.relations)
    if (
      q.kind === "outside" &&
      q.groupId === g.groupId &&
      !outsidePolygon(
        regionPolygon(plan.regions.find((a) => a.regionId === q.regionId)!),
        e.center,
        r,
      )
    )
      return issue("boundary", path, "Footprint intersects excluded region");
  const f = solution.field,
    c = gridCircle(f, e.center, r);
  if (
    Math.abs(c.center[0]) + c.radius > f.width / 2 ||
    Math.abs(c.center[1]) + c.radius > f.depth / 2
  )
    return issue("boundary", path, "Footprint crosses fixed proxy boundary");
  if (f.patchSupport) {
    if (!patch || patch.manifest.kind !== "patch")
      return issue(
        "asset",
        path,
        "Fixed patch manifest is required for edge/water masks",
      );
    const pm = patch.manifest.patch;
    if (
      !footprintInPolygon(
        f.patchSupport.validPolygon,
        c.center,
        c.radius +
          pm.edgeBuffer +
          supportQueryMargin(f.patchSupport.validPolygon),
      )
    )
      return issue(
        "boundary",
        path,
        "Footprint crosses scan usable boundary/setback",
      );
    if (
      f.patchSupport.voidMask.some(
        (p) => !outsidePolygon(p, c.center, c.radius + supportQueryMargin(p)),
      )
    )
      return issue("void", path, "Footprint intersects scan void");
    if (
      pm.waterMask.some(
        (p) =>
          !outsidePolygon(
            p,
            c.center,
            c.radius +
              L.minDryWaterDistance / (f.transform!.scale * c.horizontalScale) +
              supportQueryMargin(p),
          ),
      )
    )
      return issue("water", path, "Footprint intersects scan water/setback");
  }
  const water = sampleWaterDomain(solution, x, z);
  if (!water.ok)
    return issue(
      "support",
      path,
      water.issues.map((i) => i.message).join("; "),
    );
  let min = L.minDryWaterDistance as number,
    max = Infinity;
  if (m.category === "reed" && plan.water.mode !== "none")
    max = L.recommendedReedBankMax;
  for (const q of plan.relations)
    if (q.groupId === g.groupId) {
      if (q.kind === "keepDry") min = Math.max(min, q.distance);
      if (q.kind === "nearWater") {
        min = Math.max(min, q.min);
        max = Math.min(max, q.max);
      }
    }
  if (
    water.value.wet !== false ||
    !Number.isFinite(water.value.distanceError) ||
    water.value.signedDistance - water.value.distanceError - r < min ||
    water.value.signedDistance + water.value.distanceError + r > max
  )
    return issue(
      "water",
      path,
      "Full footprint cannot be certified inside dry bank distance interval",
    );
  let slope: number;
  try {
    slope = footprintSlope(solution, e);
  } catch (e) {
    return issue(
      "slope",
      path,
      e instanceof Error ? e.message : "Uncertified slope",
    );
  }
  if (
    slope >
    Math.tan(
      radians(
        Math.min(m.object.maxSlopeDegrees, g.placementPolicy.maxSlopeDegrees),
      ),
    )
  )
    return issue("slope", path, "Maximum whole-footprint slope exceeds limit");
  return admission(m, g, t);
}
/** Returns an interval for anchor Y, intersecting every measured support point.
 * Error tightens, never expands, the permitted contact interval. */
function grounding(
  solution: WaterSolution,
  m: ObjectManifest,
  t: Transform,
): [number, number] | null {
  let low = -Infinity,
    high = Infinity;
  const minimum = Math.max(
      L.minContactGap,
      m.object.contactTolerance.min * t.scale,
      -m.object.allowedBurial * t.scale,
    ),
    maximum = Math.min(
      L.maxContactGap,
      m.object.contactTolerance.max * t.scale,
    );
  for (const p of m.object.supportPoints) {
    const w = worldPoint(p.position, m.object.anchor, {
      ...t,
      position: [t.position[0], 0, t.position[2]],
    });
    const q = sampleTerrainWorld(solution.field, w[0], w[2]);
    if (!q.ok || !Number.isFinite(q.value.worldError) || q.value.worldError < 0)
      return null;
    low = Math.max(low, q.value.height - w[1] + minimum + q.value.worldError);
    high = Math.min(high, q.value.height - w[1] + maximum - q.value.worldError);
  }
  return Number.isFinite(low) && Number.isFinite(high) && low <= high
    ? [low, high]
    : null;
}
/** Deterministic vertical reattachment for a reviewed brush. XZ, orientation,
 * scale and identity never change; an already feasible support stays exact. */
export function reattachInstance(
  instance: SceneInstance,
  solution: WaterSolution,
  asset: ObjectManifest,
): Result<SceneInstance> {
  try {
    const parsed = parseSceneInstance(instance),
      range = grounding(solution, asset, parsed.transform);
    if (!range)
      return {
        ok: false,
        issues: [
          issue(
            "support",
            `instances.${parsed.instanceId}`,
            "No common error-tightened reattachment interval",
          ),
        ],
      };
    const y = parsed.transform.position[1];
    if (y >= range[0] && y <= range[1]) return { ok: true, value: parsed };
    if (parsed.locked)
      return {
        ok: false,
        issues: [
          issue(
            "support",
            `instances.${parsed.instanceId}`,
            "Locked support became infeasible",
          ),
        ],
      };
    return {
      ok: true,
      value: {
        ...parsed,
        transform: {
          ...parsed.transform,
          position: [
            parsed.transform.position[0],
            (range[0] + range[1]) / 2,
            parsed.transform.position[2],
          ],
        },
      },
    };
  } catch (e) {
    return {
      ok: false,
      issues: [
        issue(
          "support",
          "instance",
          e instanceof Error ? e.message : "Invalid reattachment",
        ),
      ],
    };
  }
}
class SpatialIndex {
  private cells = new Map<string, { envelope: Envelope; margin: number }[]>();
  constructor(
    private cellSize: number,
    private maximumRadius: number,
    private maximumMargin: number,
  ) {}
  check(e: Envelope, margin: number): string | null {
    const ix = Math.floor(e.center[0] / this.cellSize),
      iz = Math.floor(e.center[1] / this.cellSize),
      range = Math.ceil(
        (e.radius + this.maximumRadius + Math.max(margin, this.maximumMargin)) /
          this.cellSize,
      );
    for (let z = iz - range; z <= iz + range; z++)
      for (let x = ix - range; x <= ix + range; x++)
        for (const other of this.cells.get(`${x},${z}`) ?? []) {
          const b = other.envelope;
          if (
            Math.hypot(e.center[0] - b.center[0], e.center[1] - b.center[1]) <
            e.radius + b.radius + Math.max(margin, other.margin)
          )
            return "spacing";
          if (
            [0, 1, 2].every((k) => e.min[k] < b.max[k] && b.min[k] < e.max[k])
          )
            return "collision";
        }
    return null;
  }
  add(envelope: Envelope, margin: number) {
    const key = `${Math.floor(envelope.center[0] / this.cellSize)},${Math.floor(envelope.center[1] / this.cellSize)}`;
    const list = this.cells.get(key) ?? [];
    list.push({ envelope, margin });
    this.cells.set(key, list);
  }
}
export function placeInstances(
  input: ScenePlan,
  solution: WaterSolution,
  assets: LoadedAsset[],
  inputState: EditableState,
  frozen: SceneInstance[],
  newRegion?: readonly Vec2[],
  reserved?: { instanceIds: readonly string[]; remainingAttempts: number },
): Result<PlacementResult> {
  try {
    const plan = parseScenePlan(input);
    let state = parseEditableState(inputState);
    const reservedIds = reserved ? [...reserved.instanceIds] : null;
    if (
      reserved &&
      (!Number.isSafeInteger(reserved.remainingAttempts) ||
        reserved.remainingAttempts < 0 ||
        reserved.remainingAttempts > L.maxPlacementAttempts ||
        new Set(reserved.instanceIds).size !== reserved.instanceIds.length)
    )
      throw Error("Invalid finite placement reservation");
    const groups = [...plan.groups].sort((a, b) =>
      a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
    );
    const byRef = new Map(assets.map((a) => [refKey(a.manifest), a]));
    const patch =
      plan.terrain.source === "patch"
        ? byRef.get(refKey(plan.terrain.assetRef))
        : undefined;
    const get = (ref: SceneInstance["assetRef"]) => {
      const a = byRef.get(refKey(ref));
      if (!a || a.manifest.kind !== "object")
        throw Error("Missing exact object dependency");
      return a.manifest;
    };
    const margin = (g: Group) =>
      Math.max(
        L.defaultSpacingMargin,
        g.placementPolicy.spacingMargin,
        ...plan.relations
          .filter((q) => q.groupId === g.groupId && q.kind === "minSpacing")
          .map((q) => ("distance" in q ? (q.distance ?? 0) : 0)),
      );
    let maximumRadius = Math.max(
      0.01,
      ...groups.map((g) => {
        const m = get(g.assetRef);
        return (
          Math.max(
            m.object.collisionRadius,
            ...m.object.footprint.map((p) =>
              Math.hypot(p[0] - m.object.anchor[0], p[1] - m.object.anchor[2]),
            ),
            Math.hypot(
              ...m.coordinates.fullBounds.max.map((v, k) =>
                Math.max(
                  Math.abs(v - m.object.anchor[k]),
                  Math.abs(
                    m.coordinates.fullBounds.min[k] - m.object.anchor[k],
                  ),
                ),
              ),
            ),
          ) * g.scaleRange[1]
        );
      }),
    );
    const maximumMargin = Math.max(0.1, ...groups.map(margin));

    const instances: SceneInstance[] = [],
      rejections: Record<string, number> = Object.create(null),
      shortfall: Record<string, number> = Object.create(null),
      groupRejections: Record<string, Record<string, number>> = Object.create(
        null,
      );
    let attempts = 0;
    const locked = new Set(state.lockedInstanceIds),
      seen = new Set<string>();
    const fixed = frozen.map(parseSceneInstance);
    for (const o of state.overrides)
      if (
        o.kind !== "remove" &&
        !fixed.some((i) => i.instanceId === o.instanceId)
      )
        fixed.push({
          instanceId: o.instanceId,
          groupId: o.groupId,
          assetRef: o.assetRef!,
          transform: o.transform!,
          locked: locked.has(o.instanceId),
        });
    for (const i of fixed)
      maximumRadius = Math.max(
        maximumRadius,
        instanceEnvelope(get(i.assetRef), i.transform).radius,
      );
    const index = new SpatialIndex(
      Math.max(0.1, maximumRadius),
      maximumRadius,
      maximumMargin,
    );
    for (const id of locked)
      if (!fixed.some((i) => i.instanceId === id))
        return {
          ok: false,
          issues: [
            issue(
              "support",
              `instances.${id}`,
              "Locked instance requires its exact frozen transform",
            ),
          ],
        };
    for (const i of fixed.sort((a, b) =>
      a.instanceId < b.instanceId ? -1 : 1,
    )) {
      const g = groups.find((g) => g.groupId === i.groupId),
        allocator = state.groups.find((g) => g.groupId === i.groupId);
      if (
        !g ||
        !allocator ||
        allocator.retired ||
        state.tombstones.includes(i.instanceId) ||
        seen.has(i.instanceId) ||
        i.locked !== locked.has(i.instanceId)
      )
        throw Error("Invalid frozen identity/lock state");
      const prefix = encodeURIComponent(i.groupId) + ":",
        slot = Number(i.instanceId.slice(prefix.length));
      if (
        !i.instanceId.startsWith(prefix) ||
        !Number.isSafeInteger(slot) ||
        slot < 0 ||
        slot >= allocator.nextSlot ||
        instanceIdFor(i.groupId, slot) !== i.instanceId
      )
        throw Error("Unallocated frozen identity");
      const override = state.overrides.find(
        (o) => o.instanceId === i.instanceId,
      );
      if (
        refKey(i.assetRef) !== refKey(override?.assetRef ?? g.assetRef) ||
        (override &&
          JSON.stringify(i.transform) !== JSON.stringify(override.transform))
      )
        throw Error("Frozen instance loses cumulative override");
      if (
        i.transform.position.length !== 3 ||
        i.transform.quaternion.length !== 4 ||
        ![
          ...i.transform.position,
          ...i.transform.quaternion,
          i.transform.scale,
        ].every(Number.isFinite) ||
        i.transform.scale <= 0 ||
        Math.abs(Math.hypot(...i.transform.quaternion) - 1) > 1e-6
      )
        throw Error("Invalid frozen transform");
      const m = get(i.assetRef),
        reason = constraintIssue(plan, solution, m, g, i.transform, patch),
        contact = grounding(solution, m, i.transform);
      if (reason)
        return {
          ok: false,
          issues: [{ ...reason, path: `instances.${i.instanceId}` }],
        };
      if (
        !contact ||
        i.transform.position[1] < contact[0] ||
        i.transform.position[1] > contact[1]
      )
        return {
          ok: false,
          issues: [
            issue(
              "support",
              `instances.${i.instanceId}`,
              "Frozen support cannot satisfy exact error-tightened contact interval",
            ),
          ],
        };
      const e = instanceEnvelope(m, i.transform),
        collision = index.check(e, margin(g));
      if (collision)
        return {
          ok: false,
          issues: [
            issue(
              collision,
              `instances.${i.instanceId}`,
              "Frozen object overlaps another fixed object",
            ),
          ],
        };
      index.add(e, margin(g));
      instances.push(i);
      seen.add(i.instanceId);
    }
    for (const g of groups) {
      const m = get(g.assetRef),
        initial = instances.filter((i) => i.groupId === g.groupId).length;
      if (initial > g.count)
        return {
          ok: false,
          issues: [
            issue(
              "quantity",
              `groups.${g.groupId}`,
              "Fixed instances exceed requested count",
            ),
          ],
        };
      const allocator = state.groups.find((a) => a.groupId === g.groupId);
      let existingSlot = 0;
      for (let n = initial; n < g.count; n++) {
        let id: string | undefined;
        if (reservedIds) {
          id = reservedIds.shift();
          if (
            !id ||
            !id.startsWith(encodeURIComponent(g.groupId) + ":") ||
            !allocator ||
            Number(id.slice(id.lastIndexOf(":") + 1)) >= allocator.nextSlot ||
            state.tombstones.includes(id) ||
            seen.has(id)
          )
            throw Error("Reserved slot differs from allocated working state");
        }
        while (!id && existingSlot < (allocator?.nextSlot ?? 0)) {
          const candidate = instanceIdFor(g.groupId, existingSlot++);
          if (!state.tombstones.includes(candidate) && !seen.has(candidate)) {
            id = candidate;
            break;
          }
        }
        if (!id) {
          const a = allocateSlot(state, g.groupId);
          state = a.state;
          id = a.instanceId;
        }
        seen.add(id);
        let accepted = false;
        for (
          let attempt = 0;
          attempt < L.maxAttemptsPerInstance &&
          attempts < (reserved?.remainingAttempts ?? L.maxPlacementAttempts);
          attempt++
        ) {
          attempts++;
          const sample = (purpose: string) =>
            randomSample(plan.seed, id!, purpose, attempt);
          const x = (sample("x") - 0.5) * plan.domain.width,
            z = (sample("z") - 0.5) * plan.domain.depth,
            scale =
              g.scaleRange[0] +
              sample("scale") * (g.scaleRange[1] - g.scaleRange[0]);
          const yaw =
            g.orientation.yawDegrees[0] +
            sample("yaw") *
              (g.orientation.yawDegrees[1] - g.orientation.yawDegrees[0]);
          let quaternion = new Quaternion().setFromAxisAngle(
            new Vector3(0, 1, 0),
            radians(yaw),
          );
          const center = sampleTerrainWorld(solution.field, x, z);
          if (center.ok && g.orientation.mode === "surface-normal") {
            const alignment = new Quaternion().setFromUnitVectors(
              new Vector3(0, 1, 0),
              new Vector3(...center.value.normal),
            );
            quaternion = alignment.multiply(quaternion);
          }
          let t: Transform = {
            position: [x, 0, z],
            quaternion: quaternion.toArray() as [
              number,
              number,
              number,
              number,
            ],
            scale,
          };
          let failure =
            newRegion &&
            !footprintInPolygon(
              newRegion,
              [x, z],
              instanceEnvelope(m, t).radius + margin(g),
            )
              ? issue(
                  "boundary",
                  `instances.${id}`,
                  "New footprint and spacing margin leave reviewed R",
                )
              : constraintIssue(plan, solution, m, g, t, patch);
          if (!failure) {
            const contact = grounding(solution, m, t);
            if (!contact)
              failure = issue(
                "support",
                `instances.${id}`,
                "No common error-tightened support interval",
              );
            else t = { ...t, position: [x, (contact[0] + contact[1]) / 2, z] };
          }
          const e = instanceEnvelope(m, t);
          if (!failure) {
            const collision = index.check(e, margin(g));
            if (collision)
              failure = issue(
                collision,
                `instances.${id}`,
                "Full footprint/bounds overlaps occupied space",
              );
          }
          if (failure) {
            rejections[failure.code] = (rejections[failure.code] ?? 0) + 1;
            const gr = (groupRejections[g.groupId] ??= {});
            gr[failure.code] = (gr[failure.code] ?? 0) + 1;
            continue;
          }
          instances.push({
            instanceId: id,
            groupId: g.groupId,
            assetRef: g.assetRef,
            transform: t,
            locked: false,
          });
          index.add(e, margin(g));
          accepted = true;
          break;
        }
        if (!accepted) shortfall[g.groupId] = (shortfall[g.groupId] ?? 0) + 1;
      }
    }
    state = parseEditableState({
      ...state,
      groups: [
        ...state.groups,
        ...groups
          .filter((g) => !state.groups.some((a) => a.groupId === g.groupId))
          .map((g) => ({ groupId: g.groupId, nextSlot: 0, retired: false })),
      ],
    });
    return {
      ok: true,
      value: {
        instances,
        state,
        rejections,
        shortfall,
        attempts,
        groupRejections,
      },
    };
  } catch (e) {
    return {
      ok: false,
      issues: [
        issue(
          "placement-input",
          "placement",
          e instanceof Error ? e.message : "Invalid placement input",
        ),
      ],
    };
  }
}
