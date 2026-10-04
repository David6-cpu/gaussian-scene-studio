import { record, integer, oneOf } from "../../data-validation";
import { assetCatalog, ASSET_CATALOG_VERSION } from "./entries";
import {
  biomes,
  categories,
  identifier,
  parseCatalog,
  freeze,
  type AssetMetadata,
  type Biome,
  type Category,
  type Origin,
  type Unit,
} from "./metadata";

export interface SceneRequirements {
  readonly biome: Biome;
  readonly unit: Unit;
  readonly elements: readonly {
    readonly key: string;
    readonly category: Category;
    readonly count: number;
    readonly origin: Origin | "either";
  }[];
}
export interface CatalogQuery {
  readonly catalogVersion: string;
  readonly candidates: readonly {
    readonly key: string;
    readonly count: number;
    readonly assets: readonly AssetMetadata[];
  }[];
  readonly missing: readonly {
    readonly key: string;
    readonly reason: "unavailable" | "unit" | "budget";
    readonly message: string;
  }[];
}
export const biomeLabels: Record<Biome, string> = {
  wetland: "湿地",
  "snow-mountain": "雪山",
};
export const categoryLabels: Record<Category, string> = {
  ground: "地表",
  rock: "碎石",
  grass: "草丛",
  reed: "芦苇候选",
  "plant-proxy": "植株代理",
};

export function parseRequirements(value: unknown): SceneRequirements {
  const r = record(value, ["biome", "unit", "elements"]);
  if (
    !Array.isArray(r.elements) ||
    r.elements.length < 1 ||
    r.elements.length > 10
  )
    throw Error("需求必须含1–10个资源槽位");
  const keys = new Set<string>();
  let instanceCount = 0,
    groundCount = 0;
  const elements = r.elements.map((value) => {
    const e = record(value, ["key", "category", "count", "origin"]),
      key = identifier(e.key),
      category = oneOf(e.category, categories);
    if (keys.has(key)) throw Error("重复需求槽位");
    keys.add(key);
    const count = integer(e.count, 1, category === "ground" ? 1 : 20);
    if (category === "ground") groundCount += count;
    else instanceCount += count;
    return {
      key,
      category,
      count,
      origin: oneOf(e.origin, ["captured", "procedural", "either"] as const),
    };
  });
  if (instanceCount > 20 || groundCount > 1)
    throw Error("最多20个摆放实例和一块连续地表");
  return freeze({
    biome: oneOf(r.biome, biomes),
    unit: oneOf(r.unit, ["display-unit", "metre"] as const),
    elements,
  });
}
const worst = (a: AssetMetadata) =>
  Math.max(a.gaussian.full, a.gaussian.coarse ?? a.gaussian.full);
export function queryAssets(
  input: SceneRequirements,
  catalog: readonly AssetMetadata[] = assetCatalog,
  budget = 250000,
): CatalogQuery {
  const request = parseRequirements(input),
    entries = parseCatalog(catalog);
  budget = integer(budget, 1, 250000);
  const missing: CatalogQuery["missing"][number][] = [];
  const candidates = request.elements.map((e) => {
    const available = entries.filter(
      (a) =>
        a.quality.status === "trial" &&
        a.biomes.includes(request.biome) &&
        a.category === e.category &&
        (e.origin === "either" || e.origin === a.origin),
    );
    const scaled = available.filter(
      (a) =>
        a.spatial.unit === request.unit &&
        (request.unit !== "metre" || a.spatial.metricScale),
    );
    const assets = scaled.filter((a) => worst(a) * e.count <= budget);
    if (!assets.length) {
      const reason = !available.length
        ? "unavailable"
        : !scaled.length
          ? "unit"
          : "budget";
      const why = {
        unavailable: "库中没有符合环境、类别及来源要求的已接入候选",
        unit: "现有候选没有所需单位和定标依据",
        budget: "单项数量的最坏高斯数已超过预算",
      }[reason];
      missing.push({
        key: e.key,
        reason,
        message: `${biomeLabels[request.biome]} / ${categoryLabels[e.category]}：${why}。不会自动换素材或伪造资产。`,
      });
    }
    return { key: e.key, count: e.count, assets };
  });
  return freeze({ catalogVersion: ASSET_CATALOG_VERSION, candidates, missing });
}
export interface SelectionOptions {
  readonly budget?: number;
  readonly reservedSplats?: number;
  readonly confirmedProceduralIds?: readonly string[];
}
export interface SelectionResult {
  readonly selected: readonly {
    readonly key: string;
    readonly count: number;
    readonly asset: AssetMetadata;
  }[];
  readonly activeSplats: number;
  readonly warnings: readonly string[];
}
export function validateAssetSelection(
  input: SceneRequirements,
  choices: unknown,
  catalog: readonly AssetMetadata[] = assetCatalog,
  options: SelectionOptions = {},
): SelectionResult {
  const requirements = parseRequirements(input);
  const budget = integer(options.budget ?? 250000, 1, 250000),
    reserved = integer(options.reservedSplats ?? 0, 0, 250000);
  if (
    Object.keys(options).some(
      (k) =>
        !["budget", "reservedSplats", "confirmedProceduralIds"].includes(k),
    )
  )
    throw Error("未知选择选项");
  const confirmed = options.confirmedProceduralIds ?? [];
  if (
    !Array.isArray(confirmed) ||
    confirmed.length > 20 ||
    new Set(confirmed).size !== confirmed.length
  )
    throw Error("程序素材确认清单无效");
  confirmed.forEach(identifier);
  // Never trust a caller-supplied candidate list or a model's validity claim.
  const query = queryAssets(requirements, catalog, budget);
  if (query.missing.length)
    throw Error(
      `必要资源缺失：${query.missing.map((m) => m.message).join(" ")}`,
    );
  if (
    !Array.isArray(choices) ||
    choices.length !== requirements.elements.length
  )
    throw Error("选择必须逐项覆盖需求且不能增加槽位");
  const byKey = new Map<string, string>();
  for (const item of choices) {
    const c = record(item, ["key", "assetId"]),
      key = identifier(c.key),
      id = identifier(c.assetId);
    if (byKey.has(key)) throw Error("重复选择槽位");
    byKey.set(key, id);
  }
  const selected = query.candidates.map((c) => {
    const id = byKey.get(c.key),
      asset = c.assets.find((a) => a.id === id);
    if (!asset) throw Error(`槽位${c.key}的ID不在独立重算的候选中`);
    if (asset.origin === "procedural" && !confirmed.includes(asset.id))
      throw Error(`程序素材${asset.id}尚未获得明确确认`);
    return { key: c.key, count: c.count, asset };
  });
  if (
    confirmed.some(
      (id) =>
        !selected.some(
          (s) => s.asset.id === id && s.asset.origin === "procedural",
        ),
    )
  )
    throw Error("程序确认包含本次未选择的ID");
  const activeSplats =
    reserved + selected.reduce((sum, s) => sum + worst(s.asset) * s.count, 0);
  if (activeSplats > budget)
    throw Error(`资源与预留高斯合计${activeSplats}超过预算${budget}`);
  return freeze({
    selected,
    activeSplats,
    warnings: [
      "此为选中资源与显式预留量的最坏点数估算；地形/水面等构建后仍须独立检查总预算。",
      ...selected
        .filter((s) => s.asset.origin === "procedural")
        .map((s) => `${s.asset.title}为已确认程序素材，非实拍。`),
      ...selected.flatMap((s) => s.asset.quality.limitations),
    ],
  });
}
