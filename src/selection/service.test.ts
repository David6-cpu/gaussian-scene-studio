import { expect, test } from "vitest";
import {
  interpretRequest,
  selectAssets,
  parseRequirementEvidence,
  parseChoiceEvidence,
  type AssetTransport,
} from "./service";
import { createAssetTransport } from "./transport";
import { defaultAssetRequest } from "./contract";
import { LLAMA_SMALL_MODEL } from "../planner/service";
const choice = {
  choices: [
    { key: "ground", assetId: "riverside-ground-v1" },
    { key: "rocks", assetId: "river-rock-v1" },
    { key: "plants", assetId: "river-low-grass-v2" },
  ],
};
const reply = (value: unknown) => ({
  raw: JSON.stringify(value),
  model: LLAMA_SMALL_MODEL,
  done: true,
  doneReason: "stop",
});
const signal = () => new AbortController().signal;
test("two stages preserve model evidence and deterministic candidate snapshot", async () => {
  const first = await interpretRequest(
    "湿地，2组石头和4丛低草",
    async () => reply(defaultAssetRequest),
    signal(),
  );
  expect(parseRequirementEvidence(first)).toEqual(first);
  const next = await selectAssets(
    first.request,
    async (stage, payload, schema) => {
      expect(stage).toBe("choose");
      expect(JSON.stringify(payload)).toContain("river-low-grass-v2");
      expect(JSON.stringify(schema)).not.toContain("legacy-plant-v1");
      return reply(choice);
    },
    signal(),
  );
  expect(parseChoiceEvidence(next)).toEqual(next);
  expect(next.candidates[2].assetIds).toEqual(["river-low-grass-v2"]);
  expect(() =>
    parseChoiceEvidence({ ...next, choices: [...next.choices].reverse() }),
  ).toThrow();
  expect(() => parseChoiceEvidence({ ...next, candidates: [] })).toThrow();
});
test("missing and unsupported demands stop before transport", async () => {
  const fail: AssetTransport = async () => {
    throw Error("TRANSPORT WAS CALLED");
  };
  await expect(interpretRequest("雪山", fail, signal())).rejects.toThrow(
    /缺失/,
  );
  await expect(
    selectAssets(
      { ...defaultAssetRequest, plantOrigin: "captured" },
      fail,
      signal(),
    ),
  ).rejects.toThrow(/缺失/);
  await expect(
    selectAssets(
      { ...defaultAssetRequest, biome: "unsupported" },
      fail,
      signal(),
    ),
  ).rejects.toThrow(/缺失/);
});
test.each([
  { model: "wrong" },
  { doneReason: "length" },
  { raw: "not json" },
  { done: false },
])("bad response is rejected without fallback: %j", async (patch) => {
  await expect(
    selectAssets(
      defaultAssetRequest,
      async () => ({ ...reply(choice), ...patch }),
      signal(),
    ),
  ).rejects.toThrow();
});
test("cancellation and unavailable runtime fail without a default", async () => {
  const c = new AbortController();
  c.abort();
  await expect(
    selectAssets(defaultAssetRequest, async () => reply(choice), c.signal),
  ).rejects.toThrow();
  await expect(
    interpretRequest(
      "湿地",
      async () => {
        throw Error("offline");
      },
      signal(),
    ),
  ).rejects.toThrow(/offline/);
});
test("transport fixes 3B and localhost and passes schema with redirect disabled", async () => {
  const transport = createAssetTransport(async (url, init) => {
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(LLAMA_SMALL_MODEL);
    expect(body.max_tokens).toBe(1024);
    expect(body.response_format.json_schema.schema).toEqual({ type: "object" });
    return Response.json({
      model: LLAMA_SMALL_MODEL,
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "{}" },
        },
      ],
    });
  });
  expect(
    (await transport("choose", {}, { type: "object" }, signal())).raw,
  ).toBe("{}");
});
test("transport rejects tools and oversized streams", async () => {
  const bad = createAssetTransport(async () =>
    Response.json({
      model: LLAMA_SMALL_MODEL,
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "{}", tool_calls: [{}] },
        },
      ],
    }),
  );
  await expect(bad("choose", {}, {}, signal())).rejects.toThrow();
  const huge = createAssetTransport(
    async () => new Response("a".repeat(65537)),
  );
  await expect(huge("choose", {}, {}, signal())).rejects.toThrow(/64KiB/);
});

test.each([
  "湿地，不是不要实拍草，但也没说必须程序草，来源还没定；只放3丛低草，不要碎石，不放水，种子91。",
  "湿地，只放3丛草，素材来源还没确定。",
  "湿地，并非不接受程序草，放3丛。",
])(
  "live unresolved source asks for clarification before inference: %s",
  async (prompt) => {
    let calls = 0;
    await expect(
      interpretRequest(
        prompt,
        async () => {
          calls++;
          return reply(defaultAssetRequest);
        },
        signal(),
      ),
    ).rejects.toThrow(/来源.*澄清|澄清.*来源/);
    expect(calls).toBe(0);
  },
);

test.each([
  ["湿地，不要芦苇，只要3丛程序低草；不要碎石，不放水，种子91。", "procedural"],
  [
    "湿地，不要实拍草，使用3丛程序低草；不要碎石，不放水，种子91。",
    "procedural",
  ],
  ["湿地，只放3丛低草；不要碎石，不放水，种子91。", "either"],
] as const)(
  "clear or unmentioned source remains unmodified data: %s",
  async (prompt, plantOrigin) => {
    const r = {
      ...defaultAssetRequest,
      plantOrigin,
      plantCount: 3,
      rockCount: 0,
      waterLevel: null,
      seed: 91,
    };
    let sent: unknown;
    const result = await interpretRequest(
      prompt,
      async (stage, payload) => {
        sent = payload;
        return reply(r);
      },
      signal(),
    );
    expect(sent).toEqual({ description: prompt });
    expect(result.request).toEqual(r);
    expect(result.raw).toBe(JSON.stringify(r));
  },
);

test("historical ambiguous-source evidence remains parseable without applying new live guards", () => {
  const prompt = "湿地，不是不要实拍草，来源还没定。";
  const evidence = {
    prompt,
    request: defaultAssetRequest,
    raw: JSON.stringify(defaultAssetRequest),
    model: LLAMA_SMALL_MODEL,
    elapsedMs: 1,
  };
  expect(parseRequirementEvidence(evidence)).toEqual(evidence);
  expect(() =>
    parseRequirementEvidence({
      ...evidence,
      request: { ...defaultAssetRequest, plantOrigin: "captured" },
    }),
  ).toThrow(/原文不一致/);
});
