import { record, oneOf } from "../data-validation";
import {
  BUILTIN_CONTEXT,
  type CatalogContext,
} from "../assets/catalog/context";
import { freeze, identifier } from "../assets/catalog/metadata";
import { parsePrompt } from "../planner/service";
import { waterIntent, assertWaterIntent } from "../planner/water-intent";
import {
  parseAssetRequest,
  parseAssetMaterials,
  materialKeys,
  type AssetMaterials,
  assertAssetPrompt,
  checkChoices,
  compileSelection,
  type AssetRequest,
  type Choice,
} from "../selection/contract";
import {
  equal,
  parseRequirementEvidence,
  parseChoiceEvidence,
  type RequirementEvidence,
  type ChoiceEvidence,
} from "../selection/service";
import type { RiverbankRecipe } from "../gaussian/types";
import { buildScene } from "../build";

export interface ReviewEdits {
  water: "keep" | "on" | "off";
  plantKind: "keep" | "grass" | "reed" | "none";
  density: "keep" | "sparse" | "medium" | "dense";
  rock: "none" | "unresolved" | "placeholder" | "omit";
}
export type SelectionProof =
  | { kind: "model"; evidence: ChoiceEvidence }
  | {
      kind: "manual";
      request: AssetRequest;
      catalogVersion: string;
      choices: Choice[];
    };
export interface ReviewDraft {
  prompt: string;
  requirements: RequirementEvidence | null;
  originalRequest: AssetRequest;
  edits: ReviewEdits;
  selection: SelectionProof | null;
  confirmedProceduralIds: string[];
}
export interface ResolvedReview {
  draft: ReviewDraft;
  effectiveRequest: AssetRequest;
  recipe: RiverbankRecipe;
}

export function parseEdits(
  value: unknown,
  request: AssetMaterials,
): ReviewEdits {
  const e = record(value, ["water", "plantKind", "density", "rock"]);
  const edits = {
    water: oneOf(e.water, ["keep", "on", "off"] as const),
    plantKind: oneOf(e.plantKind, ["keep", "grass", "reed", "none"] as const),
    density: oneOf(e.density, ["keep", "sparse", "medium", "dense"] as const),
    rock: oneOf(e.rock, ["none", "unresolved", "placeholder", "omit"] as const),
  };
  if ((request.rockCount === 0) !== (edits.rock === "none"))
    throw Error("石头处理必须对应原始需求，不能省略未处理的需求。");
  return edits;
}
export function parseConfirmed(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 2 ||
    new Set(value).size !== value.length
  )
    throw Error("程序素材确认无效");
  return value.map(identifier).sort();
}
export function resolveReviewRequest(draft: ReviewDraft): AssetRequest {
  const r = parseAssetRequest(draft.originalRequest),
    e = parseEdits(draft.edits, r);
  return parseAssetRequest({
    ...resolveMaterialEdits(r, e),
    waterLevel:
      e.water === "off"
        ? null
        : e.water === "on"
          ? (r.waterLevel ?? 0)
          : r.waterLevel,
  });
}
export function resolveMaterialEdits(
  r: AssetMaterials,
  e: ReviewEdits,
): AssetMaterials {
  if (e.rock === "unresolved")
    throw Error(
      "当前缺少可单独添加的真实石头，请明确选择简化占位或本次暂不添加。",
    );
  const plantKind = e.plantKind === "keep" ? r.plantKind : e.plantKind;
  const plantCount =
    plantKind === "none"
      ? 0
      : e.density === "keep"
        ? r.plantCount || 4
        : { sparse: 4, medium: 6, dense: 10 }[e.density];
  return parseAssetMaterials({
    ...Object.fromEntries(
      materialKeys.map((key) => [key, r[key as keyof AssetMaterials]]),
    ),
    plantKind,
    plantCount,
    rockCount: e.rock === "omit" ? 0 : r.rockCount,
    rockOrigin: e.rock === "placeholder" ? "procedural" : r.rockOrigin,
  });
}
export function parseProof(
  value: unknown,
  request: AssetRequest,
  context: CatalogContext,
): SelectionProof {
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "model"
  ) {
    const p = record(value, ["kind", "evidence"]),
      evidence = parseChoiceEvidence(p.evidence, context);
    if (!equal(evidence.request, request))
      throw Error("选材证据与当前有效需求不一致");
    return { kind: "model", evidence };
  }
  const p = record(value, ["kind", "request", "catalogVersion", "choices"]);
  oneOf(p.kind, ["manual"]);
  if (
    !equal(parseAssetRequest(p.request), request) ||
    p.catalogVersion !== context.catalogVersion
  )
    throw Error("手动选材与当前需求或目录版本不一致");
  return {
    kind: "manual",
    request,
    catalogVersion: context.catalogVersion,
    choices: checkChoices(request, { choices: p.choices }, context),
  };
}
export function parseReviewDraft(
  value: unknown,
  context: CatalogContext,
): ReviewDraft {
  const d = record(value, [
    "prompt",
    "requirements",
    "originalRequest",
    "edits",
    "selection",
    "confirmedProceduralIds",
  ]);
  const prompt = parsePrompt(d.prompt),
    originalRequest = parseAssetRequest(d.originalRequest),
    requirements =
      d.requirements === null ? null : parseRequirementEvidence(d.requirements);
  if (
    requirements &&
    (requirements.prompt !== prompt ||
      !equal(requirements.request, originalRequest))
  )
    throw Error("原始需求与模型证据不一致");
  const draft: ReviewDraft = {
    prompt,
    requirements,
    originalRequest,
    edits: parseEdits(d.edits, originalRequest),
    selection: null,
    confirmedProceduralIds: parseConfirmed(d.confirmedProceduralIds),
  };
  if (d.selection !== null)
    draft.selection = parseProof(
      d.selection,
      resolveReviewRequest(draft),
      context,
    );
  return freeze(draft);
}
export function createReviewDraft(
  prompt: string,
  request: AssetRequest,
  requirements: RequirementEvidence | null,
): ReviewDraft {
  prompt = parsePrompt(prompt);
  assertAssetPrompt(prompt);
  const originalRequest = parseAssetRequest(request);
  assertWaterIntent(waterIntent(prompt), originalRequest.waterLevel);
  return parseReviewDraft(
    {
      prompt,
      originalRequest,
      requirements,
      edits: {
        water: "keep",
        plantKind: "keep",
        density: "keep",
        rock: request.rockCount ? "unresolved" : "none",
      },
      selection: null,
      confirmedProceduralIds: [],
    },
    BUILTIN_CONTEXT,
  );
}
export function editReviewDraft(
  draft: ReviewDraft,
  edits: Partial<ReviewEdits>,
): ReviewDraft {
  const d = parseReviewDraft(draft, BUILTIN_CONTEXT);
  const next = parseReviewDraft(
    {
      ...d,
      edits: { ...d.edits, ...edits },
      selection: null,
      confirmedProceduralIds: [],
    },
    BUILTIN_CONTEXT,
  );
  // Check count/source edits even while a rock decision is still pending.
  resolveReviewRequest(
    next.edits.rock === "unresolved"
      ? { ...next, edits: { ...next.edits, rock: "placeholder" } }
      : next,
  );
  return next;
}
export function confirmReviewProcedural(
  draft: ReviewDraft,
  ids: string[],
): ReviewDraft {
  return parseReviewDraft(
    { ...draft, selection: null, confirmedProceduralIds: ids },
    BUILTIN_CONTEXT,
  );
}
export function setReviewSelection(
  draft: ReviewDraft,
  proof: SelectionProof,
  context: CatalogContext,
): ReviewDraft {
  return parseReviewDraft({ ...draft, selection: proof }, context);
}
export function compileReview(
  value: ReviewDraft,
  context: CatalogContext,
): ResolvedReview {
  if (context.prepared !== null)
    throw Error(
      "当前目录包含外加地表，请使用高级与旧版本兼容入口；不会自动替换地表。",
    );
  const draft = parseReviewDraft(value, context),
    effectiveRequest = resolveReviewRequest(draft);
  if (!draft.selection) throw Error("选材尚未完成，请先检查本次素材。");
  const choices =
    draft.selection.kind === "model"
      ? draft.selection.evidence.choices
      : draft.selection.choices;
  const base = compileSelection(
    effectiveRequest,
    { choices },
    draft.confirmedProceduralIds,
    context,
  );
  if (base.schemaVersion !== 1) throw Error("此预览仅支持内置河岸");
  const recipe: RiverbankRecipe = {
    ...base,
    algorithmVersion:
      effectiveRequest.plantKind === "reed"
        ? "f0-riverbank-reed-v1"
        : "f0-riverbank-grass-v1",
  };
  buildScene(recipe);
  return freeze({ draft, effectiveRequest, recipe });
}
