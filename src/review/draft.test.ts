import { expect, test } from "vitest";
import { BUILTIN_CONTEXT, makeCatalogContext } from "../assets/catalog/context";
import { defaultAssetRequest, candidateSnapshot } from "../selection/contract";
import { LLAMA_SMALL_MODEL } from "../planner/service";
import type { RequirementEvidence } from "../selection/service";
import { preparedFixture } from "../../tests/support/prepared-fixture";
import {
  createReviewDraft,
  editReviewDraft,
  resolveReviewRequest,
  compileReview,
  confirmReviewProcedural,
  parseReviewDraft,
  setReviewSelection,
} from "./draft";
import { reviewFixture } from "./fixtures.test-support";
const ctx = BUILTIN_CONTEXT;

test("requested rocks remain unresolved until a deliberate placeholder or omit choice", () => {
  const d = createReviewDraft(
    "河岸上放一些低矮草丛和石头",
    defaultAssetRequest,
    null,
  );
  expect(d.edits.rock).toBe("unresolved");
  expect(() => resolveReviewRequest(d)).toThrow(/石头/);
  expect(() => compileReview(d, ctx)).toThrow();
  const omitted = editReviewDraft(d, { rock: "omit" });
  expect(resolveReviewRequest(omitted).rockCount).toBe(0);
  expect(omitted.originalRequest.rockCount).toBe(2);
  expect(d.edits.rock).toBe("unresolved");
});
test("placeholder is an explicit origin change and still needs procedural confirmation", () => {
  const original = { ...defaultAssetRequest, rockOrigin: "captured" as const };
  const d = editReviewDraft(createReviewDraft("河岸实拍石头", original, null), {
    rock: "placeholder",
  });
  expect(d.originalRequest.rockOrigin).toBe("captured");
  const effective = resolveReviewRequest(d);
  expect(effective.rockOrigin).toBe("procedural");
  const selected = setReviewSelection(
    d,
    {
      kind: "manual",
      request: effective,
      catalogVersion: ctx.catalogVersion,
      choices: candidateSnapshot(effective).map((s) => ({
        key: s.key,
        assetId: s.assetIds[0],
      })),
    },
    ctx,
  );
  expect(() => compileReview(selected, ctx)).toThrow(/确认/);
  expect(
    compileReview(reviewFixture({ rockOrigin: "captured" }), ctx).recipe
      .requested.rock,
  ).toBe(2);
});
test("explicit counts persist until edited and edits invalidate every previous choice and confirmation", () => {
  const d = reviewFixture({ plantCount: 7 });
  expect(resolveReviewRequest(d).plantCount).toBe(7);
  const sparse = editReviewDraft(d, { density: "sparse" });
  expect(resolveReviewRequest(sparse).plantCount).toBe(4);
  expect(sparse.selection).toBeNull();
  expect(sparse.confirmedProceduralIds).toEqual([]);
  expect(confirmReviewProcedural(d, []).selection).toBeNull();
  expect(d.selection!.kind).toBe("manual");
  expect(d.selection).not.toHaveProperty("raw");
  expect(() =>
    parseReviewDraft(
      {
        ...d,
        selection: {
          ...d.selection,
          request: { ...defaultAssetRequest, seed: 99 },
        },
      },
      ctx,
    ),
  ).toThrow();
});
test("no plant or rock demand needs no artificial procedural approval", () => {
  const d = reviewFixture({ rockCount: 0, plantCount: 0, plantKind: "none" });
  expect(d.edits.rock).toBe("none");
  expect(d.confirmedProceduralIds).toEqual([]);
  expect(compileReview(d, ctx).recipe.requested).toEqual({ rock: 0, reed: 0 });
});
test("manual water change preserves raw model request and archived parser does not reclassify it", () => {
  const request = { ...defaultAssetRequest, rockCount: 0, waterLevel: null };
  const evidence: RequirementEvidence = {
    prompt: "不放水",
    request,
    raw: JSON.stringify(request),
    model: LLAMA_SMALL_MODEL,
    elapsedMs: 1,
  };
  const d = createReviewDraft(evidence.prompt, request, evidence);
  const on = editReviewDraft(d, { water: "on" });
  expect(resolveReviewRequest(on).waterLevel).toBe(0);
  expect(on.requirements?.raw).toBe(evidence.raw);
  const archived = {
    ...d,
    prompt: "河岸上放一些低矮草丛和石头",
    requirements: null,
  };
  expect(parseReviewDraft(archived, ctx).originalRequest.waterLevel).toBeNull();
  expect(() => createReviewDraft(archived.prompt, request, null)).toThrow(/水/);
  expect(() =>
    parseReviewDraft(
      { ...d, originalRequest: { ...request, plantCount: 9 } },
      ctx,
    ),
  ).toThrow(/原始|证据/);
});
test("prepared catalog cannot silently be compiled as the builtin riverbank", async () => {
  const { asset } = await preparedFixture();
  const prepared = await makeCatalogContext(asset, {
    contentVersion: asset.definition.metadata.contentVersion,
    licenseChecked: true,
    decision: "trial",
    limitations: ["test"],
    recordReference: "docs/validation/riverside-integration.md",
  });
  expect(() => compileReview(reviewFixture(), prepared)).toThrow(/高级/);
});
test("density cannot silently exceed total budget or resurrect removed vegetation with zero plants", () => {
  expect(() =>
    editReviewDraft(reviewFixture({ rockCount: 15, plantCount: 4 }), {
      density: "dense",
    }),
  ).toThrow(/20/);
  const none = editReviewDraft(reviewFixture(), { plantKind: "none" });
  expect(resolveReviewRequest(none).plantCount).toBe(0);
  expect(
    resolveReviewRequest(editReviewDraft(none, { plantKind: "reed" }))
      .plantCount,
  ).toBe(4);
});
