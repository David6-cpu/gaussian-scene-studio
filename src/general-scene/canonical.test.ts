import { expect, test } from "vitest";
import {
  canonicalJson,
  quantizeGeometry,
  cpuBufferBytes,
  cpuBufferDigest,
  geometryKey,
  encodeAssetDigestBinding,
  documentDigest,
} from "./canonical";
import { parseScenePlan, parseEditableState } from "./contracts";
import {
  snapshotFixture,
  planFixture,
  stateFixture,
  brushFixture,
} from "./test-fixtures";
const bindings = () => [
  encodeAssetDigestBinding(
    { id: "constructed-object", contentVersion: "constructed-v1" },
    "a".repeat(64),
  ),
  encodeAssetDigestBinding(
    { id: "constructed-style", contentVersion: "constructed-v1" },
    "b".repeat(64),
  ),
];
test("canonical preserves explicit numbers/text and semantic array order", () => {
  expect(
    canonicalJson({ z: -0, a: [2, 1, 0.123456789], raw: "  原句\n" }),
  ).toBe(
    '{"a":[2,1,0.123456789],"raw":"  原句\n","z":0}'.replace(
      "原句\n",
      "原句\\n",
    ),
  );
  expect(() => canonicalJson({ a: NaN })).toThrow();
  expect(() => canonicalJson([undefined])).toThrow();
  expect(() => canonicalJson(new Array(1))).toThrow();
});
test("only geometry samples quantize to a micro-unit and normalize negative zero", () => {
  expect(quantizeGeometry(0.123456789)).toBe(0.123457);
  expect(Object.is(quantizeGeometry(-0.0000001), -0)).toBe(false);
  expect(() => quantizeGeometry(Infinity)).toThrow();
});
test("CPU buffers encode f32/u32 explicitly little endian with fixed digest", async () => {
  expect([...cpuBufferBytes(new Float32Array([1, -0, -2.5]))]).toEqual([
    0, 0, 128, 63, 0, 0, 0, 0, 0, 0, 32, 192,
  ]);
  expect([...cpuBufferBytes(new Uint32Array([0x12345678]))]).toEqual([
    120, 86, 52, 18,
  ]);
  expect(await cpuBufferDigest(new Uint8Array([97, 98, 99]))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(() => cpuBufferBytes(new Float32Array([NaN]))).toThrow();
});
test("geometry identity ignores key order and transaction/review/camera bookkeeping", async () => {
  const p = planFixture(),
    s = stateFixture(),
    a = await geometryKey(parseScenePlan(p), parseEditableState(s), bindings());
  const reordered = Object.fromEntries(Object.entries(p).reverse());
  reordered.planId = "other";
  reordered.intentDigest = "c".repeat(64);
  s.deduplications = [
    {
      sceneId: "scene",
      baseRevisionId: "base",
      patchId: "patch",
      operationId: "operation",
      resultRevisionId: "revision",
    },
  ];
  expect(
    await geometryKey(
      parseScenePlan(reordered),
      parseEditableState(s),
      bindings().reverse(),
    ),
  ).toBe(a);
  expect(await documentDigest({ plan: p, camera: [0, 0, 0] })).not.toBe(
    await documentDigest({ plan: p, camera: [1, 0, 0] }),
  );
});
test("cumulative brushes, identity-affecting state, explicit values and bound digests affect geometry", async () => {
  const p = parseScenePlan(planFixture()),
    s = stateFixture(),
    b = bindings(),
    a = await geometryKey(p, parseEditableState(s), b);
  for (const mutate of [
    (v: any) => v.brushes.push(brushFixture()),
    (v: any) => v.groups[0].nextSlot++,
    (v: any) => v.tombstones.push("grass:0"),
    (v: any) => v.lockedInstanceIds.push("grass:0"),
  ]) {
    const next = stateFixture();
    mutate(next);
    expect(await geometryKey(p, parseEditableState(next), b)).not.toBe(a);
  }
  const next = stateFixture();
  next.brushes = [brushFixture(1), { ...brushFixture(2), delta: -0.1 }];
  const first = await geometryKey(p, parseEditableState(next), b);
  next.brushes[0].delta = 0.2;
  expect(await geometryKey(p, parseEditableState(next), b)).not.toBe(first);
  const swapped = [
    encodeAssetDigestBinding(p.groups[0].assetRef, "b".repeat(64)),
    encodeAssetDigestBinding(p.surfaceStyleRef!, "a".repeat(64)),
  ];
  expect(await geometryKey(p, parseEditableState(s), swapped)).not.toBe(a);
});
test("asset digest records cannot omit refs, duplicate bindings, or use bare hashes", async () => {
  const p = parseScenePlan(planFixture()),
    s = parseEditableState(stateFixture());
  await expect(geometryKey(p, s, ["a".repeat(64)])).rejects.toThrow();
  await expect(
    geometryKey(p, s, [...bindings(), bindings()[0]]),
  ).rejects.toThrow();
  await expect(geometryKey(p, s, [bindings()[0]])).rejects.toThrow();
});

test("allocator, tombstone and lock set insertion order does not affect identity", async () => {
  const s = stateFixture();
  s.groups.push({ groupId: "rock", nextSlot: 2, retired: false });
  s.tombstones = ["grass:0", "rock:1"];
  const p = parseScenePlan(planFixture()),
    a = await geometryKey(p, parseEditableState(s), bindings());
  s.groups.reverse();
  s.tombstones.reverse();
  expect(await geometryKey(p, parseEditableState(s), bindings())).toBe(a);
});
test("full document integrity covers runtime buffers, camera, evidence and dedupe", async () => {
  const s = {
    data: new Float32Array([1, 2]),
    camera: [0, 0, 0],
    evidence: { raw: "actual raw" },
    deduplications: [] as string[],
  };
  const a = await documentDigest(s);
  s.data[0] = 2;
  expect(await documentDigest(s)).not.toBe(a);
  s.data[0] = 1;
  s.evidence.raw = "different";
  expect(await documentDigest(s)).not.toBe(a);
  s.evidence.raw = "actual raw";
  s.deduplications.push("op");
  expect(await documentDigest(s)).not.toBe(a);
});

test("camera changes only document integrity; instance overrides change geometry", async () => {
  const s = snapshotFixture(),
    plan = parseScenePlan(s.plan),
    state = parseEditableState(s.state),
    b = bindings();
  const geometry = await geometryKey(plan, state, b),
    integrity = await documentDigest(s);
  s.camera.position = [8, 3, 4];
  expect(
    await geometryKey(parseScenePlan(s.plan), parseEditableState(s.state), b),
  ).toBe(geometry);
  expect(await documentDigest(s)).not.toBe(integrity);
  s.state.overrides = [
    {
      kind: "move",
      instanceId: "grass:0",
      groupId: "grass",
      assetRef: s.instances[0].assetRef,
      transform: { ...s.instances[0].transform, position: [1, 0, 0] },
    },
  ];
  expect(await geometryKey(plan, parseEditableState(s.state), b)).not.toBe(
    geometry,
  );
});

test("full document hashing accepts nested atomic values at the snapshot depth boundary", async () => {
  const { parseSnapshot } = await import("./contracts.ts");
  for (const count of [20, 27]) {
    const s = snapshotFixture();
    let value: any = 0;
    for (let i = 0; i < count; i++) value = { x: value };
    s.intent.features[0].quantity.value = value;
    const parsed = parseSnapshot(s);
    expect(await documentDigest(parsed)).toMatch(/^[0-9a-f]{64}$/);
    expect(await documentDigest(structuredClone(parsed))).toBe(
      await documentDigest(parsed),
    );
  }
});
test("hashing preserves its explicit input depth bound and existing shallow digests", async () => {
  let value: any = 0;
  for (let i = 0; i < 65; i++) value = { x: value };
  await expect(documentDigest(value)).rejects.toThrow(/nesting/);
  expect(await documentDigest({ z: [3, true, null], a: { b: 1 } })).toBe(
    "5421c4f7e71c2df33ecda5bbfa9fe3f0f18ca6fcab5cdb9a8585b53e8dd8b91b",
  );
});

test("binary hashing ignores discarded wrapper properties and uses intrinsic byte dimensions", async () => {
  const clean = new Float32Array([1, -0, -2.5]),
    input = new Float32Array(clean);
  let reads = 0;
  for (const key of [
    "length",
    "byteLength",
    "byteOffset",
    "buffer",
    Symbol.iterator,
  ])
    Object.defineProperty(input, key, {
      get() {
        reads++;
        throw Error("untrusted getter");
      },
    });
  Object.defineProperty(input, "hidden", {
    value: { bytes: new Uint8Array(8) },
  });
  expect(cpuBufferBytes(input)).toEqual(cpuBufferBytes(clean));
  expect(await documentDigest({ data: input })).toBe(
    await documentDigest({ data: clean }),
  );
  expect(reads).toBe(0);
});

test("binary document hashing rejects altered typed-array prototypes", async () => {
  const input = new Float32Array([1]);
  Object.setPrototypeOf(input, Object.prototype);
  await expect(documentDigest({ data: input })).rejects.toThrow(
    /buffer prototype/,
  );
});

test("affected-region memberships are sets while outer region order and polygon order remain semantic", async () => {
  const p = parseScenePlan(planFixture()),
    state = stateFixture();
  state.groups[0].nextSlot = 2;
  state.affectedRegions = [
    {
      requestedRegion: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      effectiveRegion: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      tileIds: ["b", "a"],
      instanceIds: ["grass:1", "grass:0"],
    },
  ];
  const a = parseEditableState(state),
    b = parseEditableState({
      ...state,
      affectedRegions: state.affectedRegions.map((r: any) => ({
        ...r,
        tileIds: [...r.tileIds].reverse(),
        instanceIds: [...r.instanceIds].reverse(),
      })),
    });
  expect(await geometryKey(p, a, bindings())).toBe(
    await geometryKey(p, b, bindings()),
  );
  expect(await documentDigest(a)).not.toBe(await documentDigest(b));
  expect(a.affectedRegions[0].tileIds).toEqual(["b", "a"]);
});
