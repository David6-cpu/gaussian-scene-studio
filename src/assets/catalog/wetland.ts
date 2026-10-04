import type {
  F0Recipe,
  AssetPrototype,
  RiversideGround,
} from "../../gaussian/types";
import { parseRecipe } from "../../recipe";
import { makeSyntheticAssets } from "../synthetic";
import { makeRiverProps } from "../river-props";
import { riversideGround, RIVERSIDE_BYTES } from "../../terrain/riverside";
import { assetCatalog } from "./entries";
import { freeze, parseCatalog, type AssetMetadata } from "./metadata";

interface Binding {
  readonly ground: string | null;
  readonly rock: string;
  readonly reed: string;
}
const legacy = {
  ground: null,
  rock: "legacy-rock-v1",
  reed: "legacy-plant-v1",
};
const bindings: Readonly<Record<F0Recipe["algorithmVersion"], Binding>> =
  freeze({
    "f0-v1": { ...legacy },
    "f0-shore-v2": { ...legacy },
    "f0-riverside-v1": { ...legacy, ground: "riverside-ground-v1" },
    "f0-riverside-grass-v1": {
      ground: "riverside-ground-v1",
      rock: "river-rock-v1",
      reed: "river-grass-v1",
    },
    "f0-riverside-grass-v2": {
      ground: "riverside-ground-v1",
      rock: "river-rock-v1",
      reed: "river-low-grass-v2",
    },
    "f0-riverside-reed-v1": {
      ground: "riverside-ground-v1",
      rock: "river-rock-v1",
      reed: "river-reed-v1",
    },
  });
export function wetlandBinding(version: F0Recipe["algorithmVersion"]): Binding {
  if (!Object.hasOwn(bindings, version))
    throw Error("未知旧场景版本，不能猜测资产绑定");
  return bindings[version];
}
function resolve(id: string, entries: readonly AssetMetadata[]): AssetMetadata {
  const asset = entries.find((a) => a.id === id);
  if (!asset) throw Error(`场景固定资源缺失：${id}`);
  if (asset.loader !== id || asset.contentVersion !== id)
    throw Error(`旧版本资源加载器/内容版本不匹配：${id}`);
  return asset;
}
export function makeCatalogGround(
  input: F0Recipe,
  catalog: readonly AssetMetadata[] = assetCatalog,
): RiversideGround | undefined {
  const recipe = parseRecipe(input),
    binding = wetlandBinding(recipe.algorithmVersion);
  if (!binding.ground) return undefined;
  const entries =
      catalog === assetCatalog ? assetCatalog : parseCatalog(catalog),
    metadata = resolve(binding.ground, entries),
    ground = riversideGround();
  if (
    metadata.gaussian.full !== ground.count ||
    metadata.gaussian.coarse !== null ||
    metadata.gaussian.shBands !== 3 ||
    metadata.gaussian.sourceBytes !== RIVERSIDE_BYTES ||
    metadata.spatial.unit !== "display-unit" ||
    metadata.spatial.dimensions[0] !== 4 ||
    metadata.spatial.dimensions[2] !== 4
  )
    throw Error("Riverside固定地表点数/尺寸metadata不匹配");
  return ground;
}
export function makeCatalogAssets(
  input: F0Recipe,
  catalog: readonly AssetMetadata[] = assetCatalog,
): AssetPrototype[] {
  const recipe = parseRecipe(input),
    binding = wetlandBinding(recipe.algorithmVersion),
    entries = catalog === assetCatalog ? assetCatalog : parseCatalog(catalog);
  if (binding.ground) makeCatalogGround(recipe, entries);
  const rock = resolve(binding.rock, entries),
    plant = resolve(binding.reed, entries);
  // Stable old-version bindings are already explicit presets, not new AI choices.
  let assets: AssetPrototype[];
  if (rock.loader === "legacy-rock-v1" && plant.loader === "legacy-plant-v1")
    assets = makeSyntheticAssets();
  else if (rock.loader === "river-rock-v1") {
    const kind =
      plant.loader === "river-low-grass-v2"
        ? "low-grass"
        : plant.loader === "river-grass-v1"
          ? "grass"
          : plant.loader === "river-reed-v1"
            ? "reed"
            : null;
    if (!kind) throw Error("目录中的植株加载器与旧版本绑定不一致");
    assets = makeRiverProps(recipe.seed, kind);
  } else throw Error("目录中的碎石加载器与旧版本绑定不一致");
  for (const [index, metadata] of [rock, plant].entries()) {
    const a = assets[index];
    if (
      a.lods.full.count !== metadata.gaussian.full ||
      a.lods.coarse.count !== metadata.gaussian.coarse ||
      a.lods.full.data.byteLength + a.lods.coarse.data.byteLength !==
        metadata.gaussian.sourceBytes
    )
      throw Error(`资源点数/源字节与目录不符：${metadata.id}`);
    if (
      a.radius !== metadata.spatial.radius ||
      JSON.stringify(a.anchor) !== JSON.stringify(metadata.spatial.anchor)
    )
      throw Error(`资源占地/锚点与目录不符：${metadata.id}`);
  }
  return assets;
}
