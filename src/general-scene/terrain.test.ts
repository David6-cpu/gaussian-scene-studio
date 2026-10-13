import { afterAll, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildTerrain,
  sampleTerrainWorld,
  terrainNodeWorld,
  terrainNodeWorldArea,
  terrainNormals,
  type TerrainField,
} from "./terrain.ts";
import { parsePlanDraft, parseEditableState } from "./contracts.ts";
import { documentDigest } from "./canonical.ts";
import {
  brushFixture,
  stateFixture,
  terrainPlanFixture,
  terrainProxyFixture,
} from "./test-fixtures.ts";
import type { PatchProxy } from "./asset-loader.ts";
import type { Result } from "./core.ts";

function value<T>(result: Result<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error(JSON.stringify(result.issues));
  return result.value;
}
function build(
  plan = terrainPlanFixture(),
  state = stateFixture(),
  proxy: PatchProxy | null = null,
) {
  return value(buildTerrain(plan, state, proxy));
}
function patchPlan(proxy: PatchProxy, width = 10, depth = 10) {
  const plan = terrainPlanFixture({ width, depth });
  plan.terrain = {
    source: "patch",
    assetRef: { id: "constructed-patch", contentVersion: "constructed-v1" },
    transform: proxy.transform,
  };
  plan.surfaceStyleRef = null;
  return plan;
}
function at(f: TerrainField, ix: number, iz: number) {
  return f.heights[iz * f.nx + ix];
}
function outputs(f: TerrainField) {
  return f.tiles.flatMap((t) => [...t.outputIndices]);
}

// Break: a residual basin/noise changes even the flat/default field.
test("flat terrain is exactly zero with up normals at every boundary", () => {
  const f = build();
  expect(f).toMatchObject({
    space: "world",
    transform: null,
    width: 4,
    depth: 4,
    spacing: 0.1,
    nx: 41,
    nz: 41,
    layout: "row-major-zx",
    proxyError: 0,
    patchSupport: null,
  });
  expect(f.heights.every((h) => h === 0 && !Object.is(h, -0))).toBe(true);
  for (let i = 0; i < f.heights.length; i++)
    expect([...f.normals.subarray(3 * i, 3 * i + 3)]).toEqual([0, 1, 0]);
});
test.each([
  [0, 0, 40, 0.174977],
  [90, 40, 0, 0.174977],
  [180, 0, 40, -0.174977],
  [270, 40, 0, -0.174977],
])(
  "azimuth %s maps five-degree uphill direction without a central basin",
  (azimuth, ix, iz, expected) => {
    const f = build(
      terrainPlanFixture({
        terrain: { slopeDegrees: 5, slopeAzimuthDegrees: azimuth },
      }),
    );
    expect(at(f, ix, iz)).toBeCloseTo(expected, 6);
    expect(at(f, 20, 20)).toBe(0);
    const mid = value(sampleTerrainWorld(f, 0, 0));
    expect(mid.normal[1]).toBeCloseTo(0.9961947, 5);
  },
);
test("7.5 by 5.5 samples the exact centered extents without truncation", () => {
  const f = build(terrainPlanFixture({ width: 7.5, depth: 5.5 }));
  expect([f.nx, f.nz, f.heights.length]).toEqual([76, 56, 4256]);
  expect(terrainNodeWorld(f, 0)).toEqual([-3.75, 0, -2.75]);
  expect(terrainNodeWorld(f, 4255)).toEqual([3.75, 0, 2.75]);
  expect(f.tiles).toHaveLength(48);
  expect(value(sampleTerrainWorld(f, 3.75, 2.75)).height).toBe(0);
});
test("same seed is byte-stable, another seed changes noise, and noise is world anchored", async () => {
  const p = terrainPlanFixture({
    terrain: { noiseAmplitude: 0.2, noiseOctaves: 3, noiseScale: 1.5 },
  });
  const f = build(p),
    again = build(p),
    wider = build(
      terrainPlanFixture({ width: 6, depth: 6, terrain: p.terrain }),
    );
  expect(await documentDigest(f)).toBe(await documentDigest(again));
  expect(f.heights).not.toEqual(build({ ...p, seed: 43 }).heights);
  expect(Math.max(...f.heights)).toBeLessThanOrEqual(0.200001);
  expect(Math.min(...f.heights)).toBeGreaterThanOrEqual(-0.200001);
  for (let iz = 0; iz < 41; iz++)
    for (let ix = 0; ix < 41; ix++)
      expect(at(f, ix, iz)).toBe(at(wider, ix + 10, iz + 10));
});
test("brushes accumulate locally and never renormalize or mutate the parent field", async () => {
  const p = terrainPlanFixture({
    width: 6,
    depth: 6,
    terrain: { slopeDegrees: 3, noiseAmplitude: 0.2, noiseOctaves: 3 },
  });
  const state = parseEditableState(stateFixture()),
    beforeState = await documentDigest(state),
    beforePlan = await documentDigest(p);
  const parent = build(p, state),
    parentDigest = await documentDigest(parent);
  const edited = build(p, {
    ...state,
    brushes: [
      { ...brushFixture(1), delta: 0.2 },
      { ...brushFixture(2), delta: -0.05 },
    ],
  });
  expect(at(edited, 30, 30) - at(parent, 30, 30)).toBeCloseTo(0.15, 6);
  for (let iz = 0; iz < 61; iz++)
    for (let ix = 0; ix < 61; ix++) {
      const x = -3 + ix * 0.1,
        z = -3 + iz * 0.1;
      if (Math.hypot(x, z) >= 0.5)
        expect(at(edited, ix, iz)).toBe(at(parent, ix, iz));
      if (Math.hypot(x, z) > 0.7)
        expect([
          ...edited.normals.subarray(
            3 * (iz * 61 + ix),
            3 * (iz * 61 + ix) + 3,
          ),
        ]).toEqual([
          ...parent.normals.subarray(
            3 * (iz * 61 + ix),
            3 * (iz * 61 + ix) + 3,
          ),
        ]);
    }
  expect(await documentDigest(parent)).toBe(parentDigest);
  expect(await documentDigest(state)).toBe(beforeState);
  expect(await documentDigest(p)).toBe(beforePlan);
});
test.each([0.1, 0.2])(
  "tiles share global edge/normal nodes and output every point once at spacing %s",
  (spacing) => {
    const f = build(
      terrainPlanFixture({
        width: 10,
        depth: 10,
        terrain: { spacing, noiseAmplitude: 0.2, noiseOctaves: 3 },
      }),
    );
    const owned = outputs(f);
    expect(new Set(owned).size).toBe(owned.length);
    expect(owned.length).toBe(f.nx * f.nz);
    expect([...owned].sort((a, b) => a - b)).toEqual(
      Array.from({ length: f.nx * f.nz }, (_, i) => i),
    );
    expect(f.tiles).toHaveLength(100);
    const left = f.tiles.find((t) => t.id === "tile:0:0")!,
      right = f.tiles.find((t) => t.id === "tile:1:0")!;
    const shared = [...left.nodeIndices].filter((i) =>
      right.nodeIndices.includes(i),
    );
    expect(shared).toHaveLength(1 / spacing + 1);
    for (const tile of f.tiles) {
      expect(tile.bounds.max[0] - tile.bounds.min[0]).toBeLessThanOrEqual(1);
      expect(tile.bounds.max[1] - tile.bounds.min[1]).toBeLessThanOrEqual(1);
      for (const i of tile.outputIndices)
        expect(tile.nodeIndices.includes(i)).toBe(true);
    }
    expect(f.normals).toEqual(terrainNormals(f));
  },
);
test.each([
  { width: 10.5 },
  { terrain: { spacing: 0.05 } },
  { width: 7.5, terrain: { spacing: 0.2 } },
  { terrain: { slopeDegrees: 13 } },
  { terrain: { noiseAmplitude: 0.41 } },
  { terrain: { noiseOctaves: 5 } },
  { terrain: { elevation: NaN } },
  { terrain: { elevation: 1.99, slopeDegrees: 12 } },
])(
  "invalid dimensions/parameters or out-of-range final heights reject without clamping %j",
  (change) => {
    const result = buildTerrain(
      terrainPlanFixture(change),
      stateFixture(),
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  },
);
test("accumulated brushes outside height bounds reject without modifying the plan/state", () => {
  const p = terrainPlanFixture({ terrain: { elevation: 1.9 } }),
    s = stateFixture();
  s.brushes = [brushFixture(1), brushFixture(2)];
  const before = JSON.stringify([p, s]);
  expect(buildTerrain(p, s, null).ok).toBe(false);
  expect(JSON.stringify([p, s])).toBe(before);
});
test("brushes may not silently clip at the scene boundary", () => {
  const s = stateFixture();
  s.brushes = [
    {
      ...brushFixture(),
      center: [1.9, 0],
      requestedRegion: [
        [1, -1],
        [3, -1],
        [3, 1],
        [1, 1],
      ],
      effectiveRegion: [
        [1, -1],
        [3, -1],
        [3, 1],
        [1, 1],
      ],
    },
  ];
  expect(buildTerrain(terrainPlanFixture(), s, null).ok).toBe(false);
});
test("procedural builds reject extraneous proxies and malformed state", () => {
  expect(
    buildTerrain(terrainPlanFixture(), stateFixture(), terrainProxyFixture())
      .ok,
  ).toBe(false);
  expect(
    buildTerrain(
      terrainPlanFixture(),
      { ...stateFixture(), brushes: [brushFixture(2), brushFixture(1)] },
      null,
    ).ok,
  ).toBe(false);
});
test("bilinear proxy queries use +X columns/+Z rows including exact edges", () => {
  const proxy = terrainProxyFixture(),
    f = build(patchPlan(proxy), stateFixture(), proxy);
  expect(f).toMatchObject({
    space: "canonical",
    width: 4,
    depth: 4,
    nx: 41,
    nz: 41,
    proxyError: 0.01,
  });
  expect(value(sampleTerrainWorld(f, 0.15, 0.25)).height).toBeCloseTo(0.065, 7);
  expect(value(sampleTerrainWorld(f, 2, 2)).height).toBeCloseTo(0.6, 7);
  expect(value(sampleTerrainWorld(f, -2, 2)).height).toBeCloseTo(0.2, 7);
  expect(sampleTerrainWorld(f, 2.0001, 0).ok).toBe(false);
  expect(f.heights).not.toBe(proxy.heights);
  expect(f.heights).toEqual(proxy.heights);
});
test("fixed translated/yawed/scaled D is applied once with separate canonical/world error", () => {
  const proxy = terrainProxyFixture();
  proxy.transform = {
    position: [1, 0.3, -1],
    quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    scale: 2,
  };
  const f = build(patchPlan(proxy), stateFixture(), proxy);
  const q = value(sampleTerrainWorld(f, 1.5, -1.3)); // canonical x=.15,z=.25 -> h=.065
  expect(q.height).toBeCloseTo(0.43, 6);
  expect(q.worldError).toBe(0.02);
  expect(f.proxyError).toBe(0.01);
  expect(q.normal[0]).toBeCloseTo(-0.19518, 5);
  expect(q.normal[1]).toBeCloseTo(0.9759, 5);
  expect(q.normal[2]).toBeCloseTo(0.09759, 5);
  const center = terrainNodeWorld(f, 840);
  expect(center).toEqual([1, 0.3, -1]);
  expect(terrainNodeWorldArea(f, 840)).toBeCloseTo(0.04, 10);
  expect(terrainNodeWorldArea(f, 0)).toBeCloseTo(0.01, 10);
});
test("node area uses half edges/quarter corners and world scale", () => {
  const f = build(terrainPlanFixture({ width: 7.5, depth: 5.5 }));
  expect(terrainNodeWorldArea(f, 0)).toBeCloseTo(0.0025, 12);
  expect(terrainNodeWorldArea(f, 1)).toBeCloseTo(0.005, 12);
  expect(terrainNodeWorldArea(f, 77)).toBeCloseTo(0.01, 12);
  const sum = Array.from(f.heights, (_, i) =>
    terrainNodeWorldArea(f, i),
  ).reduce((a, b) => a + b, 0);
  expect(sum).toBeCloseTo(41.25, 8);
});
test("patch valid polygon, void boundaries and scene domain gate support in world coordinates", () => {
  const proxy = terrainProxyFixture();
  proxy.transform = {
    position: [0.5, 0, 0],
    quaternion: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)],
    scale: 1,
  };
  proxy.validPolygon = [
    [-1.5, -1.5],
    [1.5, -1.5],
    [1.5, 1.5],
    [-1.5, 1.5],
  ];
  proxy.voidMask = [
    [
      [-0.2, -0.2],
      [0.2, -0.2],
      [0.2, 0.2],
      [-0.2, 0.2],
    ],
  ];
  const f = build(patchPlan(proxy, 4, 4), stateFixture(), proxy);
  expect(f.patchSupport).toEqual({
    validPolygon: proxy.validPolygon,
    voidMask: proxy.voidMask,
  });
  expect(
    value(sampleTerrainWorld(f, 0.5 + Math.SQRT1_2, -Math.SQRT1_2)).height,
  ).toBeCloseTo(0.1, 6);
  expect(sampleTerrainWorld(f, 0.5, 0).ok).toBe(false);
  expect(
    sampleTerrainWorld(f, 0.5 + 0.2 * Math.SQRT1_2, -0.2 * Math.SQRT1_2).ok,
  ).toBe(false);
  expect(sampleTerrainWorld(f, -1.8, 0).ok).toBe(false);
  expect(sampleTerrainWorld(f, 2.1, 0).ok).toBe(false);
});
test("patch inputs and support metadata remain independent and unmodified", async () => {
  const proxy = terrainProxyFixture();
  const mutablePolygon: [number, number][] = [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
  ];
  proxy.validPolygon = mutablePolygon;
  const before = await documentDigest(proxy);
  const f = build(patchPlan(proxy), stateFixture(), proxy);
  expect(await documentDigest(proxy)).toBe(before);
  proxy.heights.fill(1);
  mutablePolygon[0][0] = 100;
  expect(value(sampleTerrainWorld(f, 0, 0)).height).toBe(0);
  expect(f.patchSupport!.validPolygon[0][0]).toBe(-2);
});
test.each([
  "missing",
  "mismatch",
  "tilt",
  "brush",
  "dimensions",
  "length",
  "nan",
  "world-height",
  "error",
  "empty-polygon",
  "self-crossing-polygon",
])(
  "unsupported or invalid patch %s rejects rather than changing its geometry",
  (mode) => {
    const proxy = terrainProxyFixture(),
      p = patchPlan(proxy),
      s = stateFixture();
    if (mode === "mismatch")
      p.terrain.transform = { ...proxy.transform, scale: 2 };
    if (mode === "tilt") {
      proxy.transform = {
        ...proxy.transform,
        quaternion: [Math.sin(0.1), 0, 0, Math.cos(0.1)],
      };
      p.terrain.transform = proxy.transform;
    }
    if (mode === "brush") s.brushes = [brushFixture()];
    if (mode === "dimensions") proxy.width = 10;
    if (mode === "length") proxy.heights = new Float32Array(10202);
    if (mode === "nan") proxy.heights[0] = NaN;
    if (mode === "world-height") {
      proxy.transform = { ...proxy.transform, position: [0, 2, 0] };
      p.terrain.transform = proxy.transform;
    }
    if (mode === "error") proxy.errorBound = NaN;
    if (mode === "empty-polygon") proxy.validPolygon = [];
    if (mode === "self-crossing-polygon")
      proxy.validPolygon = [
        [-1, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
      ];
    expect(buildTerrain(p, s, mode === "missing" ? null : proxy).ok).toBe(
      false,
    );
  },
);
test("equivalent transform values do not depend on object property insertion order", () => {
  const proxy = terrainProxyFixture();
  proxy.transform = { scale: 1, quaternion: [0, 0, 0, 1], position: [0, 0, 0] };
  expect(buildTerrain(patchPlan(proxy), stateFixture(), proxy).ok).toBe(true);
});
test("near-unit accepted yaw uses the registered matrix inverse and normal inverse transpose", () => {
  const proxy = terrainProxyFixture();
  proxy.transform = {
    position: [0, 0, 0],
    quaternion: [0, 0.707107, 0, 0.707107],
    scale: 1,
  };
  const f = build(patchPlan(proxy), stateFixture(), proxy);
  // Registered D has c=-0.000000618898..., s=1.000000618898....
  const c = 1 - 2 * 0.707107 ** 2,
    s = 2 * 0.707107 ** 2;
  const q = value(
    sampleTerrainWorld(f, c * 0.15 + s * 0.25, -s * 0.15 + c * 0.25),
  );
  expect(q.height).toBeCloseTo(0.065, 7);
  // A supplied unit proxy normal makes inverse-transpose behavior observable independently of height finite differences.
  for (let i = 0; i < f.heights.length; i++)
    f.normals.set([0, 0.6, 0.8], 3 * i);
  const n = value(sampleTerrainWorld(f, 0, 0)).normal;
  expect(n[0]).toBeCloseTo(0.7999998146046107, 10);
  expect(n[1]).toBeCloseTo(0.6000002471935686, 10);
  expect(n[2]).toBeCloseTo(-4.951179789772372e-7, 10);
});
test("retained proxy backing allocation is included before allocating copied terrain outputs", () => {
  const proxy = terrainProxyFixture();
  proxy.heights = new Float32Array(new ArrayBuffer(128 * 1024 * 1024), 0, 1681);
  const result = buildTerrain(patchPlan(proxy), stateFixture(), proxy);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.issues.some((i) => i.code === "terrain-budget")).toBe(true);
});
test("native proxy array metadata is not retained or used for dimensions", () => {
  const proxy = terrainProxyFixture();
  Object.defineProperty(proxy.heights, "length", {
    get() {
      throw Error("untrusted metadata read");
    },
  });
  const f = build(patchPlan(proxy), stateFixture(), proxy);
  expect(f.heights.length).toBe(1681);
  expect(value(sampleTerrainWorld(f, 0.15, 0.25)).height).toBeCloseTo(0.065, 7);
});
test.each([1e308, 1e-300])(
  "fixed transform scale %s cannot produce nonfinite or zero world-area grids",
  (scale) => {
    const proxy = terrainProxyFixture();
    proxy.heights.fill(0);
    proxy.errorBound = 0;
    proxy.transform = { ...proxy.transform, scale };
    const result = buildTerrain(patchPlan(proxy), stateFixture(), proxy);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.some((i) => i.code === "patch-transform")).toBe(
        true,
      );
  },
);
test("translated small-scale patch rejects collapsed world nodes without changing D or proxy error", async () => {
  const proxy = terrainProxyFixture();
  proxy.transform = {
    position: [1, 0, 1],
    quaternion: [0, 0, 0, 1],
    scale: 1e-18,
  };
  const before = await documentDigest(proxy),
    plan = patchPlan(proxy, 4, 4);
  const result = buildTerrain(plan, stateFixture(), proxy);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.issues.some((i) => i.code === "patch-transform")).toBe(true);
  expect(await documentDigest(proxy)).toBe(before);
  expect(plan.terrain.transform).toEqual(proxy.transform);
  expect(proxy.errorBound).toBe(0.01);
});
test("distinct grid nodes alone do not certify precision for between-node boundary queries", () => {
  const proxy = terrainProxyFixture();
  proxy.transform = {
    position: [1, 0, 1],
    quaternion: [0, 0, 0, 1],
    scale: 1e-12,
  };
  // All 41 coordinates differ, but inverse error is ~1e-4 canonical units,
  // much larger than the shared query's 1e-9 boundary tolerance.
  expect(
    new Set(Array.from({ length: 41 }, (_, i) => 1 + 1e-12 * (-2 + i * 0.1)))
      .size,
  ).toBe(41);
  expect(buildTerrain(patchPlan(proxy), stateFixture(), proxy).ok).toBe(false);
});
test.each([
  {
    label: "tiny zero translation",
    scale: 1e-18,
    position: [0, 0, 0],
    angle: 0,
  },
  {
    label: "tiny proportional translation and yaw",
    scale: 1e-18,
    position: [1e-18, 0, -2e-18],
    angle: Math.PI / 4,
  },
  {
    label: "resolvable translated",
    scale: 1e-5,
    position: [1, 0, 1],
    angle: 0,
  },
  {
    label: "resolvable translated yaw",
    scale: 1e-5,
    position: [1, 0, 1],
    angle: Math.PI / 4,
  },
])(
  "$label preserves non-symmetric world queries and near-boundary controls",
  ({ scale, position, angle }) => {
    const proxy = terrainProxyFixture();
    const px = position[0],
      pz = position[2],
      qy = Math.sin(angle / 2),
      qw = Math.cos(angle / 2);
    proxy.transform = {
      position: [px, 0, pz],
      quaternion: [0, qy, 0, qw],
      scale,
    };
    const field = build(patchPlan(proxy), stateFixture(), proxy);
    const c = 1 - 2 * qy * qy,
      s = 2 * qy * qw;
    const world = (x: number, z: number) => [
      px + scale * (c * x + s * z),
      pz + scale * (-s * x + c * z),
    ];
    const corners = [terrainNodeWorld(field, 0), terrainNodeWorld(field, 1680)];
    expect(
      corners[0][0] === corners[1][0] && corners[0][2] === corners[1][2],
    ).toBe(false);
    for (const [x, z] of [
      [0.15, 0.25],
      [-1.95, 0.37],
      [2 - 2e-8, 2 - 2e-8],
      [-2 + 2e-8, -2 + 2e-8],
    ]) {
      const [wx, wz] = world(x, z),
        q = value(sampleTerrainWorld(field, wx, wz));
      expect(q.worldError).toBe(scale * 0.01);
      expect(
        Math.abs(q.height - scale * (0.1 * x + 0.2 * z)),
      ).toBeLessThanOrEqual(q.worldError);
    }
    const outside = world(2 + 2e-8, 0);
    expect(sampleTerrainWorld(field, outside[0], outside[1]).ok).toBe(false);
    expect(field.transform).toEqual(proxy.transform);
    expect(field.proxyError).toBe(proxy.errorBound);
  },
);
test("queries reject nonfinite/outside coordinates and mappings reject invalid indices", () => {
  const f = build();
  for (const [x, z] of [
    [NaN, 0],
    [0, Infinity],
    [2.001, 0],
    [0, -2.001],
  ])
    expect(sampleTerrainWorld(f, x, z).ok).toBe(false);
  for (const i of [-1, 0.5, 1681, NaN]) {
    expect(() => terrainNodeWorld(f, i)).toThrow();
    expect(() => terrainNodeWorldArea(f, i)).toThrow();
  }
});

const propertyFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../tests/fixtures/general-scene-properties.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const propertyResults: unknown[] = [];
const propertyCases: {
  id: string;
  seed: number;
  terrainCase: string;
  waterCase: string;
  structuredDraft: unknown;
}[] = propertyFixture.cases;
test.each(propertyCases)(
  "frozen $id builds bounded deterministic terrain (water feasibility is deferred)",
  async (entry) => {
    const draft = parsePlanDraft(entry.structuredDraft),
      state = parseEditableState(stateFixture());
    const inputDigest = await documentDigest({ draft, state });
    const result = buildTerrain(draft, state, null);
    if (!result.ok) {
      propertyResults.push({
        id: entry.id,
        inputDigest,
        outcome: "reject",
        issues: result.issues,
      });
      expect(result.ok, JSON.stringify(result.issues)).toBe(true);
      return;
    }
    const f = result.value,
      digest = await documentDigest(f);
    propertyResults.push({
      id: entry.id,
      seed: draft.seed,
      width: draft.domain.width,
      depth: draft.domain.depth,
      terrainCase: entry.terrainCase,
      waterCase: entry.waterCase,
      inputDigest,
      outcome: "terrain-pass",
      waterValidation: "not-run",
      nodes: f.heights.length,
      tiles: f.tiles.length,
      min: Math.min(...f.heights),
      max: Math.max(...f.heights),
      terrainDigest: digest,
    });
    expect(f.heights.length).toBeLessThanOrEqual(10201);
    expect(
      f.heights.every((h) => Number.isFinite(h) && h >= -2 && h <= 2),
    ).toBe(true);
    expect(new Set(outputs(f)).size).toBe(f.heights.length);
    expect(await documentDigest(build(draft, state))).toBe(digest);
  },
);
afterAll(() => {
  if (process.env.TERRAIN_EVIDENCE_PATH)
    writeFileSync(
      process.env.TERRAIN_EVIDENCE_PATH,
      JSON.stringify(
        {
          evidenceType: "constructed-terrain-property-results",
          fixtureVersion: propertyFixture.fixtureVersion,
          cases: propertyResults,
        },
        null,
        2,
      ) + "\n",
    );
});

test("analytic model is authoritative for offgrid height, node and normal after clone", () => {
  const f = build() as TerrainField & { heightModel: any };
  f.heightModel = {
    kind: "water-profile",
    version: 1,
    baseHeights: f.heights.slice(),
    water: {
      mode: "river",
      waterId: "water",
      controlPoints: [
        [0.5, 0],
        [0.5, 1],
      ],
      width: 0.66,
      depth: 0.1,
      bankWidth: 0.85,
      level: 0.05,
      levelStatus: "resolved",
      levelSource: "user",
      reshapePolicy: "cut-and-fill",
    },
  };
  f.heights.fill(1); // Deliberately stale cache must not become another authority.
  const q = value(sampleTerrainWorld(f, 0.33, 0));
  expect(q.height).toBe(0.05);
  expect(q.worldError).toBeGreaterThan(0);
  expect(terrainNodeWorld(f, 20 * 41 + 20)[1]).toBe(-0.05);
  expect(value(sampleTerrainWorld(structuredClone(f), 0.45, 0.023))).toEqual(
    value(sampleTerrainWorld(f, 0.45, 0.023)),
  );
  const x = 0.45,
    h = 1e-5,
    n = value(sampleTerrainWorld(f, x, 0));
  const dx =
    (value(sampleTerrainWorld(f, x + h, 0)).height -
      value(sampleTerrainWorld(f, x - h, 0)).height) /
    (2 * h);
  expect(-n.normal[0] / n.normal[1]).toBeCloseTo(dx, 6);
});
