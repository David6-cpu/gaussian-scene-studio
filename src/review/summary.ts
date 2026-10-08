import type { AssetMaterials } from "../selection/contract";
import type { ReviewEdits } from "./draft";
import type { BuildResult } from "../gaussian/types";
import { resolveReviewRequest, type ReviewDraft } from "./draft";

export function reviewSummary(
  draft: ReviewDraft,
  result?: BuildResult,
): { lines: string[]; blockers: string[]; warnings: string[] } {
  const blockers: string[] = [],
    warnings: string[] = [],
    lines: string[] = [];
  const unresolved = draft.edits.rock === "unresolved";
  if (unresolved)
    blockers.push(
      "当前缺少可单独添加的真实石头，请选择简化占位或本次暂不添加。",
    );
  let effective;
  try {
    effective = resolveReviewRequest(
      unresolved
        ? { ...draft, edits: { ...draft.edits, rock: "omit" } }
        : draft,
    );
  } catch (e) {
    return {
      lines,
      blockers: [...blockers, e instanceof Error ? e.message : String(e)],
      warnings,
    };
  }
  lines.push(
    effective.waterLevel === null
      ? "水体：本次无水。"
      : "水体：沿当前河岸的低洼区域形成水面，等待预览检查。",
  );
  lines.push(...quantitySummary(draft, effective));
  if (effective.plantCount)
    warnings.push("当前草丛和芦苇为示意素材，非实拍；需要你明确允许后才预览。");
  if (draft.originalRequest.rockCount)
    warnings.push("地表原有碎石属于背景，不能当作新添加的独立石头。");
  if (draft.edits.water === "on" && draft.originalRequest.waterLevel === null)
    warnings.push(
      "你已手动开启水面，采用建议水位；原始无水要求仍保留在记录中。",
    );
  if (result) {
    lines[0] = result.scene.water
      ? "水体：预览包含水面，请检查连续性及岸线。"
      : "水体：本次无水。";
    const { accepted, requested, shortfall } = result.report;
    if (shortfall.rock || shortfall.reed)
      warnings.push(
        `实际摆放${accepted.rock}/${requested.rock}组石头、${accepted.reed}/${requested.reed}丛植物；其余未能放在合适位置，没有放宽摆放规则。`,
      );
  }
  return { lines, blockers, warnings };
}

export function quantitySummary(
  draft: {
    originalRequest: AssetMaterials;
    requirements: unknown;
    edits: ReviewEdits;
  },
  effective: AssetMaterials,
): string[] {
  const lines: string[] = [];
  const unresolved = draft.edits.rock === "unresolved";
  // The archived request has no per-count provenance. Keep extraction/defaults
  // as proposals; only a recorded density edit is an explicit user choice.
  const quantitySource = draft.requirements ? "模型建议" : "起始建议";
  const plantQuantitySource =
    draft.edits.density !== "keep"
      ? "你选择"
      : effective.plantCount !== draft.originalRequest.plantCount
        ? "起始建议"
        : quantitySource;
  lines.push(
    effective.plantCount
      ? `植物：${effective.plantKind === "reed" ? "芦苇" : "低矮草丛"}；${plantQuantitySource}${effective.plantCount}丛。`
      : "植物：本次不添加。",
  );
  lines.push(
    draft.originalRequest.rockCount
      ? `石头：${quantitySource}${draft.originalRequest.rockCount}组；${unresolved ? "处理方式待选择" : draft.edits.rock === "omit" ? "本次暂不添加" : "使用简化占位（非实拍）"}。`
      : "石头：本次不额外添加。",
  );
  return lines;
}
