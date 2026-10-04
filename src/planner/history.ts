import type { F0Recipe } from "../gaussian/types";
import { parseRecipe, defaultRecipe } from "../recipe";
import { record, finite, oneOf } from "../data-validation";
import { terrainIntent, assertTerrainIntent } from "./terrain-intent";
import {
  demoPlan,
  modelForBackend,
  parseModel,
  parseBackend,
  errorText,
  parsePrompt,
  type PlanDraft,
} from "./service";
import {
  parseProposal,
  proposalFromRecipe,
  toRecipe,
  type Proposal,
} from "./contract";

export const HISTORY_KEY = "wetland.plans.v1";
const MAX_BYTES = 1048576;
export type PlanRecord = {
  schemaVersion: 3;
  id: string;
  parentId: string | null;
  createdAt: string;
  confirmedAt: string;
  draft: PlanDraft;
  proposal: Proposal;
  recipe: F0Recipe;
  recipeHash: string;
  kind: "direct" | "manual";
  origin: "local" | "imported";
};
type StoragePort = Pick<Storage, "getItem" | "setItem">;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function text(v: unknown, max: number, allowEmpty = false): string {
  if (typeof v !== "string" || (!allowEmpty && !v.length) || v.length > max)
    throw Error("文本长度无效");
  return v;
}
function parseVersionedDraft(value: unknown, version: 1 | 2 | 3): PlanDraft {
  const legacy = version === 1;
  const d = record(value, [
    "prompt",
    "proposal",
    "source",
    "repaired",
    "attempts",
    "templateVersion",
    "elapsedMs",
    "reason",
    ...(legacy ? [] : ["backend"]),
    ...(version === 3 ? ["model"] : []),
  ]);
  const source = legacy
    ? oneOf(d.source, ["ollama", "default", "demo"] as const)
    : oneOf(d.source, ["ollama", "llama.cpp", "default", "demo"] as const);
  const backend = legacy
    ? source === "demo"
      ? null
      : "ollama"
    : d.backend === null
      ? null
      : parseBackend(d.backend);
  if (
    (source === "demo") !== (backend === null) ||
    ((source === "ollama" || source === "llama.cpp") && source !== backend)
  )
    throw Error("规划来源与后端不一致");
  if (!Array.isArray(d.attempts) || d.attempts.length > 2)
    throw Error("尝试记录无效");
  const draft: PlanDraft = {
    prompt: parsePrompt(d.prompt),
    proposal: parseProposal(d.proposal),
    source,
    backend,
    model: backend === null ? null : parseModel(backend,
      version === 3 ? d.model : modelForBackend(backend)),
    repaired: oneOf(d.repaired, [true, false]),
    templateVersion: oneOf(d.templateVersion, ["parameters-v1", "parameters-v2"] as const),
    elapsedMs: finite(d.elapsedMs, 0, 3600000),
    reason: d.reason === null ? null : text(d.reason, 4096),
    attempts: d.attempts.map((value) => {
      const a = record(value, ["raw", "model", "error", "elapsedMs"]);
      return {
        raw: text(a.raw, 65536, true),
        model: a.model === null ? null : text(a.model, 200),
        error: a.error === null ? null : text(a.error, 2048),
        elapsedMs: finite(a.elapsedMs, 0, 3600000),
      };
    }),
  };
  if (version === 3 && backend === null && d.model !== null)
    throw Error("离线示例不能声明模型");
  const last = draft.attempts.at(-1);
  if (draft.source === "ollama" || draft.source === "llama.cpp") {
    if (
      !last ||
      last.error !== null ||
      last.model !== draft.model ||
      draft.reason !== null ||
      draft.repaired !== (draft.attempts.length === 2) ||
      (draft.repaired && !draft.attempts[0].error) ||
      !equal(parseProposal(JSON.parse(last.raw)), draft.proposal)
    )
      throw Error("模型证据与配方不一致");
    if (draft.templateVersion === "parameters-v2")
      assertTerrainIntent(terrainIntent(draft.prompt), draft.proposal);
  } else if (draft.source === "default") {
    if (
      !last ||
      draft.repaired ||
      !draft.reason ||
      draft.attempts.some((a) => !a.error) ||
      !equal(draft.proposal, proposalFromRecipe(defaultRecipe))
    )
      throw Error("默认回退记录不一致");
  } else if (
    draft.attempts.length ||
    draft.repaired ||
    !draft.reason ||
    !equal(draft.proposal, demoPlan().proposal)
  )
    throw Error("离线示例记录不一致");
  return draft;
}
export function parseDraft(value: unknown): PlanDraft {
  return parseVersionedDraft(value, 3);
}
export async function recipeDigest(recipe: F0Recipe): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parseRecipe(recipe)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function id(value: unknown): string {
  const s = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s))
    throw Error("版本ID无效");
  return s;
}
function date(value: unknown): string {
  const s = text(value, 30);
  if (!Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s)
    throw Error("时间格式无效");
  return s;
}
export async function confirmPlan(
  draft: PlanDraft,
  selected?: F0Recipe,
  parentId: string | null = null,
): Promise<PlanRecord> {
  draft = parseDraft(draft);
  const recipe = parseRecipe(selected ?? toRecipe(draft.proposal));
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    id: crypto.randomUUID(),
    parentId: parentId === null ? null : id(parentId),
    createdAt: now,
    confirmedAt: now,
    draft,
    proposal: proposalFromRecipe(recipe),
    recipe,
    recipeHash: await recipeDigest(recipe),
    kind: equal(recipe, toRecipe(draft.proposal)) ? "direct" : "manual",
    origin: "local",
  };
}
export function exportPlan(plan: PlanRecord): string {
  return JSON.stringify(plan, null, 2);
}
export async function importPlan(content: string): Promise<PlanRecord> {
  if (new TextEncoder().encode(content).byteLength > MAX_BYTES)
    throw Error("规划文件超过1MiB");
  const r = record(JSON.parse(content), [
    "schemaVersion",
    "id",
    "parentId",
    "createdAt",
    "confirmedAt",
    "draft",
    "proposal",
    "recipe",
    "recipeHash",
    "kind",
    "origin",
  ]);
  const version = oneOf(r.schemaVersion, [1, 2, 3] as const);
  const recipe = parseRecipe(r.recipe),
    draft = parseVersionedDraft(r.draft, version),
    proposal = parseProposal(r.proposal);
  const hash = text(r.recipeHash, 64),
    kind = oneOf(r.kind, ["direct", "manual"] as const);
  oneOf(r.origin, ["local", "imported"]);
  if (
    hash !== (await recipeDigest(recipe)) ||
    !equal(proposal, proposalFromRecipe(recipe)) ||
    kind !== (equal(recipe, toRecipe(draft.proposal)) ? "direct" : "manual")
  )
    throw Error("确认配方、来源或内容摘要不一致");
  return {
    schemaVersion: 3,
    id: id(r.id),
    parentId: r.parentId === null ? null : id(r.parentId),
    createdAt: date(r.createdAt),
    confirmedAt: date(r.confirmedAt),
    draft,
    proposal,
    recipe,
    recipeHash: hash,
    kind,
    // Hash verifies consistency, not authenticity. External provenance is never a fresh inference.
    origin: "imported",
  };
}
export type HistorySaveResult = {
  records: PlanRecord[];
  error: string | null;
  notice: string | null;
  evicted: { count: number; countLimit: number; byteLimit: number };
};
export function saveHistory(
  storage: StoragePort,
  records: PlanRecord[],
): HistorySaveResult {
  const kept = records.slice(0, 20),
    countLimit = Math.max(0, records.length - kept.length);
  let byteLimit = 0;
  while (
    kept.length &&
    new TextEncoder().encode(JSON.stringify(kept)).length > MAX_BYTES
  ) {
    kept.pop();
    byteLimit++;
  }
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(kept));
    const count = countLimit + byteLimit;
    const reasons = [
      countLimit ? "20条数量上限" : "",
      byteLimit ? "1MiB容量上限" : "",
    ]
      .filter(Boolean)
      .join("与");
    return {
      records: kept,
      error: null,
      evicted: { count, countLimit, byteLimit },
      notice: count
        ? `为保持${reasons}，已从本机历史移出 ${count} 条较旧记录。已下载的JSON文件不受影响。`
        : null,
    };
  } catch (error) {
    return {
      records: kept,
      notice: null,
      evicted: { count: 0, countLimit: 0, byteLimit: 0 },
      error: `浏览器历史保存失败，可下载当前规划文件：${errorText(error)}`,
    };
  }
}
export async function loadHistory(
  storage: StoragePort,
): Promise<{ records: PlanRecord[]; error: string | null }> {
  try {
    const content = storage.getItem(HISTORY_KEY) ?? "[]";
    if (new TextEncoder().encode(content).length > MAX_BYTES)
      throw Error("历史数据超过1MiB");
    const values: unknown = JSON.parse(content);
    if (!Array.isArray(values) || values.length > 20)
      throw Error("历史列表无效");
    return {
      records: await Promise.all(
        values.map((v) => importPlan(JSON.stringify(v))),
      ),
      error: null,
    };
  } catch (error) {
    return { records: [], error: `历史记录未载入：${errorText(error)}` };
  }
}
