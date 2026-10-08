import { record, oneOf, finite } from "../data-validation";
import { freeze } from "../assets/catalog/metadata";
import {
  BUILTIN_CONTEXT,
  type CatalogContext,
} from "../assets/catalog/context";
import { waterIntent } from "../planner/water-intent";

export interface WaterRequirement {
  mode: "river" | "surface" | "none" | "unspecified";
  explicitLevel: number | null;
}
export function parseWaterRequirement(value: unknown): WaterRequirement {
  const w = record(value, ["mode", "explicitLevel"]);
  const mode = oneOf(w.mode, [
    "river",
    "surface",
    "none",
    "unspecified",
  ] as const);
  const explicitLevel =
    w.explicitLevel === null ? null : finite(w.explicitLevel, -0.5, 0.5);
  if ((mode === "none" || mode === "unspecified") && explicitLevel !== null)
    throw Error("水体要求冲突：无水或未指定水体不能同时指定水位。");
  return freeze({ mode, explicitLevel });
}
export function waterRequirement(prompt: string): WaterRequirement {
  const clauses = prompt
    .split(/[，,；;。！？\n]/)
    .filter((c) => /水|河|溪/.test(c))
    .join("，");
  if (
    /不要(?:没有|无)|不能(?:没有|无)|并非|不是|避免|不想|(?:不|别|不要|不能|不应|不该|无需|不必)\s*(?:再|是|变得|变成)?\s*(?:干涸|干枯|干燥|干河床)/.test(
      clauses,
    )
  )
    throw Error(
      "请澄清水体要求：含否定或不确定表述，请明确有水、无水或具体水位。",
    );
  // Extend the live v2 vocabulary without changing the legacy/archive rules.
  // Consume negated surfaces before treating a remaining surface as present;
  // the shared check can then detect dry/wet conflicts in the full sentence.
  // Neither the model input nor its saved raw response is rewritten.
  const normalized = prompt
    .replace(/干(?:燥|枯)?(?:的)?河床/g, "干涸河床")
    .replace(
      /(?:不(?:要|用|需(?:要)?|放|加|添加|留)?|无|没有)\s*(?:一(?:片|块|些|汪)\s*)?水面/g,
      "无水",
    )
    .replace(/水面/g, "有水");
  const intent = waterIntent(normalized);
  if (intent.mode === "clarify") throw Error(intent.message);
  if (intent.mode === "absent") return { mode: "none", explicitLevel: null };
  if (intent.mode === "unspecified")
    return { mode: "unspecified", explicitLevel: null };
  return {
    mode: /河岸|河边|河流|河床|小河|河里|河道|溪流|溪边/.test(clauses)
      ? "river"
      : "surface",
    explicitLevel: intent.level ?? null,
  };
}
export function assertWaterRequirement(
  prompt: string,
  actual: WaterRequirement,
): void {
  const expected = waterRequirement(prompt);
  if (
    actual.mode !== expected.mode ||
    actual.explicitLevel !== expected.explicitLevel
  )
    throw Error(
      "水体要求不一致：模型漏掉、添加或改写了水体/水位要求；本次结果未采用，请核对描述。",
    );
}
export type WaterResolution =
  | { status: "pending" | "blocked"; message: string }
  | {
      status: "ready";
      waterLevel: number | null;
      source: "absence" | "explicit" | "user-choice";
      terrain: { id: string; contentVersion: string };
      policyVersion: "water-v2-no-auto-level-v1";
    };

export function resolveWater(
  value: WaterRequirement,
  context: CatalogContext,
): WaterResolution {
  const water = parseWaterRequirement(value);
  const ground = context.entries.find((a) => a.id === "riverside-ground-v1");
  const known = BUILTIN_CONTEXT.entries.find(
    (a) => a.id === "riverside-ground-v1",
  )!;
  if (
    context.prepared ||
    !ground ||
    ground.contentVersion !== known.contentVersion
  )
    return {
      status: "blocked",
      message:
        "当前地表还没有可验证的河道与水面位置，暂不能预览；不会替换地表或省略河流。",
    };
  if (water.mode === "unspecified")
    return {
      status: "pending",
      message: "原描述未指定水体，请在水体选项中明确有水或无水。",
    };
  if (water.mode !== "none" && water.explicitLevel === null)
    return {
      status: "pending",
      message: `已识别需要${water.mode === "river" ? "河流" : "水面"}，当前地表还没有验证过合适的水面位置，暂不能生成预览；需要后续匹配地表与河道。`,
    };
  return freeze({
    status: "ready",
    waterLevel: water.explicitLevel,
    source: water.mode === "none" ? "absence" : "explicit",
    terrain: { id: ground.id, contentVersion: ground.contentVersion },
    policyVersion: "water-v2-no-auto-level-v1",
  });
}
