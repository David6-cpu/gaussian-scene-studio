import { expect, test } from "vitest";
import { createReviewDraft, editReviewDraft, compileReview } from "./draft";
import { reviewSummary } from "./summary";
import { defaultAssetRequest } from "../selection/contract";
import { reviewFixture } from "./fixtures.test-support";
import { buildScene } from "../build";
import { BUILTIN_CONTEXT } from "../assets/catalog/context";
import { LLAMA_SMALL_MODEL } from "../planner/service";
import type { RequirementEvidence } from "../selection/service";
test("unavailable rocks stay visible in plain summary even when omitted", () => {
  const initial = createReviewDraft(
    "河岸上放一些低矮草丛和石头",
    defaultAssetRequest,
    null,
  );
  expect(reviewSummary(initial).blockers.join(" ")).toMatch(/石头/);
  const summary = reviewSummary(editReviewDraft(initial, { rock: "omit" }));
  expect(summary.lines.join(" ")).toContain("起始建议2组；本次暂不添加");
  expect(summary.lines.join(" ")).toContain("低矮草丛；起始建议4丛");
  expect(summary.lines.join(" ")).not.toContain("你要求");
  expect(summary.warnings.join(" ")).toContain("非实拍");
  expect(JSON.stringify(summary)).not.toMatch(
    /waterLevel|algorithmVersion|f0-|requested|Gaussian/,
  );
});
test.each(["河岸上放一些低矮草丛和石头", "河岸，2组石头、4丛低草"])(
  "model counts remain a proposal to check against the unmodified input: %s",
  (prompt) => {
    const request = { ...defaultAssetRequest };
    const evidence: RequirementEvidence = {
      prompt,
      request,
      raw: JSON.stringify(request),
      model: LLAMA_SMALL_MODEL,
      elapsedMs: 1,
    };
    const draft = createReviewDraft(prompt, request, evidence);
    const before = JSON.stringify(draft);
    const summary = reviewSummary(draft).lines.join(" ");
    expect(summary).toContain("模型建议2组；处理方式待选择");
    expect(summary).toContain("低矮草丛；模型建议4丛");
    expect(summary).not.toContain("你要求");
    expect(JSON.stringify(draft)).toBe(before);
  },
);
test("only an explicit density edit is attributed to the user", () => {
  const draft = editReviewDraft(
    createReviewDraft("河岸，2组石头、4丛低草", defaultAssetRequest, null),
    { density: "medium" },
  );
  const summary = reviewSummary(draft).lines.join(" ");
  expect(summary).toContain("低矮草丛；你选择6丛");
  expect(summary).toContain("起始建议2组");
  expect(draft.originalRequest.plantCount).toBe(4);
});
test("adding plants to a model request with none uses a fresh starting count", () => {
  const prompt = "河岸，无植被";
  const request = {
    ...defaultAssetRequest,
    plantKind: "none" as const,
    plantCount: 0,
  };
  const draft = editReviewDraft(
    createReviewDraft(prompt, request, {
      prompt,
      request,
      raw: JSON.stringify(request),
      model: LLAMA_SMALL_MODEL,
      elapsedMs: 1,
    }),
    { plantKind: "reed" },
  );
  expect(reviewSummary(draft).lines.join(" ")).toContain("芦苇；起始建议4丛");
  expect(draft.originalRequest.plantCount).toBe(0);
});
test("actual placement shortfall is visible without claiming generated counts", () => {
  const draft = reviewFixture({ rockCount: 10, plantCount: 10 });
  const result = buildScene(compileReview(draft, BUILTIN_CONTEXT).recipe);
  expect(result.scene.instances.length).toBeLessThan(20);
  const summary = reviewSummary(draft, result);
  expect(summary.warnings.join(" ")).toMatch(/实际|未能/);
  expect(summary.lines.join(" ")).toContain("简化占位");
});
