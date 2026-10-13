import { afterEach, expect, test, vi } from "vitest";
import { planRequest, planningRequirementDigest } from "./planner.ts";
import {
  asset,
  atom,
  intent,
  library,
  draft,
  reply,
  request,
} from "../../tests/support/general-planning-fixture.ts";
const signal = () => new AbortController().signal;
const ports = async (transform: (p: any) => void = () => {}) => {
  const lib = await library(),
    p = await draft(lib);
  transform(p);
  return {
    library: lib,
    transport: vi.fn(async (r: any) =>
      reply(r.stage === "intent" ? intent() : p),
    ),
    countTokens: vi.fn(async (_input: string, _signal: AbortSignal) => 100),
    now: () => Date.now(),
  };
};
afterEach(() => vi.useRealTimers());
test("two stages return a bound draft and unchanged raw input with constructed evidence", async () => {
  const p = await ports(),
    r = request(),
    before = structuredClone(r);
  const out = await planRequest(r, p, signal());
  expect(out.ok).toBe(true);
  if (!out.ok) throw Error(JSON.stringify(out.issues));
  expect(out.value.intent.raw).toBe(r.prompt);
  expect(out.value.draft.groups[0].count).toBe(2);
  expect(out.value.evidence).toHaveLength(2);
  expect(
    out.value.evidence.every((e: any) => e.provenance === "constructed"),
  ).toBe(true);
  expect(r).toEqual(before);
  expect(p.transport.mock.calls.map((c) => c[0].stage)).toEqual([
    "intent",
    "plan",
  ]);
  expect(p.countTokens).toHaveBeenCalledTimes(2);
});
test.each([
  "id",
  "version",
  "origin",
  "count",
  "water",
  "terrain",
  "catalog",
  "intent",
  "acceptance",
])("semantic %s violation fails without repair", async (kind) => {
  const p = await ports((d) => {
    if (kind === "id") d.groups[0].assetRef.id = "not-offered";
    if (kind === "version") d.groups[0].assetRef.contentVersion = "different";
    if (kind === "count") d.groups[0].count = 1;
    if (kind === "water") d.water = { mode: "unspecified" };
    if (kind === "terrain")
      d.terrain = {
        source: "procedural",
        elevation: 0,
        slopeDegrees: 0,
        slopeAzimuthDegrees: 0,
        noiseAmplitude: 0,
        noiseScale: 2,
        noiseOctaves: 1,
        spacing: 0.1,
      };
    if (kind === "catalog") d.catalogDigest = "f".repeat(64);
    if (kind === "intent") d.intentDigest = "f".repeat(64);
    if (kind === "acceptance") d.review.acceptedSubstitutions = [{}];
  });
  if (kind === "origin") {
    const lib = await library([
      asset(),
      asset("test-ground", "ground", "patch"),
    ]);
    p.library = {
      ...lib,
      manifests: lib.manifests.map((m) =>
        m.kind === "object" ? { ...m, origin: "procedural" as const } : m,
      ),
    };
  }
  const out = await planRequest(request(), p, signal());
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected failure");
  expect(out.partial.intent!.raw).toBe(request().prompt);
  expect(p.transport.mock.calls.every((c) => c[0].stage !== "repair")).toBe(
    true,
  );
});
test("missing required trees stops before plan rather than returning a default wetland", async () => {
  const p = await ports(),
    i = structuredClone(intent());
  i.raw = "森林不要水，扫描地块";
  i.features[0].category = "tree";
  i.features[0].quantity = null;
  p.transport.mockImplementation(async () => reply(i));
  const r = { ...request(), prompt: i.raw };
  const out = await planRequest(r, p, signal());
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected failure");
  expect(out.partial.intent!.raw).toBe(i.raw);
  expect(out.partial.draft).toBeNull();
  expect(p.transport).toHaveBeenCalledTimes(1);
  expect(out.issues.some((x: any) => x.code === "missing-assets")).toBe(true);
});
test("one format repair across both stages means fourth generation is never sent", async () => {
  vi.useFakeTimers();
  const p = await ports(),
    i = intent();
  p.transport.mockImplementationOnce(async () => reply("{"));
  p.transport.mockImplementationOnce(async () => reply(i));
  p.transport.mockImplementationOnce(async () => reply("{"));
  const out = await planRequest(request(), p, signal());
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected failure");
  expect(out.partial.evidence.map((x: any) => x.stage)).toEqual([
    "intent",
    "repair",
    "plan",
  ]);
  expect(p.transport).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(180000);
  expect(p.transport).toHaveBeenCalledTimes(3);
  expect(p.countTokens).toHaveBeenCalledTimes(3);
  expect(
    JSON.parse(JSON.parse(p.countTokens.mock.calls[1][0]).messages[1].content)
      .repair.raw,
  ).toBe("{");
});
test.each([2817, NaN, -1, 0.5])(
  "input count %s prevents generation",
  async (count) => {
    const p = await ports();
    p.countTokens.mockResolvedValue(count);
    const out = await planRequest(request(), p, signal());
    expect(out.ok).toBe(false);
    if (out.ok) throw Error("Expected failure");
    expect(p.transport).not.toHaveBeenCalled();
    expect(out.partial.evidence[0].raw).toBeNull();
  },
);
test("2816 input tokens are accepted and tokenizer failure leaves manual mode", async () => {
  const p = await ports();
  p.countTokens.mockResolvedValue(2816);
  expect((await planRequest(request(), p, signal())).ok).toBe(true);
  p.countTokens.mockRejectedValue(Error("tokenizer unavailable"));
  p.transport.mockClear();
  const out = await planRequest(request(), p, signal());
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected failure");
  expect(p.transport).not.toHaveBeenCalled();
  expect(out.issues[0].message).toMatch(/manual|手工/);
});
test("60 second request deadline discards a late reply and prevents stage two", async () => {
  vi.useFakeTimers();
  const p = await ports();
  let release!: (v: any) => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  p.transport.mockImplementation(() => {
    entered();
    return new Promise((r) => (release = r));
  });
  const run = planRequest(request(), p, signal());
  void run.catch(() => {});
  await ready;
  await vi.advanceTimersByTimeAsync(60001);
  const out = await run;
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected failure");
  expect(out.partial.evidence[0].raw).toBeNull();
  release(reply(intent()));
  await vi.advanceTimersByTimeAsync(120000);
  expect(p.transport).toHaveBeenCalledTimes(1);
});
test("absolute 120 seconds includes counting and bounds a later generation", async () => {
  vi.useFakeTimers();
  const p = await ports();
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  p.countTokens.mockImplementationOnce(() => {
    entered();
    return new Promise((r) => setTimeout(() => r(100), 70000));
  });
  p.transport.mockImplementation(() => new Promise(() => {}));
  const run = planRequest(request(), p, signal());
  void run.catch(() => {});
  await ready;
  await vi.advanceTimersByTimeAsync(120001);
  expect((await run).ok).toBe(false);
  expect(p.transport).toHaveBeenCalledTimes(1);
});
test("abort while counting releases promptly and never sends a model request", async () => {
  const p = await ports(),
    c = new AbortController();
  p.countTokens.mockImplementation(() => new Promise(() => {}));
  const run = planRequest(request(), p, c.signal);
  c.abort();
  expect((await run).ok).toBe(false);
  expect(p.transport).not.toHaveBeenCalled();
});
test("actual wrong identity and truncated raw survive in failure evidence", async () => {
  for (const bad of [
    { ...reply("partial"), model: "wrong" },
    { ...reply("partial"), doneReason: "length" },
  ]) {
    const p = await ports();
    p.transport.mockResolvedValue(bad);
    const out = await planRequest(request(), p, signal());
    expect(out.ok).toBe(false);
    if (out.ok) throw Error("Expected failure");
    expect(out.partial.evidence[0]).toMatchObject({
      raw: "partial",
      model: bad.model,
    });
    expect(p.transport).toHaveBeenCalledTimes(1);
  }
});
test("manual counts are separate from original intent and model raw", async () => {
  const p = await ports((d) => (d.groups[0].count = 3)),
    r = request();
  r.manualOverrides = [atom("features.rocks.count", 3, "manual")];
  const out = await planRequest(r, p, signal());
  expect(out.ok).toBe(true);
  if (!out.ok) throw Error(JSON.stringify(out.issues));
  expect(out.value.intent.features[0].quantity!.value).toBe(2);
  expect(out.value.draft.review.manualOverrides).toEqual(r.manualOverrides);
  expect(out.value.evidence[0].raw).toContain('"value":2');
});
test("procedural confirmation binds requirement revision, content and slot", async () => {
  const p = await ports(),
    m = structuredClone(asset());
  m.origin = "procedural";
  p.library = await library([m, asset("test-ground", "ground", "patch")]);
  const d = await draft(p.library);
  p.transport.mockImplementation(async (r: any) =>
    reply(r.stage === "intent" ? intent() : d),
  );
  const r = request();
  const first = await planRequest(r, p, signal());
  expect(first.ok).toBe(false);
  r.manualOverrides = [
    atom(
      "accept.procedural.object:0",
      {
        groupId: "rocks",
        requirementDigest: await planningRequirementDigest(r),
        catalogDigest: p.library.digest,
        assetRef: structuredClone(d.groups[0].assetRef),
        digest: "a".repeat(64),
      },
      "manual",
    ),
  ];
  const confirmed = await planRequest(r, p, signal());
  expect(
    confirmed.ok,
    confirmed.ok ? "" : JSON.stringify(confirmed.issues),
  ).toBe(true);
  r.manualOverrides[0].value.assetRef.contentVersion =
    "sha256-" + "c".repeat(64);
  const out = await planRequest(r, p, signal());
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected failure");
  expect(out.issues.some((x: any) => x.code === "confirmation")).toBe(true);
});

test("semantic rejection is attached to the actual model reply evidence", async () => {
  const p = await ports((d) => (d.groups[0].count = 1));
  const out = await planRequest(request(), p, signal());
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected failure");
  expect(out.partial.evidence.at(-1)?.failureReason).toEqual(
    expect.stringMatching(/数量/),
  );
});
test("hard feature scale cannot be changed within a broader admitted asset range", async () => {
  const m = structuredClone(asset());
  m.object.scaleRange = [0.5, 1];
  m.object.scaleRangeEvidence = "docs/test.md";
  const p = await ports();
  p.library = await library([m, asset("test-ground", "ground", "patch")]);
  const i = structuredClone(intent());
  i.features[0].constraints = [atom("scale", 0.5)];
  const d = await draft(p.library, i);
  p.transport.mockImplementation(async (r: any) =>
    reply(r.stage === "intent" ? i : d),
  );
  const out = await planRequest(request(), p, signal());
  expect(out.ok).toBe(false);
});
test("hard water width and source of explicit level are retained", async () => {
  const p = await ports(),
    i = structuredClone(intent());
  i.water = {
    mode: "river",
    constraints: [atom("width", 0.8), atom("level", 0, "user")],
  };
  i.raw = "河流宽0.8，水位0，扫描地块，2个石头";
  // An admitted constructed style metadata double supplies the required water surface slot.
  const { styleContentVersion } = await import("./asset-library.ts");
  const style: any = {
    id: "test-style",
    contentVersion: "pending",
    parameters: { roughness: 0.5 },
    quality: structuredClone(p.library.manifests[0].quality),
    provenance: p.library.manifests[0].provenance,
  };
  style.quality.operations = ["browse", "place-on-patch"];
  style.quality.status = "candidate";
  style.quality.humanReview = null;
  style.contentVersion = await styleContentVersion(style);
  style.quality.status = "accepted";
  style.quality.humanReview = {
    ...p.library.manifests[0].quality.humanReview,
    asset: { id: style.id, contentVersion: style.contentVersion },
    operations: style.quality.operations,
  };
  p.library = { ...p.library, styles: [style] };
  const d = await draft(p.library, i);
  d.surfaceStyleRef = { id: style.id, contentVersion: style.contentVersion };
  d.water = {
    mode: "river",
    waterId: "w",
    controlPoints: [
      [0.5, 0],
      [0.5, 1],
    ],
    width: 0.4,
    depth: 0.1,
    bankWidth: 0.4,
    level: 0,
    levelStatus: "resolved",
    levelSource: "model",
    reshapePolicy: "preserve",
  };
  p.transport.mockImplementation(async (r: any) =>
    reply(r.stage === "intent" ? i : d),
  );
  const r = { ...request(), prompt: i.raw };
  r.manualOverrides = [
    atom(
      "accept.procedural.style:surfaceStyle",
      {
        groupId: null,
        requirementDigest: await planningRequirementDigest(r),
        catalogDigest: p.library.digest,
        assetRef: d.surfaceStyleRef,
        digest: style.contentVersion.slice(7),
      },
      "manual",
    ),
  ];
  const out = await planRequest(r, p, signal());
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected failure");
  expect(out.issues[0].code).toBe("semantic");
});
test("unknown hard constraints fail closed instead of disappearing", async () => {
  const p = await ports(),
    i = structuredClone(intent());
  i.features[0].constraints = [atom("unimplemented-constraint", 3)];
  const d = await draft(p.library, i);
  p.transport.mockImplementation(async (r: any) =>
    reply(r.stage === "intent" ? i : d),
  );
  const out = await planRequest(request(), p, signal());
  expect(out.ok).toBe(false);
  expect(p.transport).toHaveBeenCalledTimes(1);
});
test("procedural acknowledgements cannot be replayed into a different create operation", async () => {
  const r = request();
  const first = await planningRequirementDigest(r);
  r.operationId = "another-scene-operation";
  expect(await planningRequirementDigest(r)).not.toBe(first);
});
test("model cannot fabricate a substitution without a manual override", async () => {
  const p = await ports((d) => {
    d.review.substitutions = [
      {
        substitutionId: "replace-origin",
        groupId: "rocks",
        requested: "captured rock",
        assetRef: d.groups[0].assetRef,
        digest: "a".repeat(64),
        reason: "model says user accepted",
      },
    ];
  });
  const out = await planRequest(request(), p, signal());
  expect(out.ok).toBe(false);
});
test("missing optional slots remain explicit in the returned review", async () => {
  const p = await ports(),
    i = structuredClone(intent());
  i.features.push({
    ...i.features[0],
    featureId: "optional-tree",
    category: "tree",
    required: false,
    quantity: atom("count", 1),
  });
  const d = await draft(p.library, i);
  p.transport.mockImplementation(async (r: any) =>
    reply(r.stage === "intent" ? i : d),
  );
  const out = await planRequest(request(), p, signal());
  expect(out.ok).toBe(true);
  if (!out.ok) throw Error(JSON.stringify(out.issues));
  expect(out.value.draft.review.missing).toContainEqual(
    expect.objectContaining({ key: "object:1", required: false }),
  );
});

test.each(["negated", "suggestion"])(
  "%s acknowledgement is not affirmative procedural consent",
  async (kind) => {
    const p = await ports(),
      m = structuredClone(asset());
    m.origin = "procedural";
    p.library = await library([m, asset("test-ground", "ground", "patch")]);
    const d = await draft(p.library);
    p.transport.mockImplementation(async (r: any) =>
      reply(r.stage === "intent" ? intent() : d),
    );
    const r = request();
    const a = atom(
      "accept.procedural.object:0",
      {
        groupId: "rocks",
        requirementDigest: await planningRequirementDigest(r),
        catalogDigest: p.library.digest,
        assetRef: structuredClone(d.groups[0].assetRef),
        digest: "a".repeat(64),
      },
      "manual",
    );
    if (kind === "negated") a.negated = true;
    else a.strength = "suggestion";
    r.manualOverrides = [a];
    const out = await planRequest(r, p, signal());
    expect(out.ok).toBe(false);
  },
);
test("model cannot label its assumptions as manual decisions", async () => {
  const p = await ports(
    (d) => (d.review.assumptions = [atom("source", "procedural", "manual")]),
  );
  expect((await planRequest(request(), p, signal())).ok).toBe(false);
});
test("density suggestions retain source spans and do not become hard user numbers", async () => {
  const p = await ports(),
    i = structuredClone(intent());
  i.features[0].quantity = {
    ...atom("density", "sparse", "user"),
    strength: "suggestion",
  };
  const d = await draft(p.library, i);
  d.groups[0].countMode = "suggestion";
  p.transport.mockImplementation(async (r: any) =>
    reply(r.stage === "intent" ? i : d),
  );
  // This prompt has no conflicting explicit numeral; source spans are original UTF-16 positions.
  i.raw = "稀疏石头，不要水，扫描地块";
  d.intentDigest = await (await import("./canonical.ts")).documentDigest(i);
  const out = await planRequest({ ...request(), prompt: i.raw }, p, signal());
  expect(out.ok).toBe(true);
  if (!out.ok) throw Error(JSON.stringify(out.issues));
  expect(out.value.draft.review.assumptions).toContainEqual(
    expect.objectContaining({
      key: "slots.object:0.count",
      value: { groupId: "rocks", value: 2 },
      source: "user",
      span: [0, 1],
      strength: "suggestion",
    }),
  );
});
test("full legal operation identity still produces a valid bounded plan identity", async () => {
  const p = await ports(),
    r = { ...request(), operationId: "界".repeat(200) },
    i = { ...intent(), requestId: r.operationId };
  p.transport.mockImplementation(async (req: any) => {
    if (req.stage === "intent") return reply(i);
    const d = await draft(p.library, i);
    d.planId = req.payload.bindings.planId;
    return reply(d);
  });
  expect((await planRequest(r, p, signal())).ok).toBe(true);
});
test("model cannot choose a different program rules version", async () => {
  const p = await ports((d) => (d.rulesVersion = "invented-rules"));
  expect((await planRequest(request(), p, signal())).ok).toBe(false);
});

test("default procedural terrain and counts are visible proposals before confirmation", async () => {
  const { createCatalogView, makeAssetLibrary, styleContentVersion } =
    await import("./asset-library.ts");
  const { manifestFixture, planFixture } = await import("./test-fixtures.ts");
  const m = manifestFixture("patch"),
    style: any = {
      id: "test-style",
      contentVersion: "pending",
      parameters: { roughness: 0.5 },
      quality: m.quality,
      provenance: m.provenance,
    };
  style.contentVersion = await styleContentVersion(style);
  style.quality = {
    ...style.quality,
    status: "accepted",
    inspectionViews: [{ position: [0, 1, 3], target: [0, 0, 0] }],
    humanReview: {
      reviewer: "Constructed metadata test, not human evidence",
      reviewedAt: "2026-10-11T00:00:00Z",
      asset: { id: style.id, contentVersion: style.contentVersion },
      files: [
        { path: "style-identity.json", sha256: style.contentVersion.slice(7) },
      ],
      operations: style.quality.operations,
    },
  };
  const p = await ports(),
    i = structuredClone(intent());
  i.raw = "石头，不要水";
  i.terrain = [];
  i.features[0].quantity = null;
  p.library = makeAssetLibrary(
    await createCatalogView([asset()], [style]),
    async () => new Uint8Array(),
  );
  const d = await draft(p.library, i);
  d.terrain = planFixture().terrain;
  d.surfaceStyleRef = { id: style.id, contentVersion: style.contentVersion };
  d.groups[0].count = 4;
  d.groups[0].countMode = "suggestion";
  p.transport.mockImplementation(async (r: any) =>
    reply(r.stage === "intent" ? i : d),
  );
  const r = { ...request(), prompt: i.raw };
  const initial = await planRequest(r, p, signal());
  expect(initial.ok).toBe(false);
  if (initial.ok) throw Error("Expected pending consent");
  expect(initial.partial.draft?.review.assumptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "terrain.source",
        value: "procedural",
        source: "default",
      }),
      expect.objectContaining({
        key: "slots.object:0.count",
        value: { groupId: "rocks", value: 4 },
        source: "default",
      }),
    ]),
  );
  r.manualOverrides = [
    atom(
      "accept.procedural.style:surfaceStyle",
      {
        groupId: null,
        requirementDigest: await planningRequirementDigest(r),
        catalogDigest: p.library.digest,
        assetRef: d.surfaceStyleRef,
        digest: style.contentVersion.slice(7),
      },
      "manual",
    ),
  ];
  const out = await planRequest(r, p, signal());
  expect(out.ok).toBe(true);
  if (!out.ok) throw Error(JSON.stringify(out.issues));
  expect(out.value.draft.review.fieldSources).toContainEqual(
    expect.objectContaining({
      key: "slots.object:0.assetRef",
      source: "model",
    }),
  );
});

async function runCase(
  i: any,
  d: any,
  lib: Awaited<ReturnType<typeof library>>,
  r = { ...request(), prompt: i.raw },
) {
  const transport = vi.fn(async (req: any) =>
    reply(req.stage === "intent" ? i : d),
  );
  const out = await planRequest(
    r,
    { library: lib, transport, countTokens: async () => 100, now: Date.now },
    signal(),
  );
  return { out, transport };
}

test.each(["terrain", "surfaceStyle"])(
  "cross-role asset selection is refused for legal feature %s",
  async (key) => {
    const lib = { ...(await library()) },
      i = structuredClone(intent());
    i.features[0].featureId = key;
    const d = await draft(lib, i);
    d.groups[0].groupId = key;
    d.relations[0].groupId = key;
    if (key === "terrain")
      d.groups[0].assetRef = structuredClone(d.terrain.assetRef);
    else {
      const { style } =
        await import("../../tests/support/general-planning-fixture.ts");
      const s = await style();
      Object.assign(lib, { styles: [s] });
      i.terrain = [atom("source", "procedural")];
      d.intentDigest = await (await import("./canonical.ts")).documentDigest(i);
      d.terrain = (await import("./test-fixtures.ts")).planFixture().terrain;
      d.surfaceStyleRef = { id: s.id, contentVersion: s.contentVersion };
      d.groups[0].assetRef = d.surfaceStyleRef;
    }
    d.groups[0].orientation = { mode: "fixed", yawDegrees: [0, 0] };
    d.groups[0].placementPolicy.maxSlopeDegrees = 0;
    const { out, transport } = await runCase(i, d, lib);
    expect(out.ok).toBe(false);
    if (out.ok) throw Error("Expected role refusal");
    expect(out.issues[0].code).toBe("candidate-authority");
    expect(transport).toHaveBeenCalledTimes(2);
  },
);

test.each([
  "terrain",
  "surfaceStyle",
  "界".repeat(200),
  "😀".repeat(100),
  "a.b:😀",
])(
  "full feature identity %s survives confirmation and bounded derived keys",
  async (key) => {
    const m = structuredClone(asset());
    m.origin = "procedural";
    const lib = await library([m, asset("test-ground", "ground", "patch")]),
      i = structuredClone(intent());
    i.features[0].featureId = key;
    i.features[0].quantity = null;
    i.raw = "石头，不要水，扫描地块";
    const d = await draft(lib, i);
    d.groups[0].groupId = key;
    d.relations[0].groupId = key;
    d.groups[0].count = 4;
    d.groups[0].countMode = "suggestion";
    const r = { ...request(), prompt: i.raw };
    r.manualOverrides = [
      atom(
        "accept.procedural.object:0",
        {
          groupId: key,
          requirementDigest: await planningRequirementDigest(r),
          catalogDigest: lib.digest,
          assetRef: structuredClone(d.groups[0].assetRef),
          digest: "a".repeat(64),
        },
        "manual",
      ),
    ];
    const { out } = await runCase(i, d, lib, r);
    expect(out.ok, out.ok ? "" : JSON.stringify(out.issues)).toBe(true);
    if (!out.ok) throw Error("Expected valid identity");
    expect(out.value.draft.groups[0].groupId).toBe(key);
    expect(out.value.draft.review.substitutions[0].groupId).toBe(key);
    expect(
      out.value.draft.review.substitutions[0].substitutionId.length,
    ).toBeLessThanOrEqual(200);
    expect(out.value.draft.review.assumptions).toContainEqual(
      expect.objectContaining({
        key: "slots.object:0.count",
        value: { groupId: key, value: 4 },
      }),
    );
  },
);

test("object and style with same label require distinct consent bound to their roles", async () => {
  const { style } =
    await import("../../tests/support/general-planning-fixture.ts");
  const m = structuredClone(asset());
  m.origin = "procedural";
  const lib = { ...(await library([m])) },
    s = await style();
  Object.assign(lib, { styles: [s] });
  const i = structuredClone(intent());
  i.features[0].featureId = "surfaceStyle";
  i.terrain = [atom("source", "procedural")];
  const d = await draft(lib, i);
  d.groups[0].groupId = "surfaceStyle";
  d.relations[0].groupId = "surfaceStyle";
  d.terrain = (await import("./test-fixtures.ts")).planFixture().terrain;
  d.surfaceStyleRef = { id: s.id, contentVersion: s.contentVersion };
  const r = request(),
    revision = await planningRequirementDigest(r);
  r.manualOverrides = [
    atom(
      "accept.procedural.object:0",
      {
        groupId: "surfaceStyle",
        requirementDigest: revision,
        catalogDigest: lib.digest,
        assetRef: d.groups[0].assetRef,
        digest: "a".repeat(64),
      },
      "manual",
    ),
  ];
  const first = await runCase(i, d, lib, r);
  expect(first.out.ok).toBe(false);
  if (first.out.ok) throw Error("Style consent missing");
  expect(first.out.issues[0].code).toBe("confirmation");
  r.manualOverrides.push(
    atom(
      "accept.procedural.style:surfaceStyle",
      {
        groupId: null,
        requirementDigest: revision,
        catalogDigest: lib.digest,
        assetRef: d.surfaceStyleRef,
        digest: s.contentVersion.slice(7),
      },
      "manual",
    ),
  );
  expect((await runCase(i, d, lib, r)).out.ok).toBe(true);
  r.manualOverrides[0].value.groupId = "another-group";
  expect((await runCase(i, d, lib, r)).out.ok).toBe(false);
});

test.each(["negated", "kind-override"])(
  "hard relation %s fails before second stage",
  async (kind) => {
    const lib = await library(),
      i = structuredClone(intent());
    i.raw = "放2个石头，不要水，使用扫描地块；不要把石头放在all区域内。";
    i.relations = [
      {
        ...atom("within", { groupId: "rocks", regionId: "all" }, "user"),
        span: [17, 31],
        negated: kind === "negated",
      },
    ];
    if (kind === "kind-override") i.relations[0].value.kind = "outside";
    const d = await draft(lib, i);
    d.relations = [
      {
        kind: kind === "negated" ? "within" : "outside",
        groupId: "rocks",
        regionId: "all",
      },
    ];
    const { out, transport } = await runCase(i, d, lib);
    expect(out.ok).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    if (out.ok) throw Error("Expected unsupported relation");
    expect(out.issues[0].code).toBe("unsupported");
    expect(out.partial.intent!.relations[0]).toEqual(i.relations[0]);
  },
);

test.each(["none", "unspecified"])(
  "style reference without applicable slot is refused for patch water %s",
  async (mode) => {
    const lib = await library(),
      i = structuredClone(intent());
    i.water.mode = mode;
    if (mode === "unspecified") i.raw = "放2个石头，使用扫描地块";
    const d = await draft(lib, i);
    d.water.mode = mode;
    d.surfaceStyleRef = {
      id: "unknown-style",
      contentVersion: "sha256-" + "f".repeat(64),
    };
    const { out } = await runCase(i, d, lib);
    expect(out.ok).toBe(false);
    if (out.ok) throw Error("Expected reference refusal");
    expect(out.issues[0].code).toBe("candidate-authority");
  },
);

test.each(["yaw", "tilt", "scale", "baseline-unverified"])(
  "unadmitted object effect %s is refused",
  async (effect) => {
    const m = structuredClone(asset());
    m.quality.operations = ["place"];
    m.quality.humanReview.operations = ["place"];
    m.object.rotation = effect === "tilt" ? "surface-normal" : "upright-yaw";
    m.object.verifiedYawDegrees = effect === "baseline-unverified" ? [90] : [0];
    if (effect === "scale") {
      m.object.scaleRange = [0.5, 1];
      m.object.scaleRangeEvidence = "docs/test.md";
    }
    const lib = await library([m, asset("test-ground", "ground", "patch")]),
      i = intent(),
      d = await draft(lib, i);
    d.groups[0].orientation = {
      mode: m.object.rotation,
      yawDegrees: effect === "yaw" ? [90, 90] : [0, 0],
    };
    d.groups[0].placementPolicy.maxSlopeDegrees = effect === "tilt" ? 10 : 0;
    if (effect === "scale") d.groups[0].scaleRange = [0.5, 0.5];
    const { out } = await runCase(i, d, lib);
    expect(out.ok).toBe(false);
    if (out.ok) throw Error("Expected operation refusal");
    expect(out.issues[0].code).toBe("asset-capability");
  },
);

test.each(["admitted", "place-baseline", "fixed-verified"])(
  "rotation policy allows %s without capability promotion",
  async (kind) => {
    const m = structuredClone(asset());
    m.object.rotation = kind === "fixed-verified" ? "fixed" : "upright-yaw";
    m.object.verifiedYawDegrees = kind === "fixed-verified" ? [90] : [0];
    if (kind !== "admitted") {
      m.quality.operations = ["place"];
      m.quality.humanReview.operations = ["place"];
    }
    const lib = await library([m, asset("test-ground", "ground", "patch")]),
      i = intent(),
      d = await draft(lib, i);
    d.groups[0].orientation = {
      mode: m.object.rotation,
      yawDegrees:
        kind === "admitted"
          ? [0, 360]
          : kind === "fixed-verified"
            ? [90, 90]
            : [0, 0],
    };
    d.groups[0].placementPolicy.maxSlopeDegrees = 0;
    const { out } = await runCase(i, d, lib);
    expect(out.ok, out.ok ? "" : JSON.stringify(out.issues)).toBe(true);
  },
);

test.each(["x".repeat(201), "bad\u0000identity", "", "\ud800"])(
  "bounded rejected returned model text is preserved (%j)",
  async (model) => {
    const { createGeneralTransport } = await import("./model-transport.ts");
    const actualRaw = "actual rejected text\u0000";
    const transport = createGeneralTransport(
      (async () =>
        new Response(
          JSON.stringify({
            model,
            choices: [
              {
                message: { role: "assistant", content: actualRaw },
                finish_reason: "stop",
              },
            ],
          }),
        )) as typeof fetch,
    );
    const out = await planRequest(
      request(),
      {
        library: await library(),
        transport,
        countTokens: async () => 100,
        now: Date.now,
      },
      signal(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw Error("Expected protocol refusal");
    expect(out.partial.evidence).toHaveLength(1);
    expect(out.partial.evidence[0]).toMatchObject({
      raw: actualRaw,
      model,
      failureReason: expect.stringMatching(/身份|协议/),
    });
    expect(out.issues[0].message).not.toContain("Invalid text");
  },
);

test("long termination diagnostic is bounded while actual reply evidence survives", async () => {
  const { createGeneralTransport } = await import("./model-transport.ts");
  const transport = createGeneralTransport(
    (async () =>
      new Response(
        JSON.stringify({
          model: reply("").model,
          choices: [
            {
              message: { role: "assistant", content: "actual text" },
              finish_reason: "x".repeat(10000),
            },
          ],
        }),
      )) as typeof fetch,
  );
  const out = await planRequest(
    request(),
    {
      library: await library(),
      transport,
      countTokens: async () => 100,
      now: Date.now,
    },
    signal(),
  );
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected termination refusal");
  expect(out.partial.evidence[0]).toMatchObject({
    raw: "actual text",
    model: reply("").model,
    failureReason: expect.stringMatching(/^模型未正常结束:/),
  });
  expect(out.partial.evidence[0].failureReason!.length).toBeLessThanOrEqual(
    2000,
  );
});

test("diagnostic truncation keeps the failure prefix without splitting a UTF16 pair", async () => {
  const { createGeneralTransport } = await import("./model-transport.ts");
  const finish = "x".repeat(1800 - "模型未正常结束: ".length - 1) + "😀";
  const transport = createGeneralTransport(
    (async () =>
      new Response(
        JSON.stringify({
          model: reply("").model,
          choices: [
            {
              message: { role: "assistant", content: "actual text" },
              finish_reason: finish,
            },
          ],
        }),
      )) as typeof fetch,
  );
  const out = await planRequest(
    request(),
    {
      library: await library(),
      transport,
      countTokens: async () => 100,
      now: Date.now,
    },
    signal(),
  );
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected termination refusal");
  const reason = out.partial.evidence[0].failureReason!;
  expect(reason).toMatch(/^模型未正常结束:/);
  expect(reason.length).toBeLessThanOrEqual(1800);
  expect(reason.endsWith("\ud83d")).toBe(false);
  expect(out.partial.evidence[0].raw).toBe("actual text");
});

test("long actual model identity within a 64KiB response remains exact evidence", async () => {
  const { createGeneralTransport } = await import("./model-transport.ts");
  const model = "界".repeat(20000),
    actualRaw = "actual bounded reply";
  const body = JSON.stringify({
    model,
    choices: [
      {
        message: { role: "assistant", content: actualRaw },
        finish_reason: "stop",
      },
    ],
  });
  expect(new TextEncoder().encode(body).length).toBeLessThan(65536);
  const transport = createGeneralTransport(
    (async () => new Response(body)) as typeof fetch,
  );
  const out = await planRequest(
    request(),
    {
      library: await library(),
      transport,
      countTokens: async () => 100,
      now: Date.now,
    },
    signal(),
  );
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("Expected identity refusal");
  expect(out.partial.evidence[0]).toMatchObject({ model, raw: actualRaw });
});
