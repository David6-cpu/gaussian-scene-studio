import { makeAssetLibrary, type CatalogView } from "./asset-library";
import { documentDigest } from "./canonical";
import {
  parseIntent,
  parsePlanDraft,
  type SceneIntent,
  type PlanDraft,
  type AtomicConstraint,
  type JsonValue,
} from "./contracts";
import {
  PLANNER_VERSION,
  RULES_VERSION,
  planningRequirementDigest,
  type PlanningRequest,
} from "./planner";
import { queryCandidates, type Candidate } from "./query";
import type { AssetRef } from "./core";

export const manualAtom = (
  key: string,
  value: JsonValue,
): AtomicConstraint => ({
  key,
  value,
  source: "manual",
  span: null,
  strength: "hard",
  negated: false,
});
export const refKey = (ref: AssetRef) =>
  JSON.stringify([ref.id, ref.contentVersion]);
const asRef = (ref: AssetRef): AssetRef => ({
  id: ref.id,
  contentVersion: ref.contentVersion,
});
/** Metadata defaults for an explicit candidate selection, bounded by its admitted capabilities. */
export function placementForCandidate(
  c: Candidate | undefined,
): Pick<
  PlanDraft["groups"][number],
  "scaleRange" | "orientation" | "placementPolicy"
> {
  const scale = c ? Math.min(c.scaleRange[1], Math.max(c.scaleRange[0], 1)) : 1;
  if (c && scale !== 1 && !c.operations.includes("uniform-scale"))
    throw Error("当前素材不允许所需缩放，请选择其他素材。");
  const rotation = c?.rotation ?? "fixed";
  const yaw = rotation === "fixed" ? (c?.verifiedYawDegrees[0] ?? 0) : 0;
  if (
    c &&
    rotation !== "fixed" &&
    !c.operations.includes("rotate") &&
    !c.verifiedYawDegrees.includes(0)
  )
    throw Error("当前素材没有已验收的默认朝向，请选择其他素材。");
  return {
    scaleRange: [scale, scale],
    orientation: {
      mode: rotation as PlanDraft["groups"][number]["orientation"]["mode"],
      yawDegrees: [yaw, yaw],
    },
    placementPolicy: {
      maxSlopeDegrees:
        rotation === "surface-normal" && !c?.operations.includes("rotate")
          ? 0
          : Math.min(15, c?.maxSlopeDegrees ?? 15),
      spacingMargin: 0.1,
    },
  };
}
export type ManualSettings = {
  width: number;
  depth: number;
  seed: number;
  terrain: PlanDraft["terrain"];
  water: PlanDraft["water"];
  groups: {
    category: string;
    count: number;
    sourceRestriction: SceneIntent["features"][number]["sourceRestriction"];
    required: boolean;
  }[];
};
/** Metadata-only form conversion. Query and all geometry/semantic gates remain authoritative. */
export async function makeManualDraft(
  request: PlanningRequest,
  settings: ManualSettings,
  catalog: CatalogView,
) {
  const intent = parseIntent({
    documentType: "general-scene-intent",
    schemaVersion: 1,
    requestId: request.operationId,
    raw: request.prompt,
    language: "zh",
    operation: request.baseRevisionId === null ? "create" : "patch",
    baseRevisionId: request.baseRevisionId,
    terrain: [
      manualAtom("width", settings.width),
      manualAtom("depth", settings.depth),
      ...Object.entries(settings.terrain)
        .filter(([key]) => !["assetRef", "transform"].includes(key))
        .map(([key, value]) => manualAtom(key, value as JsonValue)),
    ],
    features: settings.groups.map((g, index) => ({
      featureId: `manual-group-${index + 1}`,
      category: g.category,
      required: g.required,
      quantity: manualAtom("count", g.count),
      sourceRestriction: g.sourceRestriction,
      constraints: [],
    })),
    sourceConstraints: [],
    relations: [],
    prohibitions: [],
    water: {
      mode: settings.water.mode,
      constraints: Object.entries(settings.water)
        .filter(
          ([key, value]) =>
            !["mode", "waterId", "levelStatus", "levelSource"].includes(key) &&
            value !== null,
        )
        .map(([key, value]) => manualAtom(key, value as JsonValue)),
    },
    seed: manualAtom("seed", settings.seed),
    unspecified: settings.water.mode === "unspecified" ? ["water"] : [],
    conflicts: [],
    unsupported: [],
  });
  const query = queryCandidates(
    intent,
    makeAssetLibrary(
      {
        digest: catalog.digest,
        manifests: catalog.manifests,
        styles: catalog.styles,
      },
      async () => {
        throw Error("Metadata form does not read asset bytes");
      },
    ),
  );
  const draft = parsePlanDraft({
    documentType: "general-scene-plan",
    schemaVersion: 1,
    planId: `plan-${request.operationId}`,
    intentDigest: await documentDigest(intent),
    catalogDigest: catalog.digest,
    generatorVersion: PLANNER_VERSION,
    rulesVersion: RULES_VERSION,
    prngVersion: "fnv1a32-v1",
    seed: settings.seed,
    domain: {
      width: settings.width,
      depth: settings.depth,
      unit: "display-unit",
      up: "+Y",
    },
    terrain: settings.terrain,
    water: settings.water,
    surfaceStyleRef:
      query.slots.find((s) => s.kind === "style")?.candidates[0]?.assetRef ??
      null,
    regions: [],
    groups: query.slots
      .filter((s) => s.kind === "object")
      .map((s) => {
        const c = s.candidates[0];
        return {
          groupId: s.groupId!,
          assetRef: c?.assetRef ?? null,
          regionId: null,
          count: s.count,
          countMode: s.countMode,
          required: s.required,
          ...placementForCandidate(c),
        };
      }),
    relations: [],
    budgetProfileId: "general-v1",
    budgetEstimate: null,
    review: {
      assumptions: [],
      unsupported: query.issues,
      missing: query.missing,
      substitutions: [],
      acceptedSubstitutions: [],
      manualOverrides: [],
      fieldSources: [],
    },
  });
  return { intent, draft, query };
}
export type ProceduralChoice = {
  slotId: string;
  groupId: string | null;
  label: string;
  assetRef: AssetRef;
  digest: string;
};
/** One checkbox per actual selected role, including the terrain surface role. */
export function proceduralChoices(
  intent: SceneIntent,
  draft: PlanDraft,
  catalog: CatalogView,
): ProceduralChoice[] {
  const choices: ProceduralChoice[] = [];
  intent.features.forEach((f, index) => {
    const group = draft.groups.find((g) => g.groupId === f.featureId),
      manifest = catalog.manifests.find(
        (m) => group?.assetRef && refKey(m) === refKey(group.assetRef),
      );
    if (manifest?.origin === "procedural")
      choices.push({
        slotId: `object:${index}`,
        groupId: f.featureId,
        label: f.category,
        assetRef: asRef(manifest),
        digest: manifest.contentVersion.slice(7),
      });
  });
  if (draft.terrain.source === "patch") {
    const ref = draft.terrain.assetRef,
      manifest = catalog.manifests.find((m) => refKey(m) === refKey(ref));
    if (manifest?.origin === "procedural")
      choices.push({
        slotId: "patch:terrain",
        groupId: null,
        label: "场地",
        assetRef: asRef(manifest),
        digest: manifest.contentVersion.slice(7),
      });
  }
  if (draft.surfaceStyleRef) {
    const style = catalog.styles.find(
      (s) => refKey(s) === refKey(draft.surfaceStyleRef!),
    );
    if (style)
      choices.push({
        slotId: "style:surfaceStyle",
        groupId: null,
        label: "地形与水面",
        assetRef: asRef(style),
        digest: style.contentVersion.slice(7),
      });
  }
  return choices;
}
/** Only called after the user checks every selected procedural role. */
export async function confirmProceduralChoices(
  request: PlanningRequest,
  intent: SceneIntent,
  input: PlanDraft,
  catalog: CatalogView,
  accepted: ReadonlySet<string>,
) {
  const draft = structuredClone(input),
    choices = proceduralChoices(intent, draft, catalog),
    overrides = draft.review.manualOverrides.filter(
      (a) => !a.key.startsWith("accept."),
    ),
    requirementDigest = await planningRequirementDigest({
      ...request,
      manualOverrides: overrides,
    });
  draft.review.substitutions = draft.review.substitutions.filter(
    (s) => !s.substitutionId.startsWith("procedural:"),
  );
  draft.review.acceptedSubstitutions =
    draft.review.acceptedSubstitutions.filter(
      (s) => !s.substitutionId.startsWith("procedural:"),
    );
  for (const c of choices) {
    if (!accepted.has(c.slotId))
      throw Error(`请明确确认${c.label}使用程序素材`);
    overrides.push(
      manualAtom(`accept.procedural.${c.slotId}`, {
        groupId: c.groupId,
        requirementDigest,
        catalogDigest: draft.catalogDigest,
        assetRef: { ...c.assetRef },
        digest: c.digest,
      }),
    );
    if (c.groupId) {
      const substitutionId = `procedural:${c.slotId}`,
        feature = intent.features.find((f) => f.featureId === c.groupId)!;
      draft.review.substitutions.push({
        substitutionId,
        groupId: c.groupId,
        requested: `${feature.category}/${feature.sourceRestriction}`,
        assetRef: c.assetRef,
        digest: c.digest,
        reason: "用户明确选择程序素材",
      });
      draft.review.acceptedSubstitutions.push({
        substitutionId,
        planId: draft.planId,
        catalogDigest: draft.catalogDigest,
        assetRef: c.assetRef,
        digest: c.digest,
      });
    }
  }
  draft.review.manualOverrides = overrides;
  return parsePlanDraft(draft);
}
