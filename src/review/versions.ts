import * as oldDraft from "./draft";
import * as newDraft from "../review-v2/draft";
import * as oldHistory from "./history";
import * as newHistory from "../review-v2/history";
import { reviewSummary as oldSummary } from "./summary";
import { reviewSummaryV2 } from "../review-v2/summary";
import {
  BUILTIN_CONTEXT,
  type CatalogContext,
} from "../assets/catalog/context";
import type { BuildResult } from "../gaussian/types";
export type ReviewDraft = oldDraft.ReviewDraft | newDraft.ReviewDraftV2;
export type ResolvedReview =
  oldDraft.ResolvedReview | newDraft.ResolvedReviewV2;
export type SceneReviewRecord =
  oldHistory.SceneReviewRecord | newHistory.SceneReviewRecordV2;
export type { ReviewEdits } from "./draft";
export const isV2 = (draft: ReviewDraft): draft is newDraft.ReviewDraftV2 =>
  "schemaVersion" in draft && draft.schemaVersion === 2;
export const createReviewDraft = newDraft.createReviewDraftV2;
export const editReviewDraft = (
  draft: ReviewDraft,
  edits: Partial<oldDraft.ReviewEdits>,
): ReviewDraft =>
  isV2(draft)
    ? newDraft.editReviewDraftV2(draft, edits)
    : oldDraft.editReviewDraft(draft, edits);
export const resolveReviewRequest = (
  draft: ReviewDraft,
  context = BUILTIN_CONTEXT,
) =>
  isV2(draft)
    ? newDraft.resolveReviewRequestV2(draft, context)
    : oldDraft.resolveReviewRequest(draft);
export const confirmReviewProcedural = (
  draft: ReviewDraft,
  ids: string[],
): ReviewDraft =>
  isV2(draft)
    ? newDraft.confirmReviewProceduralV2(draft, ids)
    : oldDraft.confirmReviewProcedural(draft, ids);
export const setReviewSelection = (
  draft: ReviewDraft,
  proof: oldDraft.SelectionProof,
  context: CatalogContext,
): ReviewDraft =>
  isV2(draft)
    ? newDraft.setReviewSelectionV2(draft, proof, context)
    : oldDraft.setReviewSelection(draft, proof, context);
export const compileReview = (
  draft: ReviewDraft,
  context: CatalogContext,
): ResolvedReview =>
  isV2(draft)
    ? newDraft.compileReviewV2(draft, context)
    : oldDraft.compileReview(draft, context);
export const reviewSummary = (
  draft: ReviewDraft,
  result?: BuildResult,
  context = BUILTIN_CONTEXT,
) =>
  isV2(draft)
    ? reviewSummaryV2(draft, result, context)
    : oldSummary(draft, result);
export const historyKey = (r: SceneReviewRecord) =>
  r.schemaVersion === 2
    ? newHistory.REVIEW_HISTORY_KEY_V2
    : oldHistory.REVIEW_HISTORY_KEY;
export const createReviewRecord = (
  review: ResolvedReview,
): Promise<SceneReviewRecord> =>
  "waterResolution" in review
    ? newHistory.createReviewRecordV2(review)
    : oldHistory.createReviewRecord(review);
export const appendReviewRecord = (
  storage: oldHistory.StoragePort,
  r: SceneReviewRecord,
  context: CatalogContext,
  lock: oldHistory.HistoryLock,
) =>
  r.schemaVersion === 2
    ? newHistory.appendReviewRecordV2(storage, r, context, lock)
    : oldHistory.appendReviewRecord(storage, r, context, lock);
export async function importReviewRecord(
  content: string,
  context: CatalogContext,
): Promise<SceneReviewRecord> {
  if (new TextEncoder().encode(content).byteLength > 1048576)
    throw Error("审阅记录超过1MiB");
  return JSON.parse(content)?.schemaVersion === 2
    ? newHistory.importReviewRecordV2(content, context)
    : oldHistory.importReviewRecord(content, context);
}
export async function loadReviewHistory(
  storage: oldHistory.StoragePort,
  context: CatalogContext,
): Promise<{ records: SceneReviewRecord[]; error: string | null }> {
  const [a, b] = await Promise.all([
    oldHistory.loadReviewHistory(storage, context),
    newHistory.loadReviewHistoryV2(storage, context),
  ]);
  return {
    records: [...b.records, ...a.records],
    error: [a.error, b.error].filter(Boolean).join(" ") || null,
  };
}
