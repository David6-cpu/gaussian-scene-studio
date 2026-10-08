import { riversideData } from "../../terrain/riverside-data.ts";
import { parseCatalog, type AssetMetadata, type Category } from "./metadata.ts";

export const ASSET_CATALOG_VERSION = "asset-catalog-v1";
function procedural(
  id: AssetMetadata["loader"],
  title: string,
  category: Category,
  radius: number,
  legacy = false,
): AssetMetadata {
  const source = id.startsWith("legacy-")
    ? "src/assets/synthetic.ts"
    : "src/assets/river-props.ts";
  return {
    schemaVersion: 1,
    id,
    title,
    contentVersion: id,
    category,
    biomes: ["wetland"],
    tags: [category, "procedural"],
    origin: "procedural",
    spatial: {
      unit: "display-unit",
      metricScale: false,
      scaleEvidence: null,
      upAxis: "+Y",
      forwardAxis: null,
      handedness: "right",
      dimensions: [radius * 2, null, radius * 2],
      dimensionBasis: "placement-footprint",
      anchor: [0, 0, 0],
      radius,
    },
    gaussian: {
      full: 4096,
      coarse: 1024,
      shBands: 0,
      sourceBytes: (4096 + 1024) * 14 * 4,
    },
    quality: {
      status: legacy ? "legacy" : "trial",
      report: id.startsWith("legacy-")
        ? "docs/validation/f0-quality-diagnosis.md"
        : id === "river-low-grass-v2"
          ? "docs/validation/grass-height-refinement.md"
          : "docs/validation/river-props-pcg-trial.md",
      limitations: [
        "程序高斯，非实拍、非物种鉴定；biome为本项目展示适用标签。",
        "宽深记录摆放占地，高度随生成器/种子变化，不是实测尺寸。",
        legacy
          ? "保留旧版本回退，不进入新选材候选。"
          : "有限试用候选，尚非最终质量验收。",
      ],
    },
    provenance: {
      author: "本项目程序生成",
      source,
      license: "project-internal",
      licenseUrl: null,
      licenseFile: null,
      changes: "保持原算法/seed与高斯数据；未另授对外许可。",
      files: [],
    },
    loader: id,
  };
}
export const assetCatalog = parseCatalog([
  {
    schemaVersion: 1,
    id: "riverside-ground-v1",
    title: "Riverside · 河岸扫描地表",
    contentVersion: "riverside-ground-v1",
    category: "ground",
    biomes: ["wetland"],
    tags: ["riverside", "gravel", "ground"],
    origin: "captured",
    spatial: {
      unit: "display-unit",
      metricScale: false,
      scaleEvidence: null,
      upAxis: "+Y",
      forwardAxis: null,
      handedness: "right",
      dimensions: [4, null, 4],
      dimensionBasis: "usable-ground-area",
      anchor: [0, 0, 0],
      radius: null,
    },
    gaussian: {
      full: riversideData.count,
      coarse: null,
      shBands: 3,
      sourceBytes: riversideData.outputs.reduce((n, f) => n + f.bytes, 0),
    },
    quality: {
      status: "trial",
      report: "docs/validation/riverside-integration.md",
      limitations: [
        "用户已接受试用；近景模糊和边缘拖尾仍在，不是最终画质验收。",
        "4×4是可布局展示范围，非完整边界或实测米制；biome是展示适用标签。",
        "派生高度只用于布局代理，不自带物理碰撞或生态语义；没有粗LOD。",
      ],
    },
    provenance: {
      author: riversideData.author,
      source: riversideData.source,
      license: "CC-BY-4.0",
      licenseUrl: riversideData.licenseUrl,
      licenseFile: "public/assets/riverside-ground-v1/LICENSE.txt",
      changes: riversideData.changes,
      files: riversideData.outputs.map((f) => ({
        path: `public/assets/riverside-ground-v1/${f.filename}`,
        bytes: f.bytes,
        sha256: f.sha256,
      })),
    },
    loader: "riverside-ground-v1",
  },
  procedural("river-rock-v1", "河岸程序碎石组", "rock", 0.32),
  procedural("river-low-grass-v2", "河岸程序低矮细叶草丛", "grass", 0.34),
  procedural("river-reed-v1", "河岸程序芦苇候选", "reed", 0.34),
  procedural("river-grass-v1", "旧版河岸程序草丛", "grass", 0.34, true),
  procedural("legacy-rock-v1", "原始合成石头代理", "rock", 0.3, true),
  procedural("legacy-plant-v1", "原始合成植株代理", "plant-proxy", 0.2, true),
]);
