import { record, oneOf } from "../data-validation";
import {
  text,
  parseAssetMetadata,
  type AssetMetadata,
} from "../assets/catalog/metadata";
import { assetCatalog } from "../assets/catalog/entries";
import { compileSelection } from "./contract";
import {
  equal,
  parseRequirementEvidence,
  parseChoiceEvidence,
  type RequirementEvidence,
  type ChoiceEvidence,
} from "./service";
import { recipeDigest } from "../planner/history";
import { parseRecipe } from "../recipe";
import { errorText } from "../planner/service";
import type { F0Recipe } from "../gaussian/types";
export const ASSET_HISTORY_KEY = "wetland.assetPlans.v1";
const MAX_BYTES = 1048576;
type StoragePort = Pick<Storage, "getItem" | "setItem">;
export interface AssetPlanRecord {
  format: "wetland-asset-plan";
  schemaVersion: 1;
  id: string;
  parentId: string | null;
  confirmedAt: string;
  requirements: RequirementEvidence | null;
  requirementsSource: "manual" | "model" | "edited";
  selection: ChoiceEvidence;
  confirmedProceduralIds: string[];
  assets: AssetMetadata[];
  recipe: F0Recipe;
  recipeHash: string;
  origin: "local" | "imported";
}
function id(v: unknown) {
  const s = text(v, 36);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(s))
    throw Error("选材记录ID无效");
  return s;
}
const source = (r: RequirementEvidence | null, s: ChoiceEvidence) =>
  r === null ? "manual" : equal(r.request, s.request) ? "model" : "edited";
function selectedAssets(s: ChoiceEvidence): AssetMetadata[] {
  return s.choices.map((c) =>
    parseAssetMetadata(assetCatalog.find((a) => a.id === c.assetId)),
  );
}
export async function confirmAssetPlan(
  requirements: RequirementEvidence | null,
  selection: ChoiceEvidence,
  confirmedProceduralIds: readonly string[],
  parentId: string | null = null,
  origin: "local" | "imported" = "local",
): Promise<AssetPlanRecord> {
  const r =
      requirements === null ? null : parseRequirementEvidence(requirements),
    s = parseChoiceEvidence(selection),
    recipe = compileSelection(
      s.request,
      { choices: s.choices },
      confirmedProceduralIds,
    );
  return {
    format: "wetland-asset-plan",
    schemaVersion: 1,
    id: crypto.randomUUID(),
    parentId: parentId === null ? null : id(parentId),
    confirmedAt: new Date().toISOString(),
    requirements: r,
    requirementsSource: source(r, s),
    selection: s,
    confirmedProceduralIds: [...confirmedProceduralIds].sort(),
    assets: selectedAssets(s),
    recipe,
    recipeHash: await recipeDigest(recipe),
    origin: oneOf(origin, ["local", "imported"] as const),
  };
}
export function exportAssetPlan(p: AssetPlanRecord) {
  return JSON.stringify(p, null, 2);
}
export async function importAssetPlan(
  content: string,
): Promise<AssetPlanRecord> {
  if (new TextEncoder().encode(content).byteLength > MAX_BYTES)
    throw Error("选材文件超过1MiB");
  const p = record(JSON.parse(content), [
    "format",
    "schemaVersion",
    "id",
    "parentId",
    "confirmedAt",
    "requirements",
    "requirementsSource",
    "selection",
    "confirmedProceduralIds",
    "assets",
    "recipe",
    "recipeHash",
    "origin",
  ]);
  if (p.format !== "wetland-asset-plan" || p.schemaVersion !== 1)
    throw Error("不是选材记录v1；旧规划JSON请用原规划入口");
  const r =
      p.requirements === null ? null : parseRequirementEvidence(p.requirements),
    s = parseChoiceEvidence(p.selection);
  if (!Array.isArray(p.confirmedProceduralIds)) throw Error("程序确认清单无效");
  const confirmed = p.confirmedProceduralIds.map((v) => text(v, 100));
  const recipe = compileSelection(s.request, { choices: s.choices }, confirmed),
    assets = selectedAssets(s);
  const confirmedAt = text(p.confirmedAt, 30);
  if (
    !Number.isFinite(Date.parse(confirmedAt)) ||
    new Date(confirmedAt).toISOString() !== confirmedAt
  )
    throw Error("确认时间无效");
  oneOf(p.origin, ["local", "imported"] as const);
  if (
    !equal(p.recipe, parseRecipe(p.recipe)) ||
    !equal(recipe, p.recipe) ||
    p.recipeHash !== (await recipeDigest(recipe)) ||
    p.requirementsSource !== source(r, s) ||
    !equal(p.assets, assets)
  )
    throw Error("选材、目录内容版本、确认配方或摘要不一致");
  return {
    format: "wetland-asset-plan",
    schemaVersion: 1,
    id: id(p.id),
    parentId: p.parentId === null ? null : id(p.parentId),
    confirmedAt,
    requirements: r,
    requirementsSource: source(r, s),
    selection: s,
    confirmedProceduralIds: confirmed,
    assets,
    recipe,
    recipeHash: String(p.recipeHash),
    origin: "imported",
  };
}
export async function loadAssetHistory(
  storage: StoragePort,
): Promise<{ records: AssetPlanRecord[]; error: string | null }> {
  try {
    const content = storage.getItem(ASSET_HISTORY_KEY) ?? "[]";
    if (new TextEncoder().encode(content).byteLength > MAX_BYTES)
      throw Error("历史超过1MiB");
    const list: unknown = JSON.parse(content);
    if (!Array.isArray(list) || list.length > 20) throw Error("历史列表无效");
    return {
      records: await Promise.all(
        list.map((v) => importAssetPlan(JSON.stringify(v))),
      ),
      error: null,
    };
  } catch (e) {
    return { records: [], error: `选材历史未载入：${errorText(e)}` };
  }
}
export function saveAssetHistory(
  storage: StoragePort,
  records: AssetPlanRecord[],
): { records: AssetPlanRecord[]; notice: string | null; error: string | null } {
  const kept = records.slice(0, 20);
  while (
    kept.length &&
    new TextEncoder().encode(JSON.stringify(kept)).byteLength > MAX_BYTES
  )
    kept.pop();
  const removed = records.length - kept.length,
    notice = removed
      ? `为保持20条/1MiB上限，已移出${removed}条较旧选材记录；下载文件不受影响。`
      : null;
  try {
    storage.setItem(ASSET_HISTORY_KEY, JSON.stringify(kept));
    return { records: kept, notice, error: null };
  } catch (e) {
    return {
      records: kept,
      notice,
      error: `选材历史保存失败，请下载记录：${errorText(e)}`,
    };
  }
}
