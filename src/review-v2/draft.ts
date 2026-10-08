import { record, oneOf } from "../data-validation";
import { freeze } from "../assets/catalog/metadata";
import {
  BUILTIN_CONTEXT,
  type CatalogContext,
} from "../assets/catalog/context";
import { parsePrompt } from "../planner/service";
import {
  assertAssetPrompt,
  parseAssetRequest,
  type AssetRequest,
} from "../selection/contract";
import { equal } from "../selection/service";
import {
  parseEdits,
  parseConfirmed,
  parseProof,
  resolveMaterialEdits,
  parseReviewDraft,
  compileReview,
  type ReviewEdits,
  type SelectionProof,
} from "../review/draft";
import type { RiverbankRecipe } from "../gaussian/types";
import { parseReviewRequestV2, type ReviewRequestV2 } from "./requirements";
import {
  parseRequirementEvidenceV2,
  type RequirementEvidenceV2,
} from "./service";
import {
  assertWaterRequirement,
  resolveWater,
  type WaterRequirement,
  type WaterResolution,
} from "./water";
export interface ReviewDraftV2 {
  schemaVersion: 2;
  prompt: string;
  requirements: RequirementEvidenceV2 | null;
  originalRequest: ReviewRequestV2;
  edits: ReviewEdits;
  selection: SelectionProof | null;
  confirmedProceduralIds: string[];
}
export interface ResolvedReviewV2 {
  draft: ReviewDraftV2;
  effectiveRequest: AssetRequest;
  recipe: RiverbankRecipe;
  waterResolution: Extract<WaterResolution, { status: "ready" }>;
}
export function effectiveWater(draft: ReviewDraftV2): WaterRequirement {
  const original = draft.originalRequest.water;
  if (draft.edits.water === "off") return { mode: "none", explicitLevel: null };
  if (
    draft.edits.water === "on" &&
    (original.mode === "none" || original.mode === "unspecified")
  )
    return { mode: "surface", explicitLevel: null };
  return original;
}
export function draftWaterResolution(
  draft: ReviewDraftV2,
  context: CatalogContext,
): WaterResolution {
  const resolution = resolveWater(effectiveWater(draft), context);
  return resolution.status === "ready" && draft.edits.water !== "keep"
    ? { ...resolution, source: "user-choice" }
    : resolution;
}
export function parseReviewDraftV2(
  value: unknown,
  context: CatalogContext,
): ReviewDraftV2 {
  const d = record(value, [
    "schemaVersion",
    "prompt",
    "requirements",
    "originalRequest",
    "edits",
    "selection",
    "confirmedProceduralIds",
  ]);
  oneOf(d.schemaVersion, [2]);
  const prompt = parsePrompt(d.prompt),
    originalRequest = parseReviewRequestV2(d.originalRequest);
  const requirements =
    d.requirements === null ? null : parseRequirementEvidenceV2(d.requirements);
  if (
    requirements &&
    (requirements.prompt !== prompt ||
      !equal(requirements.request, originalRequest))
  )
    throw Error("原始需求与模型证据不一致");
  const draft: ReviewDraftV2 = {
    schemaVersion: 2,
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
      resolveReviewRequestV2(draft, context),
      context,
    );
  return freeze(draft);
}
export function createReviewDraftV2(
  prompt: string,
  request: ReviewRequestV2,
  requirements: RequirementEvidenceV2 | null,
): ReviewDraftV2 {
  prompt = parsePrompt(prompt);
  assertAssetPrompt(prompt);
  const originalRequest = parseReviewRequestV2(request);
  assertWaterRequirement(prompt, originalRequest.water);
  return parseReviewDraftV2(
    {
      schemaVersion: 2,
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
export function editReviewDraftV2(
  value: ReviewDraftV2,
  edits: Partial<ReviewEdits>,
): ReviewDraftV2 {
  const draft = parseReviewDraftV2(value, BUILTIN_CONTEXT);
  const next = parseReviewDraftV2(
    {
      ...draft,
      edits: { ...draft.edits, ...edits },
      selection: null,
      confirmedProceduralIds: [],
    },
    BUILTIN_CONTEXT,
  );
  resolveMaterialEdits(
    next.originalRequest,
    next.edits.rock === "unresolved"
      ? { ...next.edits, rock: "placeholder" }
      : next.edits,
  );
  return next;
}
export function resolveReviewRequestV2(
  value: ReviewDraftV2,
  context: CatalogContext = BUILTIN_CONTEXT,
): AssetRequest {
  const draft = parseReviewDraftV2(
    value.selection === null ? value : { ...value, selection: null },
    context,
  );
  const water = draftWaterResolution(draft, context);
  if (water.status !== "ready") throw Error(water.message);
  return parseAssetRequest({
    ...resolveMaterialEdits(draft.originalRequest, draft.edits),
    waterLevel: water.waterLevel,
  });
}
export function confirmReviewProceduralV2(
  draft: ReviewDraftV2,
  ids: string[],
): ReviewDraftV2 {
  return parseReviewDraftV2(
    { ...draft, selection: null, confirmedProceduralIds: ids },
    BUILTIN_CONTEXT,
  );
}
export function setReviewSelectionV2(
  draft: ReviewDraftV2,
  proof: SelectionProof,
  context: CatalogContext,
): ReviewDraftV2 {
  return parseReviewDraftV2({ ...draft, selection: proof }, context);
}
export function compileReviewV2(
  value: ReviewDraftV2,
  context: CatalogContext,
): ResolvedReviewV2 {
  const draft = parseReviewDraftV2(value, context);
  const waterResolution = draftWaterResolution(draft, context);
  if (waterResolution.status !== "ready") throw Error(waterResolution.message);
  const effectiveRequest = resolveReviewRequestV2(draft, context);
  // Numerical adapter only after resolution. Original intent remains in the v2 draft;
  // this transient compiler input is never saved as original model evidence.
  const adapter = parseReviewDraft(
    {
      prompt: draft.prompt,
      requirements: null,
      originalRequest: effectiveRequest,
      edits: {
        water: "keep",
        plantKind: "keep",
        density: "keep",
        rock: effectiveRequest.rockCount ? "placeholder" : "none",
      },
      selection: draft.selection,
      confirmedProceduralIds: draft.confirmedProceduralIds,
    },
    context,
  );
  const { recipe } = compileReview(adapter, context);
  return freeze({ draft, effectiveRequest, recipe, waterResolution });
}
