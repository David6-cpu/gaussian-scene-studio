import { expect, test } from "vitest";
import { defaultAssetRequest } from "../selection/contract";
import { LLAMA_SMALL_MODEL } from "../planner/service";
import { BUILTIN_CONTEXT } from "../assets/catalog/context";
import { waterRequirement, resolveWater } from "./water";
import { parseReviewRequestV2 } from "./requirements";
import {
  interpretReviewRequestV2,
  parseRequirementEvidenceV2,
} from "./service";

const { waterLevel: _oldLevel, ...materials } = defaultAssetRequest;
const river = { mode: "river", explicitLevel: null } as const;
const request = { ...materials, water: river };
const reply = (value: unknown) => ({
  raw: JSON.stringify(value),
  model: LLAMA_SMALL_MODEL,
  done: true,
  doneReason: "stop",
});
test.each([
  ["河岸上放一些低矮草丛和石头", "river", null],
  ["干涸河床，不放水，放4丛低草", "none", null],
  ["河岸上放一些低矮草丛和石头，不放水", "none", null],
  ["放一些低矮草丛和石头", "unspecified", null],
  ["河岸水位-0.025，2组石头、4丛低草", "river", -0.025],
  ["水位-0.025", "surface", -0.025],
  ["干河床", "none", null],
  ["需要一片水面", "surface", null],
  ["水面", "surface", null],
  ["不要水面", "none", null],
  ["不需要一片水面", "none", null],
  ["河岸，不要水面", "none", null],
])(
  "preserves intent independently of level: %s",
  (prompt, mode, explicitLevel) => {
    expect(waterRequirement(prompt)).toEqual({ mode, explicitLevel });
  },
);
test.each([
  "水位0，不放水",
  "干河床，同时有水",
  "干河床，同时需要一片水面",
  "不放水，同时需要一片水面",
  "水位0，不要水面",
  "不是不要水",
  "不要没有水",
  "不要干涸河床",
  "不干涸的河床",
  "河床不能干涸",
  "河里可能有水",
  "水位0到0.1",
  "水位0.1，水位-0.1",
])("uncertain/contradictory input makes no model call: %s", async (prompt) => {
  let calls = 0;
  await expect(
    interpretReviewRequestV2(
      prompt,
      async () => {
        calls++;
        return reply(request);
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/澄清/);
  expect(calls).toBe(0);
});
test("surface wording accepts correct evidence without rewriting the request or raw", async () => {
  const prompt = "需要一片水面";
  const surfaceRequest = {
    ...request,
    water: { mode: "surface", explicitLevel: null },
  };
  let calls = 0;
  const evidence = await interpretReviewRequestV2(
    prompt,
    async (_stage, payload) => {
      calls++;
      expect(payload).toEqual({ description: prompt });
      return reply(surfaceRequest);
    },
    new AbortController().signal,
  );
  expect(calls).toBe(1);
  expect(evidence.prompt).toBe(prompt);
  expect(evidence.raw).toBe(JSON.stringify(surfaceRequest));
  expect(evidence.request.water).toEqual(surfaceRequest.water);
  expect(resolveWater(evidence.request.water, BUILTIN_CONTEXT)).toMatchObject({
    status: "pending",
  });
});
test("real service preserves river null as intent instead of demanding a numeric level", async () => {
  const prompt = "河岸上放一些低矮草丛和石头";
  const evidence = await interpretReviewRequestV2(
    prompt,
    async (_stage, payload) => {
      expect(payload).toEqual({ description: prompt });
      return reply(request);
    },
    new AbortController().signal,
  );
  expect(evidence.request.water).toEqual(river);
  expect(evidence.raw).toBe(JSON.stringify(request));
  expect(parseRequirementEvidenceV2(evidence)).toEqual(evidence);
  expect(() =>
    parseRequirementEvidenceV2({
      ...evidence,
      request: { ...request, water: { mode: "none", explicitLevel: null } },
    }),
  ).toThrow(/原文/);
});
test.each([
  ["河岸", { mode: "none", explicitLevel: null }],
  ["河岸", { mode: "river", explicitLevel: 0 }],
  ["不放水", river],
  ["低草", { mode: "surface", explicitLevel: 0 }],
  ["水位-0.025", { mode: "river", explicitLevel: -0.025 }],
])(
  "rejects model water contradictions and invented levels for %s",
  async (prompt, water) => {
    await expect(
      interpretReviewRequestV2(
        prompt,
        async () => reply({ ...request, water }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/水体|水位/);
  },
);
test.each([
  { ...request, waterLevel: null },
  { ...request, water: { mode: "none", explicitLevel: 0 } },
  { ...request, water: { mode: "unspecified", explicitLevel: -0.025 } },
  { ...request, water: { mode: "river", explicitLevel: 1 } },
  { ...request, plantKind: "none", plantCount: 4 },
])("rejects ambiguous or invalid schema without legacy defaults", (value) => {
  expect(() => parseReviewRequestV2(value)).toThrow();
});
test("unresolved geometry stays pending; explicit absence and numbers alone can be ready", () => {
  expect(resolveWater(river, BUILTIN_CONTEXT)).toMatchObject({
    status: "pending",
  });
  expect(
    resolveWater({ mode: "unspecified", explicitLevel: null }, BUILTIN_CONTEXT),
  ).toMatchObject({ status: "pending" });
  expect(
    resolveWater({ mode: "none", explicitLevel: null }, BUILTIN_CONTEXT),
  ).toMatchObject({ status: "ready", waterLevel: null, source: "absence" });
  expect(
    resolveWater({ mode: "surface", explicitLevel: -0.025 }, BUILTIN_CONTEXT),
  ).toMatchObject({ status: "ready", waterLevel: -0.025, source: "explicit" });
  expect(
    resolveWater(river, { ...BUILTIN_CONTEXT, entries: [] }),
  ).toMatchObject({ status: "blocked" });
});
test("unknown prepared geometry is blocked even for an explicit level", async () => {
  const { preparedFixture } =
    await import("../../tests/support/prepared-fixture");
  const { asset } = await preparedFixture();
  expect(
    resolveWater(
      { mode: "surface", explicitLevel: 0 },
      { ...BUILTIN_CONTEXT, prepared: asset.definition },
    ),
  ).toMatchObject({ status: "blocked" });
});
