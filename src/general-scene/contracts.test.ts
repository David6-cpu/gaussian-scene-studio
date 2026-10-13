import { describe, expect, test, vi } from "vitest";
import {
  parseIntent,
  parsePlanDraft,
  parseScenePlan,
  parseSnapshot,
  parsePatch,
  parseEditableState,
  parseModelEvidence,
  parseCompileContext,
} from "./contracts";
import {
  manifestFixture,
  intentFixture,
  planFixture,
  stateFixture,
  snapshotFixture,
  patchFixture,
  waterFixture,
  evidenceFixture,
  brushFixture,
} from "./test-fixtures";

describe("strict planning contracts", () => {
  test("preserves raw text, hard values, source spans and negation", () => {
    const intent = intentFixture();
    intent.raw += "\n";
    expect(parseIntent(intent)).toEqual(intent);
    expect(parseIntent(intent).prohibitions[0]).toMatchObject({
      negated: true,
      source: "user",
      span: [0, 5],
    });
  });
  test("accepts 2000 characters and rejects 2001", () => {
    const intent = intentFixture();
    intent.raw = "界".repeat(2000);
    expect(parseIntent(intent).raw.length).toBe(2000);
    intent.raw += "界";
    expect(() => parseIntent(intent)).toThrow();
  });
  test.each([
    "unknown",
    "unsafe",
    "nan",
    "span",
    "operation",
    "source",
    "sparse",
    "accessor",
  ])("rejects %s intent", (kind) => {
    const i = intentFixture();
    if (kind === "unknown") i.extra = true;
    if (kind === "unsafe")
      Object.defineProperty(i, "__proto__", { value: {}, enumerable: true });
    if (kind === "nan") i.features[0].quantity.value = NaN;
    if (kind === "span") i.prohibitions[0].span = [4, 2000];
    if (kind === "operation") i.operation = "patch";
    if (kind === "source") i.prohibitions[0].source = "guessed";
    if (kind === "sparse") i.terrain = new Array(1);
    if (kind === "accessor")
      Object.defineProperty(i, "language", {
        get() {
          throw Error("getter executed");
        },
        enumerable: true,
      });
    expect(() => parseIntent(i)).toThrow();
  });
  test("only a draft may retain unresolved water or missing style", () => {
    const p = planFixture();
    p.water = waterFixture(true);
    p.surfaceStyleRef = null;
    expect(parsePlanDraft(p).water).toMatchObject({
      level: null,
      levelStatus: "pending",
    });
    expect(() => parseScenePlan(p)).toThrow();
    p.water = waterFixture();
    p.surfaceStyleRef = planFixture().surfaceStyleRef;
    expect(parseScenePlan(p).water).toMatchObject({ level: -0.025 });
  });
  test("spacing divides both extents without changing explicit dimensions", () => {
    const p = planFixture();
    p.domain.width = 7.5;
    p.domain.depth = 5.5;
    p.terrain.spacing = 0.2;
    expect(() => parseScenePlan(p)).toThrow();
    p.terrain.spacing = 0.1;
    expect(parseScenePlan(p).domain).toMatchObject({ width: 7.5, depth: 5.5 });
  });
  test.each([
    ["none geometry", (p: any) => (p.water.level = 0)],
    ["unknown version", (p: any) => (p.schemaVersion = 2)],
    ["oversize", (p: any) => (p.domain.width = 10.5)],
    ["fractional extent", (p: any) => (p.domain.width = 4.1)],
    ["metres", (p: any) => (p.domain.unit = "metre")],
    ["count cap", (p: any) => (p.groups[0].count = 21)],
    [
      "total count",
      (p: any) => {
        p.groups[0].count = 11;
        p.groups.push({ ...p.groups[0], groupId: "other" });
      },
    ],
    ["missing region", (p: any) => (p.groups[0].regionId = "missing")],
    ["unknown relation", (p: any) => (p.relations[0].kind = "script")],
    ["unknown group", (p: any) => (p.relations[0].groupId = "missing")],
    ["slope", (p: any) => (p.terrain.slopeDegrees = 13)],
    ["noise", (p: any) => (p.terrain.noiseAmplitude = 0.41)],
    [
      "missing required",
      (p: any) =>
        p.review.missing.push({
          key: "tree",
          required: true,
          reason: "Unavailable",
        }),
    ],
    [
      "self intersecting",
      (p: any) =>
        (p.regions[0].shape = {
          kind: "polygon",
          polygon: [
            [-1, -1],
            [1, 1],
            [-1, 1],
            [1, -1],
          ],
        }),
    ],
    ["outside", (p: any) => (p.regions[0].shape.max = [3, 2])],
    [
      "river out of domain",
      (p: any) => {
        p.water = waterFixture();
        p.water.controlPoints[0] = [-0.1, 0];
      },
    ],
    [
      "same river boundary",
      (p: any) => {
        p.water = waterFixture();
        p.water.controlPoints = [
          [0.2, 0],
          [0.8, 0],
        ];
      },
    ],
    [
      "surface invalid",
      (p: any) =>
        (p.water = {
          ...waterFixture(),
          mode: "surface",
          polygon: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        }),
    ],
    ["budget override", (p: any) => (p.budgetProfileId = "unlimited")],
    ["duplicate group", (p: any) => p.groups.push(p.groups[0])],
    [
      "stale substitution",
      (p: any) =>
        p.review.acceptedSubstitutions.push({
          substitutionId: "absent",
          planId: p.planId,
          catalogDigest: p.catalogDigest,
          assetRef: p.groups[0].assetRef,
          digest: "a".repeat(64),
        }),
    ],
  ])("rejects %s", (_, mutate) => {
    const p = planFixture();
    mutate(p);
    expect(() => parseScenePlan(p)).toThrow();
  });
  test("rigid patch is represented by exactly one unrestricted normalized transform", () => {
    const p = planFixture();
    p.terrain = {
      source: "patch",
      assetRef: { id: "constructed-patch", contentVersion: "constructed-v1" },
      transform: {
        position: [1, 0, 0],
        quaternion: [Math.sin(0.1), 0, 0, Math.cos(0.1)],
        scale: 2,
      },
    };
    p.surfaceStyleRef = null;
    expect(parseScenePlan(p).terrain).toEqual(p.terrain);
    p.terrain.slopeDegrees = 0;
    expect(() => parseScenePlan(p)).toThrow();
    delete p.terrain.slopeDegrees;
    p.water = waterFixture();
    expect(() => parseScenePlan(p)).toThrow();
    p.water.reshapePolicy = "preserve";
    p.surfaceStyleRef = planFixture().surfaceStyleRef;
    expect(parseScenePlan(p).water.mode).toBe("river");
  });
  test("nullable evidence is truthful and preserves received wrong model/raw", () => {
    const e = evidenceFixture();
    expect(parseModelEvidence(e).raw).toBeNull();
    e.model = "wrong-model";
    e.raw = "partial {";
    expect(parseModelEvidence(e)).toEqual(e);
    e.endedAt = "2026-10-10T00:00:00Z";
    expect(() => parseModelEvidence(e)).toThrow();
  });
});

describe("editable snapshots and patch contracts", () => {
  test("round trips a complete constructed snapshot without upgrading quality", () => {
    const s = snapshotFixture(),
      parsed = parseSnapshot(s);
    expect(parsed.capability).toBe("editable");
    expect(parsed.reviewStatus).toBe("draft");
    expect(parsed.quality.visual.status).toBe("pending");
    expect(parsed.terrain?.heights).toBeInstanceOf(Float32Array);
    expect(parsed.assets[0].manifest.quality.status).toBe("candidate");
  });
  test.each([
    ["blob ref", (s: any) => (s.terrain.heights = { blob: "hash" })],
    ["plain array", (s: any) => (s.terrain.heights = Array(1681).fill(0))],
    ["dimension", (s: any) => (s.terrain.nx = 40)],
    ["nonfinite", (s: any) => (s.terrain.heights[0] = Infinity)],
    ["height range", (s: any) => (s.terrain.heights[0] = 2.1)],
    ["normal", (s: any) => (s.terrain.normals[1] = 0)],
    ["duplicate output", (s: any) => (s.terrain.tiles[0].outputIndices[1] = 0)],
    [
      "missing ownership",
      (s: any) => (s.terrain.tiles[0].outputIndices = new Uint32Array([0])),
    ],
    ["outside node", (s: any) => (s.terrain.tiles[0].nodeIndices[0] = 1681)],
    ["surface count", (s: any) => (s.surfaces[0].count = 2)],
    [
      "surface ownership",
      (s: any) => (s.surfaces[0].tiles[0].outputIndices = new Uint32Array([1])),
    ],
    ["missing style", (s: any) => (s.surfaceStyle = null)],
    [
      "wrong asset version",
      (s: any) => (s.instances[0].assetRef.contentVersion = "wrong"),
    ],
    ["unknown instance", (s: any) => (s.instances[0].instanceId = "grass:9")],
    [
      "quality mismatch",
      (s: any) => (s.quality.geometryDigest = "b".repeat(64)),
    ],
    ["accept pending", (s: any) => (s.reviewStatus = "accepted")],
    [
      "detached",
      (s: any) => {
        structuredClone(s.terrain.heights.buffer, {
          transfer: [s.terrain.heights.buffer],
        });
      },
    ],
    [
      "shared ownership",
      (s: any) =>
        (s.terrain.heights = new Float32Array(new ArrayBuffer(20000), 0, 1681)),
    ],
  ])("rejects runtime %s", (_, mutate) => {
    const s = snapshotFixture();
    mutate(s);
    expect(() => parseSnapshot(s)).toThrow();
  });
  test("legacy preserves known results and original package without inventing editable data", () => {
    const s = snapshotFixture();
    s.capability = "legacy-readonly";
    s.intent = null;
    s.plan = null;
    s.state = null;
    s.originVersion = "f0-zip-v3";
    s.original = { digest: "a".repeat(64), bytes: new Uint8Array([1, 2, 3]) };
    expect(parseSnapshot(s).capability).toBe("legacy-readonly");
    s.state = stateFixture();
    expect(() => parseSnapshot(s)).toThrow();
  });
  test("retains cumulative brushes/dedupe and rejects dangling locked/tombstoned IDs", () => {
    const s = stateFixture();
    s.brushes = [brushFixture(1), brushFixture(2)];
    s.deduplications = [
      {
        sceneId: "scene",
        baseRevisionId: "base",
        patchId: "patch",
        operationId: "op",
        resultRevisionId: "result",
      },
    ];
    expect(parseEditableState(s)).toEqual(s);
    s.lockedInstanceIds = ["grass:8"];
    expect(() => parseEditableState(s)).toThrow();
    s.lockedInstanceIds = ["grass:0"];
    s.tombstones = ["grass:0"];
    expect(() => parseEditableState(s)).toThrow();
  });
  test("patch whitelists exact local operations and rejects global changes", () => {
    expect(parsePatch(patchFixture()).operations[0].kind).toBe("remove");
    const p = patchFixture();
    p.operations = [{ kind: "seed", seed: 1 }];
    expect(() => parsePatch(p)).toThrow();
    p.operations = [{ kind: "brush", center: [0, 0], radius: 0.5, delta: 0.1 }];
    expect(parsePatch(p).operations[0].kind).toBe("brush");
    p.operations[0].delta = 0.21;
    expect(() => parsePatch(p)).toThrow();
  });
  test("object-only H equals R and patches cannot modify locked IDs", () => {
    const p = patchFixture();
    p.effectiveRegion[0] = [-3, -3];
    expect(() => parsePatch(p)).toThrow();
    const locked = patchFixture();
    locked.lockedInstanceIds = ["grass:0"];
    expect(() => parsePatch(locked)).toThrow();
  });
  test("compile context requires real resource and matching base context", () => {
    const base = snapshotFixture();
    const ctx: any = {
      operationId: "operation:new",
      baseRevisionId: base.revisionId,
      sceneId: base.sceneId,
      revisionId: "revision:new",
      signal: new AbortController().signal,
      intent: base.intent,
      modelEvidence: base.modelEvidence,
      patch: { ...patchFixture(), baseRevisionId: base.revisionId },
      camera: base.camera,
      resources: { retainedBytes: 1234 },
      baseSnapshot: base,
    };
    expect(parseCompileContext(ctx).resources.retainedBytes).toBe(1234);
    ctx.baseSnapshot = null;
    expect(() => parseCompileContext(ctx)).toThrow();
    ctx.baseSnapshot = base;
    ctx.resources.retainedBytes = -1;
    expect(() => parseCompileContext(ctx)).toThrow();
  });
});

describe("downstream contract consistency regressions", () => {
  test("review atoms preserve original spans independently of array position", () => {
    const p = planFixture();
    p.review.fieldSources = [
      {
        key: "count",
        value: 2,
        source: "user",
        span: [7, 8],
        strength: "hard",
        negated: false,
      },
    ];
    expect(parseScenePlan(p).review.fieldSources[0].span).toEqual([7, 8]);
  });
  test("snapshot budgets include every owned result allocation", () => {
    const s = snapshotFixture();
    s.validation.usage.candidateCpuBytes = 1;
    expect(() => parseSnapshot(s)).toThrow(/byte|budget/i);
  });
  test("every planned reference exists even when no instances were accepted", () => {
    const s = snapshotFixture();
    s.plan.groups.push({
      ...s.plan.groups[0],
      groupId: "missing",
      assetRef: { id: "absent", contentVersion: "v1" },
      count: 0,
    });
    s.state.groups.push({ groupId: "missing", nextSlot: 0, retired: false });
    expect(() => parseSnapshot(s)).toThrow(/asset|descriptor/i);
  });
  test("instance identity must have a live plan group and respect its cumulative binding", () => {
    const s = snapshotFixture();
    s.plan.groups = [];
    s.plan.relations = [];
    expect(() => parseSnapshot(s)).toThrow();
    const t = snapshotFixture();
    t.instances[0].groupId = "other";
    t.instances[0].instanceId = "other:0";
    t.state.groups.push({ groupId: "other", nextSlot: 1, retired: false });
    expect(() => parseSnapshot(t)).toThrow();
  });
  test("constructed pending assets cannot become accepted by attaching check labels", () => {
    const s = snapshotFixture();
    s.reviewStatus = "accepted";
    s.quality.semanticMode = "manual-corrected";
    for (const key of [
      "semantic",
      "assets",
      "geometry",
      "visual",
      "performance",
    ])
      s.quality[key] = {
        status: "pass",
        evidenceRefs: ["constructed-check"],
        issues: [],
      };
    expect(() => parseSnapshot(s)).toThrow(/asset|style|accepted/i);
  });
  test("brush support stays wholly in the requested region", () => {
    const p = patchFixture();
    p.operations = [
      { kind: "brush", center: [1.9, 0], radius: 0.5, delta: 0.1 },
    ];
    expect(() => parsePatch(p)).toThrow(/brush|request/i);
    const s = stateFixture();
    s.brushes = [{ ...brushFixture(), center: [1.9, 0] }];
    expect(() => parseEditableState(s)).toThrow();
  });
  test("enumerable view metadata is discarded from runtime buffers", () => {
    const s = snapshotFixture();
    Object.defineProperty(s.terrain.heights, "unexpected", {
      value: true,
      enumerable: true,
    });
    const parsed = parseSnapshot(s);
    expect(Object.hasOwn(parsed.terrain!.heights, "unexpected")).toBe(false);
    expect(parsed.terrain!.heights.buffer).toBe(s.terrain.heights.buffer);
  });
  test("all patch operations retain exact parameters", () => {
    for (const operation of [
      {
        kind: "add",
        groupId: "grass",
        assetRef: planFixture().groups[0].assetRef,
        count: 2,
      },
      {
        kind: "replace",
        instanceId: "grass:0",
        assetRef: planFixture().groups[0].assetRef,
      },
      {
        kind: "move",
        instanceId: "grass:0",
        transform: snapshotFixture().instances[0].transform,
      },
      { kind: "set-count", groupId: "grass", count: 3 },
    ]) {
      const p = patchFixture();
      p.operations = [operation];
      expect(parsePatch(p).operations[0]).toEqual(operation);
    }
  });
});

test("frozen semantic and property inputs use this contract without a production compiler", async () => {
  const { readFile } = await import("node:fs/promises");
  const requests = JSON.parse(
    await readFile("tests/fixtures/general-scene-requests.json", "utf8"),
  );
  const properties = JSON.parse(
    await readFile("tests/fixtures/general-scene-properties.json", "utf8"),
  );
  expect(requests.cases).toHaveLength(20);
  expect(new Set(requests.cases.map((c: any) => c.original)).size).toBe(20);
  expect(requests.cases.filter((c: any) => c.kind === "positive")).toHaveLength(
    12,
  );
  for (const c of requests.cases) {
    expect(c.paraphrase).not.toBe(c.original);
    expect(c.paraphrase.length).toBeGreaterThan(0);
    if (c.kind === "positive")
      expect(parsePlanDraft(c.structuredDraft).seed).toBe(
        c.id === "P12" ? 17 : 42,
      );
  }
  expect(
    requests.cases.find((c: any) => c.id === "P09").structuredDraft.water.level,
  ).toBe(-0.025);
  expect(requests.cases.find((c: any) => c.id === "N05").original).toBe(
    "生成30组石头",
  );
  expect(properties.cases.map((c: any) => c.seed)).toEqual(
    Array.from({ length: 30 }, (_, i) => i),
  );
  for (const c of properties.cases)
    expect(parsePlanDraft(c.structuredDraft).seed).toBe(c.seed);
  expect(properties.negativeCases.map((c: any) => c.id)).toEqual([
    "self-intersection",
    "fully-flooded",
    "steep-footprint",
    "21-instances",
  ]);
  for (const c of properties.negativeCases.filter(
    (c: any) => c.expectedGate === "contract",
  ))
    expect(() => parsePlanDraft(c.structuredDraft)).toThrow();
});

test("canonical patch results enforce final world elevation using the fixed transform once", () => {
  const s = snapshotFixture();
  // A fixed raised patch is a valid manifest, but cannot masquerade as an in-range final field.
  const m: any = manifestFixture("patch");
  m.patch.displayTransform.position = [0, 3, 0];
  s.assets.push({
    assetRef: { id: m.id, contentVersion: m.contentVersion },
    digest: "b".repeat(64),
    manifest: m,
  });
  s.plan.terrain = {
    source: "patch",
    assetRef: { id: m.id, contentVersion: m.contentVersion },
    transform: m.patch.displayTransform,
  };
  s.plan.surfaceStyleRef = null;
  s.surfaceStyle = null;
  s.surfaces = [];
  s.terrain.space = "canonical";
  s.terrain.transform = m.patch.displayTransform;
  s.terrain.proxyError = 0.01;
  s.validation.usage.worstSplats = 2000;
  expect(() => parseSnapshot(s)).toThrow(/elevation|height|range/i);
  m.patch.displayTransform.position = [0, 1, 0];
  s.plan.terrain.transform = m.patch.displayTransform;
  s.terrain.transform = m.patch.displayTransform;
  expect(parseSnapshot(s).terrain?.transform?.position[1]).toBe(1);
});

test("row-major node ownership follows +X columns and +Z rows on nonsymmetric data", () => {
  const s = snapshotFixture(),
    all = Array.from({ length: 1681 }, (_, i) => i);
  for (const i of all)
    s.terrain.heights[i] = Math.floor(i / 41) * 0.01 + (i % 41) * 0.001;
  s.terrain.tiles = [
    {
      id: "west",
      bounds: { min: [-2, -2], max: [0, 2] },
      nodeIndices: Uint32Array.from(all.filter((i) => i % 41 <= 20)),
      outputIndices: Uint32Array.from(all.filter((i) => i % 41 < 20)),
      digest: "a".repeat(64),
    },
    {
      id: "east",
      bounds: { min: [0, -2], max: [2, 2] },
      nodeIndices: Uint32Array.from(all.filter((i) => i % 41 >= 20)),
      outputIndices: Uint32Array.from(all.filter((i) => i % 41 >= 20)),
      digest: "b".repeat(64),
    },
  ];
  s.surfaces[0].tiles[0].tileId = "west";
  expect(parseSnapshot(s).terrain?.heights[41]).toBeCloseTo(0.01);
  expect(parseSnapshot(s).terrain?.heights[1]).toBeCloseTo(0.001);
  const copy = structuredClone(s);
  [copy.terrain.tiles[0].nodeIndices, copy.terrain.tiles[1].nodeIndices] = [
    copy.terrain.tiles[1].nodeIndices,
    copy.terrain.tiles[0].nodeIndices,
  ];
  expect(() => parseSnapshot(copy)).toThrow(/outside bounds/);
});

describe("T4 review: hidden runtime buffer metadata and source accounting", () => {
  test("rejects spoofed dimensions using intrinsic lengths", () => {
    const s = snapshotFixture();
    s.terrain.heights = new Float32Array([0]);
    Object.defineProperty(s.terrain.heights, "length", { value: 1681 });
    expect(() => parseSnapshot(s)).toThrow(/length/);
  });
  test.each([
    "length",
    "buffer",
    "byteLength",
    "byteOffset",
    "hiddenBytes",
    "hiddenAccessor",
  ])("discards non-enumerable own %s without evaluating accessors", (key) => {
    const s = snapshotFixture(),
      original = s.terrain.heights,
      backing = original.buffer;
    let reads = 0;
    Object.defineProperty(
      original,
      key,
      key === "hiddenBytes"
        ? {
            value: new Uint8Array(129 * 1024 * 1024),
          }
        : {
            get() {
              reads++;
              throw Error("untrusted getter executed");
            },
          },
    );
    const result = parseSnapshot(s).terrain!.heights;
    expect(result).not.toBe(original);
    expect(result.buffer).toBe(backing);
    expect(result.length).toBe(1681);
    expect(Object.hasOwn(result, key)).toBe(false);
    expect(reads).toBe(0);
    result[0] = 0.5;
    expect(original[0]).toBe(0.5);
  });
  test("returns fresh borrowed views in every runtime role including legacy bytes", () => {
    const s = snapshotFixture();
    s.plan.water = waterFixture();
    s.water = {
      mode: "river",
      waterId: "water",
      level: -0.025,
      nx: 41,
      nz: 41,
      mask: new Uint8Array(1681),
      bankMask: new Uint8Array(1681),
      signedDistance: new Float32Array(1681),
      digest: "a".repeat(64),
    };
    s.surfaces.push({
      ...structuredClone(s.surfaces[0]),
      role: "water",
      waterId: "water",
    });
    s.validation.usage.worstSplats++;
    s.validation.actualSourceBytes += 56;
    s.capability = "legacy-readonly";
    s.intent = s.plan = s.state = null;
    s.originVersion = "f0-zip-v3";
    s.original = { digest: "a".repeat(64), bytes: new Uint8Array([1, 2, 3]) };
    const leaves = (value: any) => [
      value.terrain.heights,
      value.terrain.normals,
      value.terrain.tiles[0].nodeIndices,
      value.terrain.tiles[0].outputIndices,
      value.water.mask,
      value.water.bankMask,
      value.water.signedDistance,
      ...value.surfaces.flatMap((surface: any) => [
        surface.data,
        surface.tiles[0].outputIndices,
      ]),
      value.original.bytes,
    ];
    const inputs = leaves(s),
      backings = inputs.map((v) => v.buffer);
    let reads = 0;
    for (const input of inputs) {
      Object.defineProperty(input, Symbol.iterator, {
        get() {
          reads++;
          throw Error("iterator getter");
        },
      });
      Object.defineProperty(input, "some", {
        get() {
          reads++;
          throw Error("method getter");
        },
      });
      Object.defineProperty(input, "hidden", {
        value: { original: input, bytes: new Uint8Array(8) },
      });
    }
    const outputs = leaves(parseSnapshot(s));
    expect(outputs).toHaveLength(12);
    outputs.forEach((output, i) => {
      expect(output === inputs[i]).toBe(false);
      expect(output.buffer).toBe(backings[i]);
      expect(Object.hasOwn(output, "hidden")).toBe(false);
      expect(Object.hasOwn(output, Symbol.iterator)).toBe(false);
      expect(Object.hasOwn(output, "some")).toBe(false);
    });
    expect(reads).toBe(0);
  });
  test("accepts 250k surface points without enumerating typed-array index keys", () => {
    const s = snapshotFixture(),
      count = 250000,
      sample = s.surfaces[0].data;
    s.plan.groups = [];
    s.plan.relations = [];
    s.state.groups = [];
    s.instances = [];
    s.assets = [];
    s.validation.requested = s.validation.accepted = s.validation.shortfall = 0;
    s.validation.rejections = [];
    s.validation.usage.instances = 0;
    s.validation.usage.worstSplats = count;
    s.validation.usage.candidateCpuBytes = 16000000;
    s.validation.usage.transitionBytes = 32000000;
    const data = new Float32Array(count * 14);
    for (let i = 0; i < count; i++) data.set(sample, i * 14);
    s.surfaces[0].data = data;
    s.surfaces[0].count = count;
    s.surfaces[0].tiles[0].outputIndices = Uint32Array.from(
      { length: count },
      (_, i) => i,
    );
    s.validation.actualSourceBytes = data.byteLength;
    const ownKeys = Reflect.ownKeys;
    const guard = vi.spyOn(Reflect, "ownKeys").mockImplementation((value) => {
      if (ArrayBuffer.isView(value))
        throw Error("unbounded numeric key allocation");
      return ownKeys(value);
    });
    try {
      const result = parseSnapshot(s);
      expect(result.surfaces[0].data.length).toBe(3500000);
      expect(result.surfaces[0].data.buffer).toBe(data.buffer);
    } finally {
      guard.mockRestore();
    }
  });
  test("rejects a typed array with a plain-object prototype before key enumeration", () => {
    const s = snapshotFixture();
    Object.setPrototypeOf(s.terrain.heights, Object.prototype);
    const ownKeys = Reflect.ownKeys;
    const guard = vi.spyOn(Reflect, "ownKeys").mockImplementation((value) => {
      if (ArrayBuffer.isView(value))
        throw Error("numeric keys must not be enumerated");
      return ownKeys(value);
    });
    try {
      expect(() => parseSnapshot(s)).toThrow(/buffer prototype/);
    } finally {
      guard.mockRestore();
    }
  });
  test("does not retain hidden memory attached to the backing buffer", () => {
    const s = snapshotFixture();
    Object.defineProperty(s.terrain.heights.buffer, "hiddenBytes", {
      value: new Uint8Array(8),
    });
    expect(() => parseSnapshot(s)).toThrow();
  });
  test.each([0, 1024, 128 * 1024 * 1024])(
    "preserves actual source byte measurement %i",
    (bytes) => {
      const s = snapshotFixture();
      s.validation.actualSourceBytes = bytes;
      s.validation.usage.candidateCpuBytes = 128 * 1024 * 1024;
      s.validation.usage.transitionBytes = 128 * 1024 * 1024;
      expect(parseSnapshot(s).validation).toMatchObject({
        actualSourceBytes: bytes,
      });
    },
  );
  test.each([
    -1,
    0.5,
    128 * 1024 * 1024 + 1,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    "1024",
  ])("rejects invalid actual source byte measurement %s", (bytes) => {
    const s = snapshotFixture();
    s.validation.actualSourceBytes = bytes;
    expect(() => parseSnapshot(s)).toThrow();
  });
  test("source bytes are required and distinct from reported candidate residency", () => {
    const s = snapshotFixture();
    delete s.validation.actualSourceBytes;
    expect(() => parseSnapshot(s)).toThrow();
    s.validation.actualSourceBytes = 56056;
    expect(parseSnapshot(s).validation).toMatchObject({
      actualSourceBytes: 56056,
      usage: { candidateCpuBytes: 1000000, transitionBytes: 2000000 },
    });
  });
  test("source bytes include generated Gaussian arrays and count shared sources once", () => {
    const s = snapshotFixture(),
      generatedBytes = s.surfaces[0].data.byteLength;
    // Constructed decoded float14 source: 1,000 points, 14 f32 components each.
    const decodedObjectBytes = 1000 * 14 * Float32Array.BYTES_PER_ELEMENT;
    expect(s.validation.actualSourceBytes).toBe(
      decodedObjectBytes + generatedBytes,
    );
    s.instances.push({ ...s.instances[0], instanceId: "grass:1" });
    s.state.groups[0].nextSlot = 2;
    s.validation.accepted = 2;
    s.validation.shortfall = 0;
    s.validation.rejections = [];
    s.validation.usage.instances = 2;
    s.validation.usage.worstSplats = 2001;
    expect(parseSnapshot(s).validation.actualSourceBytes).toBe(56056);
    expect(s.assets[0].manifest.files[0].bytes).toBe(1024);
  });
});

test("P05 paraphrase preserves four grass and four reed clumps total across both banks", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(
    await readFile("tests/fixtures/general-scene-requests.json", "utf8"),
  );
  const p = fixture.cases.find((c: any) => c.id === "P05");
  expect(p.original).toBe(
    "南北曲折河流，宽0.8、深0.15，两岸低草和芦苇各4、2组石头；10×8",
  );
  expect(p.paraphrase).toBe(
    "10×8的场地上安排南北走向的曲折河道，宽0.8、深0.15；河流两岸总共安排低草4丛、芦苇4丛和石头2组。",
  );
  expect(
    Object.fromEntries(
      p.structuredDraft.groups.map((g: any) => [g.groupId, g.count]),
    ),
  ).toEqual({ grass: 4, reed: 4, rock: 2 });
  expect(fixture.fixtureVersion).toBe(2);
});

test.each(["x".repeat(201), "bad\u0000identity", "", "\ud800"])(
  "failed protocol model text remains observable while success IDs stay strict (%j)",
  (model) => {
    const e = { ...evidenceFixture(), model, raw: "actual reply\u0000" };
    expect(parseModelEvidence(e)).toEqual(e);
    expect(() => parseModelEvidence({ ...e, failureReason: null })).toThrow();
    expect(() => parseModelEvidence({ ...e, requestedModel: model })).toThrow();
    expect(() => parseModelEvidence({ ...e, promptVersion: model })).toThrow();
  },
);

test("failed observed model text has an explicit UTF16 bound", () => {
  const e = {
    ...evidenceFixture(),
    model: "😀".repeat(32768),
    raw: "actual reply",
  };
  expect(parseModelEvidence(e).model).toBe(e.model);
  expect(() => parseModelEvidence({ ...e, model: e.model + "x" })).toThrow();
});

function analyticSnapshot() {
  const s = snapshotFixture();
  s.plan.water = waterFixture();
  s.terrain.heightModel = {
    kind: "water-profile",
    version: 1,
    baseHeights: new Float32Array(1681),
    water: structuredClone(s.plan.water),
  };
  s.water = {
    mode: "river",
    waterId: s.plan.water.waterId,
    level: s.plan.water.level,
    nx: 41,
    nz: 41,
    mask: new Uint8Array(1681),
    bankMask: new Uint8Array(1681),
    signedDistance: new Float32Array(1681),
    digest: "a".repeat(64),
  };
  s.surfaces.push({
    ...structuredClone(s.surfaces[0]),
    role: "water",
    waterId: s.plan.water.waterId,
  });
  s.validation.usage.worstSplats++;
  s.validation.actualSourceBytes += 56;
  return s;
}
test("normalizes absent legacy bilinear representation and restores explicit analytic base bytes", () => {
  expect((parseSnapshot(snapshotFixture()).terrain as any).heightModel).toEqual(
    { kind: "bilinear" },
  );
  const s = analyticSnapshot();
  s.terrain.heightModel.baseHeights[17] = 0.123;
  const p = parseSnapshot(structuredClone(s));
  expect((p.terrain as any).heightModel.baseHeights[17]).toBe(
    Math.fround(0.123),
  );
  expect(p.schemaVersion).toBe(1);
});
test.each(["version", "base", "binding", "patch", "budget"])(
  "analytic source rejects %s inconsistency",
  (kind) => {
    const s = analyticSnapshot();
    if (kind === "version") s.terrain.heightModel.version = 2;
    if (kind === "base")
      s.terrain.heightModel.baseHeights = new Float32Array(1680);
    if (kind === "binding") s.terrain.heightModel.water.width += 0.1;
    if (kind === "patch") {
      s.terrain.space = "canonical";
      s.terrain.transform = {
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: 1,
      };
    }
    if (kind === "budget") {
      const backing = new ArrayBuffer(128 * 1024 * 1024);
      s.terrain.heightModel.baseHeights = new Float32Array(backing, 0, 1681);
    }
    expect(() => parseSnapshot(s)).toThrow();
  },
);

test("restored analytic snapshot supports pure world queries from original base data", async () => {
  const { sampleTerrainWorld } = await import("./terrain.ts");
  const snapshot = parseSnapshot(structuredClone(analyticSnapshot()));
  if (snapshot.capability !== "editable" || !snapshot.terrain)
    throw Error("Expected editable terrain");
  const field = {
    ...snapshot.terrain,
    domain: snapshot.plan.domain,
    patchSupport: null,
  };
  const q = sampleTerrainWorld(field, 0, 0);
  expect(q.ok).toBe(true);
  if (q.ok) {
    expect(q.value.height).toBe(-0.125);
    expect(q.value.worldError).toBeGreaterThan(0);
  }
});

test("legacy readonly snapshots cannot hide an unbound analytic water source", () => {
  const s = analyticSnapshot();
  s.capability = "legacy-readonly";
  s.intent = s.plan = s.state = null;
  s.originVersion = "f0-zip-v3";
  s.original = { digest: "a".repeat(64), bytes: new Uint8Array([1, 2, 3]) };
  expect(() => parseSnapshot(s)).toThrow(/analytic/i);
});
