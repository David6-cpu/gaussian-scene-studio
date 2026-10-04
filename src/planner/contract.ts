import type { F0Recipe } from "../gaussian/types";
import {
  defaultRecipe,
  parseRecipe,
  isRiverside,
  isRiverProps,
} from "../recipe";
import { record } from "../data-validation";
import { buildScene } from "../build";

export const proposalKeys = [
  "seed",
  "width",
  "depth",
  "spacing",
  "amplitude",
  "octaves",
  "waterLevel",
  "requested",
] as const;
export type Proposal = Pick<F0Recipe, (typeof proposalKeys)[number]>;
export function proposalFromRecipe(r: F0Recipe): Proposal {
  return {
    seed: r.seed,
    width: r.width,
    depth: r.depth,
    spacing: r.spacing,
    amplitude: r.amplitude,
    octaves: r.octaves,
    waterLevel: r.waterLevel,
    requested: { ...r.requested },
  };
}
export function parseProposal(value: unknown): Proposal {
  const p = record(value, proposalKeys);
  return proposalFromRecipe(parseRecipe({ ...defaultRecipe, ...p }));
}
export function toRecipe(p: Proposal): F0Recipe {
  return parseRecipe({ ...defaultRecipe, ...parseProposal(p) });
}
export function preflight(p: Proposal) {
  return preflightRecipe(toRecipe(p));
}
export function preflightRecipe(input: F0Recipe) {
  const recipe = parseRecipe(input),
    { report } = buildScene(recipe);
  const summary = {
    ruleVersion: "engineering-placement-v1" as const,
    requested: report.requested,
    accepted: report.accepted,
    shortfall: report.shortfall,
    rejections: report.rejections,
    activeSplats: report.activeSplats,
  };
  const missing = report.shortfall.rock + report.shortfall.reed;
  const warnings = [
    "仅执行边界、水下、坡度、间距和贴地工程规则；不代表真实物种生态验证。",
  ];
  if (missing)
    warnings.push(`当前条件无法放置 ${missing} 个实例；不会放宽规则凑数。`);
  if (recipe.waterLevel === null)
    warnings.push("当前配方没有可见水面。湿地水体效果需另行检查。");
  if (isRiverside(recipe.algorithmVersion))
    warnings.push(
      "Riverside试用：一块连续SH3地表，固定4×4展示范围；水面与摆放采用派生高度近似，不是素材自带碰撞或生态语义。尺寸不是实测米制；模糊与边缘拖尾仍在。",
    );
  if (isRiverProps(recipe.algorithmVersion))
    warnings.push(
      "草丛/芦苇和碎石为程序高斯候选，非实拍或物种鉴定；石头数量按组、植物按丛计。芦苇距可见水面最多0.9展示单位，关闭水面开关时不限制该距离。原合成资产可从场景版本回退。",
    );
  return { recipe, summary, warnings };
}

// The schema aids constrained decoding; parseProposal remains the authority.
export const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: [...proposalKeys],
  properties: {
    seed: { type: "integer", minimum: 0, maximum: 4294967295 },
    width: { type: "number", enum: [2, 4, 6, 8, 10] },
    depth: { type: "number", enum: [2, 4, 6, 8, 10] },
    spacing: { type: "number", enum: [0.1, 0.2, 0.4] },
    amplitude: { type: "number", minimum: 0, maximum: 1, description: "地形起伏幅度；平地、平坦地形、没有起伏对应0；明确给定的幅度优先于默认。" },
    octaves: { type: "integer", minimum: 1, maximum: 5, description: "地形/噪声层数。一层或层数1对应1；二或两对应2；即使平地也保留用户明确指定的层数。" },
    waterLevel: { type: ["number", "null"], minimum: -0.5, maximum: 0.5 },
    requested: {
      type: "object",
      additionalProperties: false,
      required: ["rock", "reed"],
      properties: {
        rock: { type: "integer", minimum: 0, maximum: 20 },
        reed: { type: "integer", minimum: 0, maximum: 20 },
      },
    },
  },
} as const;
