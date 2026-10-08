import { expect, test } from "vitest";
import { BUILTIN_CONTEXT as context } from "../assets/catalog/context";
import { candidateSnapshot, proceduralIds } from "../selection/contract";
import { defaultReviewRequestV2 } from "./requirements";
import {
  createReviewDraftV2,
  editReviewDraftV2,
  resolveReviewRequestV2,
  effectiveWater,
  confirmReviewProceduralV2,
  setReviewSelectionV2,
  compileReviewV2,
  parseReviewDraftV2,
} from "./draft";
import { reviewSummaryV2 } from "./summary";
const initial = () =>
  createReviewDraftV2(
    "河岸上放一些低矮草丛和石头",
    {
      ...defaultReviewRequestV2,
      water: { mode: "river", explicitLevel: null },
    },
    null,
  );
test("river remains in draft and summary while geometry is pending", () => {
  const draft = editReviewDraftV2(initial(), { rock: "omit" });
  expect(draft.originalRequest.water).toEqual({
    mode: "river",
    explicitLevel: null,
  });
  expect(reviewSummaryV2(draft).lines.join(" ")).toMatch(/需要河流/);
  expect(reviewSummaryV2(draft).blockers.join(" ")).toMatch(/水面位置/);
  expect(() => resolveReviewRequestV2(draft)).toThrow(/水面位置/);
  expect(() => compileReviewV2(draft, context)).toThrow();
});
test("manual off enables dry resolution without rewriting original; reverting has no ready cache", () => {
  const draft = editReviewDraftV2(initial(), { rock: "omit", water: "off" });
  expect(resolveReviewRequestV2(draft).waterLevel).toBeNull();
  expect(draft.originalRequest.water.mode).toBe("river");
  expect(draft.edits.water).toBe("off");
  expect(effectiveWater(draft).mode).toBe("none");
  expect(() =>
    resolveReviewRequestV2(editReviewDraftV2(draft, { water: "keep" })),
  ).toThrow(/水面位置/);
  expect(() =>
    resolveReviewRequestV2(editReviewDraftV2(draft, { water: "on" })),
  ).toThrow(/水面位置/);
});
test.each([
  ["河岸水位-0.025", { mode: "river", explicitLevel: -0.025 }, -0.025],
  ["水位-0.025", { mode: "surface", explicitLevel: -0.025 }, -0.025],
  ["干涸河床，不放水", { mode: "none", explicitLevel: null }, null],
] as const)("ready requests compile faithfully: %s", (prompt, water, level) => {
  let draft = createReviewDraftV2(
    prompt,
    { ...defaultReviewRequestV2, water, rockCount: 0 },
    null,
  );
  const request = resolveReviewRequestV2(draft);
  const choices = candidateSnapshot(request).map((s) => ({
    key: s.key,
    assetId: s.assetIds[0],
  }));
  draft = confirmReviewProceduralV2(draft, proceduralIds(choices));
  draft = setReviewSelectionV2(
    draft,
    {
      kind: "manual",
      request,
      choices,
      catalogVersion: context.catalogVersion,
    },
    context,
  );
  const result = compileReviewV2(draft, context);
  expect(result.recipe.waterLevel).toBe(level);
  expect(result.waterResolution).toMatchObject({
    status: "ready",
    waterLevel: level,
  });
  expect(() => compileReviewV2(draft, { ...context, entries: [] })).toThrow(
    /地表/,
  );
  expect(parseReviewDraftV2(draft, context)).toEqual(draft);
});
test("new water fields cannot enter old drafts or bypass the live check", () => {
  expect(() =>
    createReviewDraftV2("河岸", defaultReviewRequestV2, null),
  ).toThrow(/水体/);
  expect(() =>
    parseReviewDraftV2({ ...initial(), waterLevel: 0 }, context),
  ).toThrow();
});
