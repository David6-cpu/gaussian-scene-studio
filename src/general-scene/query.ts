import {
  parseIntent,
  type AtomicConstraint,
  type FieldSource,
  type SceneIntent,
} from "./contracts.ts";
import type { AssetLibrary } from "./asset-library.ts";
import type {
  AssetManifestV2,
  SurfaceStyle,
  AssetOperation,
} from "./asset-manifest.ts";
import {
  GENERAL_LIMITS as L,
  type AssetRef,
  type Issue,
  type Transform,
} from "./core.ts";

// User-facing name for an asset category; unknown categories keep their ID.
const CATEGORY_LABELS: Record<string, string> = {
  rock: "石头",
  grass: "低草",
  reed: "芦苇",
  tree: "树",
  ground: "场地",
  surface: "地形与水面样式",
};
const categoryLabel = (name: string) => CATEGORY_LABELS[name] ?? name;

/** Metadata summaries only. File paths, proxies and license documents never enter model context. */

export type Candidate = {
  assetRef: AssetRef;
  digest: string;
  kind: "object" | "patch" | "style";
  category: string;
  origin: "captured" | "procedural" | "generated";
  worstSplats: number;
  cpuBytes: number;
  uploadBytes: number;
  scaleRange: readonly [number, number];
  maxSlopeDegrees: number;
  rotation: string;
  operations: readonly AssetOperation[];
  shDegree: number;
  shRotation: AssetManifestV2["gaussian"]["shRotation"];
  verifiedYawDegrees: readonly number[];
  transform: Transform | null;
};
export type CandidateSlot = {
  /** Bounded role identity; labels/group IDs remain exact and are never reserved or truncated. */
  slotId: string;
  groupId: string | null;
  key: string;
  kind: Candidate["kind"];
  category: string;
  required: boolean;
  count: number;
  countSource: FieldSource;
  countMode: "hard" | "suggestion";
  status: "satisfied" | "missing" | "needs-choice";
  candidates: Candidate[];
};
export type CandidateQuery = {
  catalogDigest: string;
  slots: CandidateSlot[];
  missing: { key: string; required: boolean; reason: string }[];
  rejected: { key: string; assetRef: AssetRef; reason: string }[];
  trimmed: { key: string; assetRef: AssetRef; reason: string }[];
  alternatives: {
    key: string;
    requested: string;
    candidate: Candidate;
    difference: string;
    impact: string;
  }[];
  issues: Issue[];
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const requirementValue = (
  atoms: readonly AtomicConstraint[],
  key: string,
): unknown =>
  atoms.find((a) => (a.key === key || a.key === `terrain.${key}`) && !a.negated)
    ?.value;
const numeric = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
export function requestedQuantity(feature: SceneIntent["features"][number]) {
  const q = feature.quantity;
  if (q === null)
    return {
      count: 4,
      countSource: "default" as const,
      countMode: "suggestion" as const,
    };
  const density =
    q.value === "sparse"
      ? 2
      : q.value === "dense"
        ? 8
        : q.value === "some"
          ? 4
          : null;
  return {
    count: density ?? (typeof q.value === "number" ? q.value : NaN),
    countSource: q.source,
    countMode: density === null ? q.strength : ("suggestion" as const),
  };
}
function admission(m: AssetManifestV2 | SurfaceStyle): string | null {
  if (m.quality.status !== "accepted" || !m.quality.humanReview)
    return "admission: asset has no current human acceptance";
  if (!/^sha256-[0-9a-f]{64}$/.test(m.contentVersion))
    return "identity: missing immutable content digest";
  if (m.provenance.license.id === "unknown" || !m.provenance.license.evidence)
    return "license: local use lacks evidence";
  return null;
}
function summarize(m: AssetManifestV2): Candidate {
  return {
    assetRef: { id: m.id, contentVersion: m.contentVersion },
    digest: m.contentVersion.slice(7),
    kind: m.kind as "object" | "patch",
    category: m.category,
    origin: m.origin,
    worstSplats: Math.max(
      m.gaussian.full.points,
      m.gaussian.coarse?.points ?? 0,
    ),
    cpuBytes: m.resources.decodedBytes + m.resources.cpuSourceBytes,
    uploadBytes: m.resources.uploadBytes,
    scaleRange: m.kind === "object" ? m.object.scaleRange : [1, 1],
    maxSlopeDegrees: m.kind === "object" ? m.object.maxSlopeDegrees : 0,
    rotation: m.kind === "object" ? m.object.rotation : "fixed",
    operations: m.quality.operations,
    shDegree: m.gaussian.shDegree,
    shRotation: m.gaussian.shRotation,
    verifiedYawDegrees: m.kind === "object" ? m.object.verifiedYawDegrees : [0],
    transform: m.kind === "patch" ? m.patch.displayTransform : null,
  };
}
export function queryCandidates(
  value: SceneIntent,
  library: AssetLibrary,
): CandidateQuery {
  const intent = parseIntent(value);
  const out: CandidateQuery = {
    catalogDigest: library.digest,
    slots: [],
    missing: [],
    rejected: [],
    trimmed: [],
    alternatives: [],
    issues: [],
  };
  const issue = (code: string, path: string, message: string) =>
    out.issues.push({ code, path, message });
  const terrainSource =
    requirementValue(intent.terrain, "source") ?? "procedural";
  const width = numeric(requirementValue(intent.terrain, "width"), L.minExtent),
    depth = numeric(requirementValue(intent.terrain, "depth"), L.minExtent);
  const environment =
    requirementValue(intent.terrain, "environment") ??
    requirementValue(intent.terrain, "biome");
  if (intent.features.length > L.maxFeatureGroups)
    issue("group-budget", "features", "请求超过8个要素组，请明确缩小范围。");
  if (!["patch", "procedural"].includes(String(terrainSource)))
    issue("terrain-source", "terrain", "只能选择程序场地或一个刚性扫描地块。");
  if (
    terrainSource === "patch" &&
    intent.terrain.some(
      (a) =>
        [
          "slopeDegrees",
          "noiseAmplitude",
          "elevation",
          "terrain.slopeDegrees",
          "terrain.noiseAmplitude",
          "terrain.elevation",
        ].includes(a.key) && a.strength === "hard",
    )
  )
    issue("patch-deformation", "terrain", "扫描地块不能按坡面或高程参数改形。");
  const descriptors = intent.features.map((f, index) => ({
    slotId: `object:${index}`,
    groupId: f.featureId,
    key: f.featureId,
    kind: "object" as const,
    category: f.category,
    required: f.required,
    ...requestedQuantity(f),
    origin: f.sourceRestriction,
    atoms: f.constraints,
  }));
  const total = descriptors.reduce((n, f) => n + f.count, 0);
  if (
    !Number.isSafeInteger(total) ||
    total > L.maxInstances ||
    descriptors.some((f) => !Number.isSafeInteger(f.count) || f.count < 0)
  )
    issue(
      "count-budget",
      "features",
      "明确数量或建议总量不在0–20范围，需手工取舍，不自动减少。",
    );
  type Descriptor = Omit<CandidateSlot, "status" | "candidates"> & {
    origin: string;
    atoms: readonly AtomicConstraint[];
  };
  const slots: Descriptor[] = [...descriptors];
  if (terrainSource === "patch")
    slots.push({
      slotId: "patch:terrain",
      groupId: null,
      key: "terrain",
      kind: "patch",
      category: "ground",
      required: true,
      count: 1,
      countSource: "user",
      countMode: "hard",
      origin: "either",
      atoms: intent.terrain,
    });
  if (
    terrainSource === "procedural" ||
    !["none", "unspecified"].includes(intent.water.mode)
  )
    slots.push({
      slotId: "style:surfaceStyle",
      groupId: null,
      key: "surfaceStyle",
      kind: "style",
      category: "surface",
      required: true,
      count: 1,
      countSource: "default",
      countMode: "suggestion",
      origin: "procedural",
      atoms: [],
    });
  for (const d of slots) {
    const candidates: Candidate[] = [];
    if (d.kind === "style") {
      for (const s of library.styles) {
        const reason = admission(s);
        if (reason) {
          out.rejected.push({ key: d.slotId, assetRef: s, reason });
          continue;
        }
        candidates.push({
          assetRef: { id: s.id, contentVersion: s.contentVersion },
          digest: s.contentVersion.slice(7),
          kind: "style",
          category: "surface",
          origin: "procedural",
          worstSplats: 0,
          cpuBytes: 0,
          uploadBytes: 0,
          scaleRange: [1, 1],
          maxSlopeDegrees: 12,
          rotation: "fixed",
          operations: s.quality.operations,
          shDegree: 0,
          shRotation: "fixed",
          verifiedYawDegrees: [0],
          transform: null,
        });
      }
    } else
      for (const m of library.manifests) {
        if (m.kind !== d.kind || m.category !== d.category) continue;
        let reason: string | null = null;
        if (
          typeof environment === "string" &&
          !m.environments.includes(environment)
        )
          reason = "environment: tags do not satisfy the requested environment";
        const requestedEnvironment = requirementValue(d.atoms, "environment");
        if (
          typeof requestedEnvironment === "string" &&
          !m.environments.includes(requestedEnvironment)
        )
          reason = "environment: feature environment mismatch";
        if (m.coordinates.unit !== "display-unit")
          reason ??= "units: no implicit unit conversion is permitted";
        reason ??= admission(m);
        if (
          !m.quality.operations.includes(
            d.kind === "object" ? "place" : "place-on-patch",
          )
        )
          reason ??= "operation: placement has not been admitted";
        if (
          m.gaussian.full.quality.status !== "passed" ||
          m.gaussian.validatedDistance === null
        )
          reason ??= "quality: no validated full LOD/view distance";
        const viewDistance = requirementValue(d.atoms, "viewDistance");
        if (
          typeof viewDistance === "number" &&
          m.gaussian.validatedDistance &&
          (viewDistance < m.gaussian.validatedDistance[0] ||
            viewDistance > m.gaussian.validatedDistance[1])
        )
          reason ??= "quality: outside validated observation distance";
        const c = summarize(m),
          scale = numeric(
            requirementValue(d.atoms, "scale"),
            c.operations.includes("uniform-scale") ? c.scaleRange[0] : 1,
          );
        if (scale !== 1 && !c.operations.includes("uniform-scale"))
          reason ??= "operation: uniform scaling has not been admitted";
        if (scale < c.scaleRange[0] || scale > c.scaleRange[1])
          reason ??= "scale: outside verified uniform scale range";
        if (m.kind === "object") {
          const slope = numeric(
            requirementValue(d.atoms, "maxSlopeDegrees"),
            numeric(requirementValue(intent.terrain, "slopeDegrees"), 0),
          );
          if (slope > m.object.maxSlopeDegrees)
            reason ??= "slope: footprint slope exceeds asset capability";
          if (
            (m.coordinates.fullBounds.max[0] -
              m.coordinates.fullBounds.min[0]) *
              scale >
              width ||
            (m.coordinates.fullBounds.max[2] -
              m.coordinates.fullBounds.min[2]) *
              scale >
              depth
          )
            reason ??= "size: asset footprint exceeds site extent";
        }
        if (c.worstSplats * Math.max(0, d.count) > L.maxWorstSplats)
          reason ??= "points: worst LOD instances exceed 250k";
        if (
          c.cpuBytes > L.maxCandidateCpuBytes ||
          c.cpuBytes * 2 + c.uploadBytes * Math.max(1, d.count) >
            L.maxTransitionBytes
        )
          reason ??= "memory: candidate or transition estimate exceeds budget";
        const originMismatch = d.origin !== "either" && m.origin !== d.origin;
        const forbidden = intent.prohibitions.some(
          (a) =>
            a.negated &&
            ((a.key === `${d.category}.origin` && a.value === m.origin) ||
              (a.key === "category" && a.value === d.category)),
        );
        if (!reason && originMismatch) {
          out.alternatives.push({
            key: d.slotId,
            requested: d.origin,
            candidate: c,
            difference: `来源改为${m.origin}`,
            impact: "仅为可用替代建议；需要明确手工修改来源要求后重新规划。",
          });
        }
        if (originMismatch)
          reason ??= "source: requested origin does not match";
        if (forbidden)
          reason ??= "prohibition: asset violates an explicit exclusion";
        if (reason)
          out.rejected.push({ key: d.slotId, assetRef: c.assetRef, reason });
        else candidates.push(c);
      }
    candidates.sort(
      (a, b) =>
        compare(a.assetRef.id, b.assetRef.id) ||
        compare(a.assetRef.contentVersion, b.assetRef.contentVersion),
    );
    out.slots.push({
      slotId: d.slotId,
      groupId: d.groupId,
      key: d.key,
      kind: d.kind,
      category: d.category,
      required: d.required,
      count: d.count,
      countSource: d.countSource,
      countMode: d.countMode,
      status: candidates.length
        ? candidates.some((c) => c.origin === "procedural")
          ? "needs-choice"
          : "satisfied"
        : "missing",
      candidates,
    });
  }
  // Round-robin allocation preserves every slot before extra options. Never silently drop a slot.
  let remaining = L.maxCandidatesPerStage;
  const allocated = new Map(
    out.slots.map((s) => [s.slotId, [] as Candidate[]]),
  );
  for (let n = 0; n < L.maxCandidatesPerGroup; n++)
    for (const slot of out.slots)
      if (slot.candidates[n] && remaining > 0) {
        allocated.get(slot.slotId)!.push(slot.candidates[n]);
        remaining--;
      }
  for (const slot of out.slots) {
    const keep = allocated.get(slot.slotId)!;
    for (const c of slot.candidates)
      if (!keep.includes(c))
        out.trimmed.push({
          key: slot.slotId,
          assetRef: c.assetRef,
          reason: "deterministic per-group/stage candidate ceiling",
        });
    slot.candidates = keep;
    if (!keep.length && slot.count > 0) {
      slot.status = "missing";
      out.missing.push({
        key: slot.slotId,
        required: slot.required,
        reason: `本地库没有符合要求的${categoryLabel(slot.category)}素材（需同时满足来源、许可、准入、能力和预算）。`,
      });
    }
  }
  return out;
}
