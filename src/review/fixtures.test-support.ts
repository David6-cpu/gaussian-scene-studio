import { BUILTIN_CONTEXT } from "../assets/catalog/context";
import {
  defaultAssetRequest,
  candidateSnapshot,
  proceduralIds,
  type AssetRequest,
} from "../selection/contract";
import {
  createReviewDraft,
  editReviewDraft,
  confirmReviewProcedural,
  setReviewSelection,
  resolveReviewRequest,
  type ReviewDraft,
} from "./draft";

// Constructed manual fixture. Never represents a real model inference.
export function reviewFixture(
  overrides: Partial<AssetRequest> = {},
): ReviewDraft {
  const request = { ...defaultAssetRequest, ...overrides };
  let draft = createReviewDraft("人工测试需求", request, null);
  if (request.rockCount)
    draft = editReviewDraft(draft, { rock: "placeholder" });
  const effective = resolveReviewRequest(draft);
  const choices = candidateSnapshot(effective).map((s) => ({
    key: s.key,
    assetId: s.assetIds[0],
  }));
  draft = confirmReviewProcedural(draft, proceduralIds(choices));
  return setReviewSelection(
    draft,
    {
      kind: "manual",
      request: effective,
      catalogVersion: BUILTIN_CONTEXT.catalogVersion,
      choices,
    },
    BUILTIN_CONTEXT,
  );
}
