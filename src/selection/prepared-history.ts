import type { AssetPlanRecord } from "./history";
import type { SceneRecipe } from "../gaussian/types";
import { record, oneOf } from "../data-validation";
import { text, parseAssetMetadata } from "../assets/catalog/metadata";
import {
  parseCatalogContext,
  type CatalogContext,
} from "../assets/catalog/context";
import { canonicalJson, jsonDigest } from "../io/prepared-ground";
import { compileSelection } from "./contract";
import {
  parseRequirementEvidence,
  parseChoiceEvidence,
  equal,
  type RequirementEvidence,
  type ChoiceEvidence,
} from "./service";
import { errorText } from "../planner/service";
export const PREPARED_HISTORY_KEY = "wetland.assetPlans.v2";
const LIMIT = 1048576;
type StoragePort = Pick<Storage, "getItem" | "setItem">;
export interface PreparedAssetPlanRecord extends Omit<
  AssetPlanRecord,
  "schemaVersion" | "recipe"
> {
  schemaVersion: 2;
  recipe: SceneRecipe;
  catalogContext: CatalogContext;
}
function id(value: unknown) {
  const s = text(value, 36);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(s))
    throw Error("Invalid record ID");
  return s;
}
const source = (r: RequirementEvidence | null, s: ChoiceEvidence) =>
  r === null ? "manual" : equal(r.request, s.request) ? "model" : "edited";
export async function confirmPreparedAssetPlan(
  requirements: RequirementEvidence | null,
  selection: ChoiceEvidence,
  confirmedProceduralIds: readonly string[],
  context: CatalogContext,
  parentId: string | null = null,
  origin: "local" | "imported" = "local",
): Promise<PreparedAssetPlanRecord> {
  const c = await parseCatalogContext(context);
  if (!c.prepared) throw Error("缺少匹配的已安装地表目录");
  const r =
      requirements === null ? null : parseRequirementEvidence(requirements),
    s = parseChoiceEvidence(selection, c),
    recipe = compileSelection(
      s.request,
      { choices: s.choices },
      confirmedProceduralIds,
      c,
    );
  return {
    format: "wetland-asset-plan",
    schemaVersion: 2,
    id: crypto.randomUUID(),
    parentId: parentId === null ? null : id(parentId),
    confirmedAt: new Date().toISOString(),
    requirements: r,
    requirementsSource: source(r, s),
    selection: s,
    confirmedProceduralIds: [...confirmedProceduralIds].sort(),
    assets: s.choices.map((v) =>
      parseAssetMetadata(c.entries.find((a) => a.id === v.assetId)),
    ),
    recipe,
    recipeHash: await jsonDigest(recipe),
    origin: oneOf(origin, ["local", "imported"] as const),
    catalogContext: c,
  };
}
export async function importPreparedAssetPlan(
  content: string,
  context: CatalogContext,
): Promise<PreparedAssetPlanRecord> {
  if (new TextEncoder().encode(content).byteLength > LIMIT)
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
    "catalogContext",
  ]);
  if (p.format !== "wetland-asset-plan" || p.schemaVersion !== 2)
    throw Error("不是选材记录v2");
  const c = await parseCatalogContext(context);
  if (!c.prepared || canonicalJson(p.catalogContext) !== canonicalJson(c))
    throw Error("缺少匹配的素材或目录版本，原记录保留");
  if (!Array.isArray(p.confirmedProceduralIds)) throw Error("程序确认清单无效");
  const r = await confirmPreparedAssetPlan(
    p.requirements as any,
    p.selection as any,
    p.confirmedProceduralIds.map((v) => text(v, 100)),
    c,
    p.parentId as any,
    oneOf(p.origin, ["local", "imported"] as const),
  );
  const confirmedAt = text(p.confirmedAt, 30);
  if (
    !Number.isFinite(Date.parse(confirmedAt)) ||
    new Date(confirmedAt).toISOString() !== confirmedAt
  )
    throw Error("确认时间无效");
  for (const k of [
    "recipe",
    "recipeHash",
    "assets",
    "requirementsSource",
    "confirmedProceduralIds",
  ] as const)
    if (canonicalJson(p[k]) !== canonicalJson(r[k]))
      throw Error("选材内容、确认配方或摘要不一致");
  return { ...r, id: id(p.id), confirmedAt, origin: "imported" };
}
async function readRecords(content: string, context?: CatalogContext) {
  if (new TextEncoder().encode(content).byteLength > LIMIT)
    throw Error("历史超过1MiB");
  const list: unknown = JSON.parse(content);
  if (!Array.isArray(list) || list.length > 20) throw Error("历史列表无效");
  return Promise.all(
    list.map(async (v) =>
      importPreparedAssetPlan(
        JSON.stringify(v),
        context ?? (await parseCatalogContext(v?.catalogContext)),
      ),
    ),
  );
}
export async function loadPreparedHistory(
  storage: StoragePort,
  context: CatalogContext,
) {
  try {
    return {
      records: await readRecords(
        storage.getItem(PREPARED_HISTORY_KEY) ?? "[]",
        context,
      ),
      error: null,
    };
  } catch (e) {
    return {
      records: [] as PreparedAssetPlanRecord[],
      error: `选材历史未载入：${errorText(e)}`,
    };
  }
}
export async function savePreparedHistory(
  storage: StoragePort,
  records: PreparedAssetPlanRecord[],
) {
  const kept = records.slice(0, 20);
  while (
    kept.length &&
    new TextEncoder().encode(JSON.stringify(kept)).byteLength > LIMIT
  )
    kept.pop();
  const notice =
    kept.length < records.length
      ? `已移出${records.length - kept.length}条较旧选材记录，请保留下载文件。`
      : null;
  try {
    const before = storage.getItem(PREPARED_HISTORY_KEY);
    await readRecords(before ?? "[]");
    await readRecords(JSON.stringify(kept));
    if (storage.getItem(PREPARED_HISTORY_KEY) !== before)
      throw Error("历史在校验期间改变，未覆盖");
    storage.setItem(PREPARED_HISTORY_KEY, JSON.stringify(kept));
    return { records: kept, notice, error: null };
  } catch (e) {
    return {
      records: kept,
      notice,
      error: `选材历史保存失败，请下载记录：${errorText(e)}`,
    };
  }
}
