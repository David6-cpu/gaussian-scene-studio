import { record, oneOf } from "../data-validation";
import { freeze, text } from "../assets/catalog/metadata";
import {
  BUILTIN_CONTEXT,
  type CatalogContext,
} from "../assets/catalog/context";
import { errorText } from "../planner/service";
import { recipeDigest } from "../planner/history";
import { equal } from "../selection/service";
import type { AssetRequest } from "../selection/contract";
import type { RiverbankRecipe } from "../gaussian/types";
import {
  compileReviewV2 as compileReview,
  parseReviewDraftV2 as parseReviewDraft,
  type ReviewDraftV2 as ReviewDraft,
  type ResolvedReviewV2 as ResolvedReview,
} from "./draft";
import type { WaterResolution } from "./water";

export const REVIEW_HISTORY_KEY_V2 = "wetland.sceneReviews.v2";
const MAX_BYTES = 1048576;
export type StoragePort = Pick<Storage, "getItem" | "setItem">;
export type HistoryLock = <T>(job: () => Promise<T>) => Promise<T>;
export interface SceneReviewRecordV2 {
  format: "wetland-scene-review";
  schemaVersion: 2;
  id: string;
  parentId: string | null;
  confirmedAt: string;
  draft: ReviewDraft;
  effectiveRequest: AssetRequest;
  recipe: RiverbankRecipe;
  recipeHash: string;
  waterResolution: Extract<WaterResolution, { status: "ready" }>;
  origin: "local" | "imported";
}
function uuid(value: unknown): string {
  const id = text(value, 36);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
    throw Error("审阅记录ID或父记录格式无效");
  return id;
}
function bounded(content: string): void {
  if (new TextEncoder().encode(content).byteLength > MAX_BYTES)
    throw Error("审阅记录超过1MiB");
}
export async function createReviewRecordV2(
  review: ResolvedReview,
  parentId: string | null = null,
): Promise<SceneReviewRecordV2> {
  const checked = compileReview(review.draft, BUILTIN_CONTEXT);
  if (
    !equal(checked.recipe, review.recipe) ||
    !equal(checked.effectiveRequest, review.effectiveRequest) ||
    !equal(checked.waterResolution, review.waterResolution)
  )
    throw Error("审阅结果与草稿不一致");
  return freeze({
    format: "wetland-scene-review",
    schemaVersion: 2,
    id: crypto.randomUUID(),
    parentId: parentId === null ? null : uuid(parentId),
    confirmedAt: new Date().toISOString(),
    ...checked,
    recipeHash: await recipeDigest(checked.recipe),
    origin: "local",
  });
}
async function parseRecord(
  value: unknown,
  context: CatalogContext,
): Promise<SceneReviewRecordV2> {
  const r = record(value, [
    "format",
    "schemaVersion",
    "id",
    "parentId",
    "confirmedAt",
    "draft",
    "effectiveRequest",
    "recipe",
    "recipeHash",
    "waterResolution",
    "origin",
  ]);
  oneOf(r.format, ["wetland-scene-review"]);
  oneOf(r.schemaVersion, [2]);
  const draft = parseReviewDraft(r.draft, context),
    compiled = compileReview(draft, context);
  const confirmedAt = text(r.confirmedAt, 30);
  if (
    !Number.isFinite(Date.parse(confirmedAt)) ||
    new Date(confirmedAt).toISOString() !== confirmedAt
  )
    throw Error("审阅确认时间无效");
  const recipeHash = await recipeDigest(compiled.recipe);
  if (
    !equal(r.recipe, compiled.recipe) ||
    !equal(r.effectiveRequest, compiled.effectiveRequest) ||
    r.recipeHash !== recipeHash ||
    !equal(r.waterResolution, compiled.waterResolution)
  )
    throw Error("记录的有效需求、配方或摘要不一致");
  const id = uuid(r.id),
    parentId = r.parentId === null ? null : uuid(r.parentId);
  if (id === parentId) throw Error("父记录不能是自身");
  return freeze({
    format: "wetland-scene-review",
    schemaVersion: 2,
    id,
    parentId,
    confirmedAt,
    ...compiled,
    recipeHash,
    origin: oneOf(r.origin, ["local", "imported"] as const),
  });
}
export async function importReviewRecordV2(
  content: string,
  context: CatalogContext,
): Promise<SceneReviewRecordV2> {
  bounded(content);
  return freeze({
    ...(await parseRecord(JSON.parse(content), context)),
    origin: "imported",
  });
}
async function parseList(
  content: string | null,
  context: CatalogContext,
): Promise<SceneReviewRecordV2[]> {
  bounded(content ?? "[]");
  const list: unknown = JSON.parse(content ?? "[]");
  if (!Array.isArray(list) || list.length > 20)
    throw Error("审阅历史须为最多20条的列表");
  const records = await Promise.all(
    list.map((value) => parseRecord(value, context)),
  );
  if (new Set(records.map((r) => r.id)).size !== records.length)
    throw Error("审阅历史存在重复ID");
  return records;
}
export async function loadReviewHistoryV2(
  storage: StoragePort,
  context: CatalogContext,
): Promise<{ records: SceneReviewRecordV2[]; error: string | null }> {
  try {
    return {
      records: await parseList(storage.getItem(REVIEW_HISTORY_KEY_V2), context),
      error: null,
    };
  } catch (e) {
    return {
      records: [],
      error: `审阅历史未载入，原数据已保留：${errorText(e)}`,
    };
  }
}
export async function appendReviewRecordV2(
  storage: StoragePort,
  candidate: SceneReviewRecordV2,
  context: CatalogContext,
  lock: HistoryLock,
): Promise<{
  records: SceneReviewRecordV2[];
  error: string | null;
  notice: string | null;
}> {
  let records: SceneReviewRecordV2[] = [];
  try {
    // Capture input before awaiting the cross-tab lock; callers cannot mutate the queued write.
    const incoming = JSON.stringify(candidate);
    bounded(incoming);
    return await lock(async () => {
      const before = storage.getItem(REVIEW_HISTORY_KEY_V2);
      records = await parseList(before, context);
      const checked = await parseRecord(JSON.parse(incoming), context);
      if (storage.getItem(REVIEW_HISTORY_KEY_V2) !== before)
        throw Error(
          "审阅历史在校验期间发生变化，存在写入冲突；未覆盖其他标签的数据。",
        );
      const duplicate = records.find((r) => r.id === checked.id);
      if (duplicate) {
        if (!equal(duplicate, { ...checked, origin: duplicate.origin }))
          throw Error("重复记录ID对应不同内容，存在冲突。");
        return { records, error: null, notice: "此记录已保存，未重复添加。" };
      }
      if (records.length >= 20)
        throw Error("已有20条审阅记录，未自动删除旧记录；请下载本次记录。");
      const next = [checked, ...records],
        content = JSON.stringify(next);
      bounded(content);
      // No await between final comparison and synchronous write. All app writers share the lock.
      if (storage.getItem(REVIEW_HISTORY_KEY_V2) !== before)
        throw Error("审阅历史发生变化，未覆盖并发写入。");
      storage.setItem(REVIEW_HISTORY_KEY_V2, content);
      return { records: next, error: null, notice: null };
    });
  } catch (e) {
    return {
      records,
      error: `审阅记录未保存，原历史保留；请下载本次记录：${errorText(e)}`,
      notice: null,
    };
  }
}
