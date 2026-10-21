import { expect, test } from "vitest";
import { buildFixture } from "../../tests/support/general-build-fixture";
import {
  makeManualDraft,
  proceduralChoices,
  confirmProceduralChoices,
} from "./manual-plan";
import { PLANNER_VERSION, RULES_VERSION } from "./planner";
import { documentDigest } from "./canonical";
import type { PlanningRequest } from "./planner";
const request: PlanningRequest = {
  operationId: "manual-panel-test",
  prompt: "用户原句需要澄清，不能把表单当作模型解析",
  baseRevisionId: null,
  manualOverrides: [],
};
const settings = {
  width: 4,
  depth: 4,
  seed: 42,
  terrain: {
    source: "procedural" as const,
    elevation: 0,
    slopeDegrees: 0,
    slopeAzimuthDegrees: 0,
    noiseAmplitude: 0,
    noiseScale: 2,
    noiseOctaves: 1,
    spacing: 0.2 as const,
  },
  water: { mode: "unspecified" as const },
  groups: [
    {
      category: "rock",
      count: 1,
      sourceRestriction: "procedural" as const,
      required: true,
    },
  ],
};
test("manual form preserves raw request, explicit manual provenance and unspecified water", async () => {
  const f = await buildFixture({ count: 1 });
  const out = await makeManualDraft(request, settings, f.library);
  expect(out.intent.raw).toBe(request.prompt);
  expect(
    out.intent.terrain.every((a) => a.source === "manual" && a.span === null),
  ).toBe(true);
  expect(out.intent.water.mode).toBe("unspecified");
  expect(out.draft.water.mode).toBe("unspecified");
  expect(out.draft.intentDigest).toBe(await documentDigest(out.intent));
  expect(out.draft.generatorVersion).toBe(PLANNER_VERSION);
  expect(out.draft.rulesVersion).toBe(RULES_VERSION);
  expect(out.draft.review.acceptedSubstitutions).toEqual([]);
});
test("each procedural role requires its own affirmative checkbox and immutable content binding", async () => {
  const f = await buildFixture({ count: 1 });
  const out = await makeManualDraft(request, settings, f.library);
  const choices = proceduralChoices(out.intent, out.draft, f.library);
  expect(choices.length).toBeGreaterThan(1);
  await expect(
    confirmProceduralChoices(
      request,
      out.intent,
      out.draft,
      f.library,
      new Set([choices[0].slotId]),
    ),
  ).rejects.toThrow("请明确确认");
  const accepted = await confirmProceduralChoices(
    request,
    out.intent,
    out.draft,
    f.library,
    new Set(choices.map((c) => c.slotId)),
  );
  expect(
    accepted.review.manualOverrides.filter((a) => a.key.startsWith("accept.")),
  ).toHaveLength(choices.length);
  expect(out.draft.review.manualOverrides).toEqual([]);
  expect(accepted.review.acceptedSubstitutions).toHaveLength(1);
  for (const c of choices) {
    const atom = accepted.review.manualOverrides.find((a) =>
      a.key.endsWith(c.slotId),
    )!;
    expect(atom.source).toBe("manual");
    expect(atom.value).toMatchObject({
      catalogDigest: f.library.digest,
      assetRef: c.assetRef,
      digest: c.digest,
    });
  }
});
test("missing trees remain missing and manual form never substitutes another category", async () => {
  const f = await buildFixture({ count: 1 });
  const out = await makeManualDraft(
    request,
    {
      ...settings,
      groups: [
        {
          category: "tree",
          count: 2,
          sourceRestriction: "either",
          required: true,
        },
      ],
    },
    f.library,
  );
  expect(out.query.missing.some((m) => m.required)).toBe(true);
  expect(out.draft.groups[0].assetRef).toBe(null);
  expect(out.intent.features[0].category).toBe("tree");
});
test("description identity and manual changes invalidate procedural acceptance bindings", async () => {
  const f = await buildFixture({ count: 1 });
  const out = await makeManualDraft(request, settings, f.library);
  const selected = new Set(
    proceduralChoices(out.intent, out.draft, f.library).map((c) => c.slotId),
  );
  const a = await confirmProceduralChoices(
      request,
      out.intent,
      out.draft,
      f.library,
      selected,
    ),
    b = await confirmProceduralChoices(
      { ...request, operationId: "another-request" },
      out.intent,
      out.draft,
      f.library,
      selected,
    );
  expect(a.review.manualOverrides).not.toEqual(b.review.manualOverrides);
});

test("manual selected candidates pass the real resolvePlan capability gate", async () => {
  const { resolvePlan } = await import("./compile");
  const f = await buildFixture({ categories: ["rock", "grass"], count: 1 });
  const out = await makeManualDraft(
    request,
    {
      ...settings,
      water: { mode: "none" },
      groups: [
        ...settings.groups,
        { ...settings.groups[0], category: "grass" },
      ],
    },
    f.library,
  );
  const choices = proceduralChoices(out.intent, out.draft, f.library);
  const reviewed = await confirmProceduralChoices(
    request,
    out.intent,
    out.draft,
    f.library,
    new Set(choices.map((c) => c.slotId)),
  );
  const result = await resolvePlan(
    reviewed,
    f.state,
    f.library,
    new AbortController().signal,
    { retainedBytes: 0 },
  );
  expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
});
