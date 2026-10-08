import { record, integer, finite, oneOf } from "../data-validation";
import type { F0Recipe, SceneRecipe } from "../gaussian/types";
import { parseRecipe, riversideRecipe } from "../recipe";
import { BUILTIN_CONTEXT, type CatalogContext } from "../assets/catalog/context";
import { parsePreparedRecipe, buildPreparedScene } from "../prepared-scene";
import {
  identifier,
  text,
  freeze,
  type Origin,
} from "../assets/catalog/metadata";
import {
  queryAssets,
  validateAssetSelection,
  type SceneRequirements,
} from "../assets/catalog/query";
import { assertWetlandScope } from "../planner/scope";
import { parsePrompt } from "../planner/service";
import { preflightRecipe } from "../planner/contract";

export interface AssetRequest {
  biome: "wetland" | "snow-mountain" | "unsupported";
  unit: "display-unit" | "metre";
  groundOrigin: Origin | "either";
  rockOrigin: Origin | "either";
  plantOrigin: Origin | "either";
  rockCount: number;
  plantKind: "grass" | "reed" | "none";
  plantCount: number;
  seed: number;
  waterLevel: number | null;
  clarification: string;
}
export interface Choice {
  key: string;
  assetId: string;
}
export interface CandidateSlot {
  key: string;
  count: number;
  assetIds: string[];
}
export const defaultAssetRequest: AssetRequest = freeze({
  biome: "wetland",
  unit: "display-unit",
  groundOrigin: "captured",
  rockOrigin: "either",
  plantOrigin: "either",
  rockCount: 2,
  plantKind: "grass",
  plantCount: 4,
  seed: 42,
  waterLevel: 0,
  clarification: "",
});
const keys = Object.keys(defaultAssetRequest);
export type AssetMaterials = Omit<AssetRequest, "waterLevel">;
export const materialKeys = keys.filter((key) => key !== "waterLevel");
export function parseAssetRequest(value: unknown): AssetRequest {
  const r = record(value, keys);
  const { clarification, ...materials } = parseAssetMaterials(
    Object.fromEntries(materialKeys.map((key) => [key, r[key]])),
  );
  return freeze({
    ...materials,
    waterLevel: r.waterLevel === null ? null : finite(r.waterLevel, -0.5, 0.5),
    clarification,
  });
}
export function parseAssetMaterials(value: unknown): AssetMaterials {
  const r = record(value, materialKeys);
  const rockCount = integer(r.rockCount, 0, 20),
    plantCount = integer(r.plantCount, 0, 20),
    plantKind = oneOf(r.plantKind, ["grass", "reed", "none"] as const);
  if (rockCount + plantCount > 20)
    throw Error("实例总数超过20，不能自动减少数量");
  if ((plantKind === "none") !== (plantCount === 0))
    throw Error("无植被须数量0，有植被须至少1丛");
  if (typeof r.clarification !== "string" || r.clarification.length > 240)
    throw Error("澄清说明无效");
  const origin = (v: unknown) =>
    oneOf(v, ["captured", "procedural", "either"] as const);
  return freeze({
    biome: oneOf(r.biome, ["wetland", "snow-mountain", "unsupported"] as const),
    unit: oneOf(r.unit, ["display-unit", "metre"] as const),
    groundOrigin: origin(r.groundOrigin),
    rockOrigin: origin(r.rockOrigin),
    plantOrigin: origin(r.plantOrigin),
    rockCount,
    plantKind,
    plantCount,
    seed: integer(r.seed, 0, 4294967295),
    clarification: r.clarification.trim(),
  });
}
export function assertAssetPrompt(value: string): void {
  const prompt = parsePrompt(value);
  assertWetlandScope(prompt);
  if (
    /沙漠|森林|雨林|海底|海洋|城市|室内|树木|乔木|松树|小鹿|动物|鱼群|鸟群|房屋|建筑|荷花|左侧|右侧|左边|右边|中央|正中|排列|围成|多种植被|两种植被|\b(?:desert|forest|ocean|underwater|city|indoor|trees?|deer|fish|birds?)\b/i.test(
      prompt,
    )
  )
    throw Error(
      "需要澄清：本轮仅支持湿地地表、碎石和一种低草或芦苇，不支持该环境、素材或指定空间关系。",
    );
  if (
    /(?:\d+(?:\.\d+)?|[一二三四五六七八九十两]+)\s*(?:米|平方米)|\bmet(?:er|re)s?\b|\d\s*m\b/i.test(
      prompt,
    )
  )
    throw Error(
      "需要澄清：素材没有实测米制，只能使用固定4×4展示范围；不会把米换成展示单位。",
    );
}
export function requirementsFor(input: AssetRequest): SceneRequirements {
  const r = parseAssetRequest(input);
  if (r.clarification) throw Error(`需要澄清：${r.clarification}`);
  if (r.biome !== "wetland")
    throw Error("环境资源缺失：本轮只支持湿地，其他环境不支持且不会换成湿地。");
  return {
    biome: "wetland",
    unit: r.unit,
    elements: [
      { key: "ground", category: "ground", count: 1, origin: r.groundOrigin },
      ...(r.rockCount
        ? [
            {
              key: "rocks",
              category: "rock" as const,
              count: r.rockCount,
              origin: r.rockOrigin,
            },
          ]
        : []),
      ...(r.plantCount
        ? [
            {
              key: "plants",
              category: r.plantKind as "grass" | "reed",
              count: r.plantCount,
              origin: r.plantOrigin,
            },
          ]
        : []),
    ],
  };
}
export function candidateSnapshot(input: AssetRequest, context: CatalogContext = BUILTIN_CONTEXT): CandidateSlot[] {
  const q = queryAssets(requirementsFor(input), context.entries);
  if (q.missing.length)
    throw Error(`必要资源缺失：${q.missing.map((m) => m.message).join(" ")}`);
  return q.candidates.map((c) => ({
    key: c.key,
    count: c.count,
    assetIds: c.assets.map((a) => a.id),
  }));
}
export function proceduralIds(choices: readonly Choice[], context: CatalogContext = BUILTIN_CONTEXT): string[] {
  return [
    ...new Set(
      choices
        .filter(
          (c) =>
            context.entries.find((a) => a.id === c.assetId)?.origin ===
            "procedural",
        )
        .map((c) => c.assetId),
    ),
  ].sort();
}
export function checkChoices(input: AssetRequest, value: unknown, context: CatalogContext = BUILTIN_CONTEXT): Choice[] {
  const r = record(value, ["choices"]);
  if (!Array.isArray(r.choices) || r.choices.length < 1 || r.choices.length > 3)
    throw Error("选材须覆盖1–3个实际角色");
  const choices = r.choices.map((v) => {
    const c = record(v, ["key", "assetId"]);
    return { key: identifier(c.key), assetId: identifier(c.assetId) };
  });
  candidateSnapshot(input, context);
  // Read-only inspection of the candidate contract. This does not authorize application.
  const inspected = validateAssetSelection(
    requirementsFor(input),
    choices,
    context.entries,
    { confirmedProceduralIds: proceduralIds(choices, context) },
  );
  return inspected.selected.map((s) => ({ key: s.key, assetId: s.asset.id }));
}
export function compileSelection(input:AssetRequest,value:unknown,confirmedProceduralIds:readonly string[]):F0Recipe;
export function compileSelection(input:AssetRequest,value:unknown,confirmedProceduralIds:readonly string[],context:CatalogContext):SceneRecipe;
export function compileSelection(
  input: AssetRequest,
  value: unknown,
  confirmedProceduralIds: readonly string[],
  context: CatalogContext = BUILTIN_CONTEXT,
): SceneRecipe {
  const r = parseAssetRequest(input),
    choices = checkChoices(r, value, context);
  validateAssetSelection(requirementsFor(r), choices, context.entries, {
    confirmedProceduralIds,
  });
  const byKey = new Map(choices.map((c) => [c.key, c.assetId]));
  if (
    (byKey.get("ground") !== "riverside-ground-v1" && byKey.get("ground") !== context.prepared?.metadata.id) ||
    (r.rockCount > 0 && byKey.get("rocks") !== "river-rock-v1")
  )
    throw Error("角色资源尚无已验证的湿地编译绑定");
  const plant = byKey.get("plants");
  if (
    r.plantCount > 0 &&
    plant !== (r.plantKind === "reed" ? "river-reed-v1" : "river-low-grass-v2")
  )
    throw Error("植物ID与实际生成角色不符");
  if (context.prepared && byKey.get("ground") === context.prepared.metadata.id) {
    const d=context.prepared;
    const recipe=parsePreparedRecipe({...riversideRecipe,schemaVersion:2,algorithmVersion:"f0-prepared-ground-v1",ground:{id:d.metadata.id,contentVersion:d.metadata.contentVersion},plantKind:r.plantKind==="reed"?"reed":"low-grass",seed:r.seed,waterLevel:r.waterLevel,requested:{rock:r.rockCount,reed:r.plantCount}});
    buildPreparedScene(recipe,d);return recipe;
  }
  const recipe = parseRecipe({
    ...riversideRecipe,
    algorithmVersion:
      plant === "river-reed-v1"
        ? "f0-riverside-reed-v1"
        : "f0-riverside-grass-v2",
    seed: r.seed,
    waterLevel: r.waterLevel,
    requested: { rock: r.rockCount, reed: r.plantCount },
  });
  preflightRecipe(recipe); // Actual terrain/water/instances must also fit the independent build budget.
  return recipe;
}
const originSchema = {
  type: "string",
  enum: ["captured", "procedural", "either"],
};
export const assetRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: keys,
  properties: {
    biome: {
      type: "string",
      enum: ["wetland", "snow-mountain", "unsupported"],
    },
    unit: { type: "string", enum: ["display-unit", "metre"] },
    groundOrigin: originSchema,
    rockOrigin: originSchema,
    plantOrigin: originSchema,
    rockCount: { type: "integer", minimum: 0, maximum: 20 },
    plantKind: { type: "string", enum: ["grass", "reed", "none"] },
    plantCount: { type: "integer", minimum: 0, maximum: 20 },
    seed: { type: "integer", minimum: 0, maximum: 4294967295 },
    waterLevel: { type: ["number", "null"], minimum: -0.5, maximum: 0.5 },
    clarification: { type: "string", maxLength: 240 },
  },
};
