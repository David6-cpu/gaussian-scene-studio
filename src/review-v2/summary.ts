import type { BuildResult } from "../gaussian/types";
import {
  BUILTIN_CONTEXT,
  type CatalogContext,
} from "../assets/catalog/context";
import { resolveMaterialEdits } from "../review/draft";
import { quantitySummary } from "../review/summary";
import {
  effectiveWater,
  draftWaterResolution,
  type ReviewDraftV2,
} from "./draft";
export function reviewSummaryV2(
  draft: ReviewDraftV2,
  result?: BuildResult,
  context: CatalogContext = BUILTIN_CONTEXT,
) {
  const water = effectiveWater(draft),
    resolution = draftWaterResolution(draft, context);
  const lines = [
    water.mode === "river"
      ? "水体：描述需要河流。"
      : water.mode === "surface"
        ? "水体：需要水面。"
        : water.mode === "none"
          ? "水体：本次无水。"
          : "水体：原描述未指定。",
  ];
  const blockers: string[] = [],
    warnings: string[] = [];
  if (resolution.status !== "ready") blockers.push(resolution.message);
  if (draft.edits.water !== "keep")
    warnings.push("水体已按你的选择调整，原描述中的要求仍保留在记录中。");
  if (draft.edits.rock === "unresolved")
    blockers.push(
      "当前缺少可单独添加的真实石头，请选择简化占位或本次暂不添加。",
    );
  try {
    const effective = resolveMaterialEdits(
      draft.originalRequest,
      draft.edits.rock === "unresolved"
        ? { ...draft.edits, rock: "omit" }
        : draft.edits,
    );
    lines.push(...quantitySummary(draft, effective));
    if (effective.plantCount)
      warnings.push(
        "当前草丛和芦苇为示意素材，非实拍；需要你明确允许后才预览。",
      );
    if (draft.originalRequest.rockCount)
      warnings.push("地表原有碎石属于背景，不能当作新添加的独立石头。");
    if (effective.clarification)
      blockers.push(`需要澄清：${effective.clarification}`);
    if (effective.biome !== "wetland")
      blockers.push("当前环境缺少可用素材，不能自动换成湿地。");
  } catch (e) {
    blockers.push(e instanceof Error ? e.message : String(e));
  }
  if (result) {
    lines[0] = result.scene.water
      ? "水体：预览包含水面，连续性与观感仍需检查。"
      : "水体：本次无水。";
    const { accepted, requested, shortfall } = result.report;
    if (shortfall.rock || shortfall.reed)
      warnings.push(
        `实际摆放${accepted.rock}/${requested.rock}组石头、${accepted.reed}/${requested.reed}丛植物；没有放宽摆放规则。`,
      );
  }
  return { lines, blockers, warnings };
}
