import type { F0Recipe, RiverbankVersion } from "./gaussian/types";
import { record, finite, integer, oneOf } from "./data-validation";
export const defaultRecipe: F0Recipe = {
  schemaVersion: 1,
  algorithmVersion: "f0-v1",
  recipeSource: "manual",
  seed: 20261002,
  width: 10,
  depth: 10,
  spacing: 0.2,
  amplitude: 0.6,
  octaves: 3,
  tangentFactor: 0.75,
  normalFactor: 0.1,
  opacity: 0.95,
  waterLevel: 0,
  requested: { rock: 10, reed: 10 },
  lodEnabled: true,
};
// Keep the legacy recipe immutable for old ZIPs and planning evidence.
export const riversideRecipe: F0Recipe = {
  ...defaultRecipe,
  algorithmVersion: "f0-riverside-v1",
  width: 4,
  depth: 4,
  spacing: 0.1,
  amplitude: 0,
  octaves: 1,
  waterLevel: -0.025,
  requested: { rock: 2, reed: 6 },
};
export function isRiverProps(version: unknown): boolean {
  return (
    isRiverbank(version) ||
    version === "f0-riverside-grass-v1" ||
    version === "f0-riverside-grass-v2" ||
    version === "f0-riverside-reed-v1"
  );
}
export function isRiverbank(version: unknown): version is RiverbankVersion {
  return version === "f0-riverbank-grass-v1" || version === "f0-riverbank-reed-v1";
}
export function riverPlantKind(version: unknown): "low-grass" | "grass" | "reed" | null {
  if (version === "f0-riverside-grass-v2" || version === "f0-riverbank-grass-v1") return "low-grass";
  if (version === "f0-riverside-grass-v1") return "grass";
  if (version === "f0-riverside-reed-v1" || version === "f0-riverbank-reed-v1") return "reed";
  return null;
}
export function isRiverside(version: unknown): boolean {
  return version === "f0-riverside-v1" || isRiverProps(version);
}
export function sceneAssetLabel(version: unknown): string {
  if (isRiverProps(version))
    return `Riverside 地表 · 程序${riverPlantKind(version) === "low-grass" ? "低矮细叶草丛" : riverPlantKind(version) === "grass" ? "草丛" : "芦苇"}与碎石候选（非实拍）`;
  return isRiverside(version)
    ? "Riverside 地表试用 · 原合成植株与石头"
    : "合成高斯测试资产";
}
export function parseRecipe(input: unknown): F0Recipe {
  try {
    const r = record(input, Object.keys(defaultRecipe)),
      wanted = record(r.requested, ["rock", "reed"]);
    const requested = {
      rock: integer(wanted.rock, 0, 20),
      reed: integer(wanted.reed, 0, 20),
    };
    if (requested.rock + requested.reed > 20) throw new Error("最多20个实例");
    if (
      isRiverside(r.algorithmVersion) &&
      (r.width !== 4 ||
        r.depth !== 4 ||
        r.spacing !== 0.1 ||
        r.amplitude !== 0 ||
        r.octaves !== 1)
    )
      throw new Error(
        "Riverside试用固定4×4展示范围、0.1间距、0起伏参数和1层；地势来自素材。扩大或改形请切回程序地表。",
      );
    return {
      schemaVersion: oneOf(r.schemaVersion, [1] as const),
      algorithmVersion: oneOf(r.algorithmVersion, [
        "f0-v1",
        "f0-shore-v2",
        "f0-riverside-v1",
        "f0-riverside-grass-v1",
        "f0-riverside-grass-v2",
        "f0-riverside-reed-v1",
        "f0-riverbank-grass-v1",
        "f0-riverbank-reed-v1",
      ] as const),
      recipeSource: oneOf(r.recipeSource, ["manual"] as const),
      seed: integer(r.seed, 0, 4294967295),
      width: oneOf(r.width, [2, 4, 6, 8, 10]),
      depth: oneOf(r.depth, [2, 4, 6, 8, 10]),
      spacing: oneOf(r.spacing, [0.1, 0.2, 0.4]),
      amplitude: finite(r.amplitude, 0, 1),
      octaves: integer(r.octaves, 1, 5),
      tangentFactor: oneOf(r.tangentFactor, [0.5, 0.75, 1]),
      normalFactor: oneOf(r.normalFactor, [0.05, 0.1]),
      opacity: oneOf(r.opacity, [0.8, 0.95]),
      waterLevel:
        r.waterLevel === null ? null : finite(r.waterLevel, -0.5, 0.5),
      requested,
      lodEnabled: oneOf(r.lodEnabled, [true, false]),
    };
  } catch (e) {
    throw new Error(`配方无效：${e instanceof Error ? e.message : String(e)}`);
  }
}
