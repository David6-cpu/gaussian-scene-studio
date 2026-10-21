import { utils } from "@sparkjsdev/spark";
import { Quaternion, Vector3 } from "three";
import { profileBoundaryWitness } from "./water-profile";
import { expect, test, vi } from "vitest";
import {
  sampleSurfaces,
  analyzeSurfaceSupport,
  surfaceHalf,
  surfacePackedSigma,
  surfacePackedSupport,
  SURFACE_CUTOFF,
  type SurfaceBuffers,
} from "./surface";
import { buildTerrain, sampleTerrainWorld, terrainNormals } from "./terrain";
import * as water from "./water";
import * as terrain from "./terrain";
import { parsePlanDraft } from "./contracts";
import { parseSurfaceStyle } from "./asset-manifest";
import {
  manifestFixture,
  terrainPlanFixture,
  terrainProxyFixture,
  stateFixture,
  waterFixture,
} from "./test-fixtures";
import type { Result } from "./core";
function value<T>(r: Result<T>): T {
  if (!r.ok) throw Error(JSON.stringify(r.issues));
  return r.value;
}
function style() {
  const m = manifestFixture("patch");
  return parseSurfaceStyle({
    id: "constructed-surface",
    contentVersion: "constructed-v1",
    parameters: {
      "sampler-version": 1,
      "tangent-scale": 0.7,
      "normal-scale": 0.1,
      opacity: 1,
      "terrain-color": [0.18, 0.23, 0.09],
      "water-color": [0.025, 0.16, 0.21],
      "color-variation": 0.12,
      "shore-step": 0.5,
    },
    quality: { ...m.quality, operations: [] },
    provenance: m.provenance,
  });
}
function solved(river = false, slope = 0) {
  const p = terrainPlanFixture({ terrain: { slopeDegrees: slope } });
  if (river)
    p.water = {
      ...waterFixture(),
      controlPoints: [
        [0.50125, 0],
        [0.50125, 1],
      ],
      level: 0,
      levelSource: "user",
    };
  const draft = parsePlanDraft(p);
  return value(
    water.solveWater(draft, value(buildTerrain(draft, stateFixture(), null))),
  );
}
function sumUniqueSources(s: SurfaceBuffers) {
  const sources = [...s.terrain.values(), ...(s.water ? [s.water] : [])];
  const seen = new Set<ArrayBufferLike>();
  return sources.reduce((n, s) => {
    if (s.kind !== "float14") throw Error("float expected");
    if (seen.has(s.data.buffer)) return n;
    seen.add(s.data.buffer);
    return n + s.count;
  }, 0);
}
function points(s: SurfaceBuffers) {
  return [...s.terrain.values()].flatMap((b) => {
    if (b.kind !== "float14") throw Error("float expected");
    return Array.from({ length: b.count }, (_, i) =>
      Array.from(b.data.subarray(i * 14, i * 14 + 14)),
    );
  });
}
test("flat output uses every unique tile node and none has no water", () => {
  const w = solved(),
    s = value(sampleSurfaces(w, style(), 250000));
  expect(s.terrain.size).toBe(16);
  expect(s.pointCount).toBe(1681);
  expect(s.water).toBeNull();
  expect(s.pointCount).toBe(sumUniqueSources(s));
  expect(new Set(points(s).map((p) => `${p[0]},${p[2]}`)).size).toBe(1681);
});
test("slope node heights and rotated thin axes follow the authoritative field", () => {
  const w = solved(false, 5),
    s = value(sampleSurfaces(w, style(), 250000));
  expect(s.pointCount).toBe(1681);
  for (const p of points(s)) {
    const q = value(sampleTerrainWorld(w.field, p[0], p[2]));
    expect(p[1]).toBeCloseTo(q.height, 5);
    expect(p[5]).toBeLessThan(p[3]);
    expect(Math.hypot(...p.slice(6, 10))).toBeCloseTo(1, 5);
  }
});
test("actual base and shore point budget cannot be exceeded", () => {
  expect(sampleSurfaces(solved(), style(), 1680).ok).toBe(false);
  const w = solved(true),
    s = value(sampleSurfaces(w, style(), 250000));
  expect(s.water?.count).toBeGreaterThan(0);
  expect(s.pointCount).toBeGreaterThan(1681);
  expect(s.pointCount).toBe(sumUniqueSources(s));
  expect(sampleSurfaces(w, style(), s.pointCount - 1).ok).toBe(false);
  expect(value(sampleSurfaces(w, style(), s.pointCount)).pointCount).toBe(
    s.pointCount,
  );
});
test("unresolved water classification is an explicit failure, never silently dry", () => {
  const w = solved(true);
  const spy = vi.spyOn(water, "sampleWaterDomain").mockReturnValue({
    ok: true,
    value: {
      wet: null,
      signedDistance: 0,
      distanceError: 1e-8,
      classification: "uncertain",
    },
  });
  try {
    const r = sampleSurfaces(w, style(), 250000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].code).toBe("surface-water-uncertain");
  } finally {
    spy.mockRestore();
  }
});
test("style algorithm and bounded finite parameters are strict", () => {
  const s = style();
  for (const parameters of [
    { ...s.parameters, "sampler-version": 2 },
    { ...s.parameters, "tangent-scale": 100 },
    { ...s.parameters, opacity: 1.1 },
    { ...s.parameters, extra: 1 },
  ])
    expect(sampleSurfaces(solved(), { ...s, parameters }, 250000).ok).toBe(
      false,
    );
});
test("sampling preserves the entire parent solution and is deterministic across tile order", () => {
  const w = solved(true),
    before = structuredClone(w),
    a = value(sampleSurfaces(w, style(), 250000));
  expect(w).toEqual(before);
  const b = value(
    sampleSurfaces(
      { ...w, field: { ...w.field, tiles: [...w.field.tiles].reverse() } },
      style(),
      250000,
    ),
  );
  expect(a.pointCount).toBeGreaterThan(0);
  expect(a).toEqual(b);
});

test("generated codec and support match installed Spark packing, including alpha=1 expansion", () => {
  const packed = new Uint32Array(4);
  for (const x of [0, -0, 1e-7, -0.305, 1.0009, 4.999, 20.03])
    for (const sigma of [0.00004, 0.03, 0.0305, 0.071, 0.169]) {
      const data = Float32Array.from([
        x,
        0.013,
        -x,
        sigma,
        sigma * 0.9,
        sigma * 0.2,
      ]);
      utils.setPackedSplat(
        packed,
        0,
        data[0],
        data[1],
        data[2],
        data[3],
        data[4],
        data[5],
        0,
        0,
        0,
        1,
        1,
        0.2,
        0.2,
        0.2,
      );
      const decoded = utils.unpackSplat(packed, 0),
        center = [data[0], data[1], data[2]] as const,
        scales = [data[3], data[4], data[5]] as const;
      expect(surfaceHalf(data[0])).toBe(decoded.center.x);
      expect(surfacePackedSigma(data[3])).toBeCloseTo(decoded.scales.x, 14);
      const support = surfacePackedSupport(center, scales, 0.0001);
      const expanded =
        Math.sqrt(8) + 0.7 * (4 * ((2 * Math.round(0.5 * 255)) / 255) - 4);
      expect(SURFACE_CUTOFF).toBeGreaterThan(expanded);
      expect(support.radius).toBeGreaterThanOrEqual(
        decoded.center.distanceTo(new Vector3(...center)) +
          expanded * Math.max(...decoded.scales.toArray()) +
          0.0001,
      );
    }
});
test("normal quaternion maps the thin axis to the shared normal at tile boundaries", () => {
  const w = solved(false, 5),
    s = value(sampleSurfaces(w, style(), 250000));
  for (const p of points(s).filter((p) => p[0] === 0 || p[2] === 0)) {
    const rotated = new Vector3(0, 0, 1).applyQuaternion(
      new Quaternion(...p.slice(6, 10)),
    );
    const expected = value(sampleTerrainWorld(w.field, p[0], p[2])).normal;
    expect(rotated.distanceTo(new Vector3(...expected))).toBeLessThan(1e-6);
  }
});
test("analytic cache values do not replace the continuous authority or nominal boundary witnesses", () => {
  const w = solved(true),
    a = value(sampleSurfaces(w, style(), 250000));
  expect(w.domain.shore).toHaveLength(0);
  expect(a.sampling!.boundaryPoints).toBeGreaterThan(0);
  const altered = structuredClone(w);
  altered.field.heights.fill(1.9);
  altered.field.normals.fill(0);
  expect(value(sampleSurfaces(altered, style(), 250000))).toEqual(a);
  const g = w.domain.geometry!;
  const witness = profileBoundaryWitness(g, 0, 0.5, 1);
  const q = value(water.sampleWaterDomain(w, ...witness.point));
  expect(["boundary", "uncertain"]).toContain(q.classification);
  const near = points(a).filter(
    (p) => Math.abs(p[0] - witness.point[0]) < 1e-6,
  );
  expect(near.length).toBeGreaterThan(0);
  for (const p of near)
    expect(p[1]).toBeCloseTo(
      value(sampleTerrainWorld(w.field, p[0], p[2])).height,
      5,
    );
});
test("all water indices have exactly one stable tile and ownedBytes counts every returned array", () => {
  const s = value(sampleSurfaces(solved(true), style(), 250000)),
    m = s.sampling!;
  const indices = m.waterTiles.flatMap((t) => Array.from(t.outputIndices));
  expect(indices).toHaveLength(s.water!.count);
  expect(new Set(indices).size).toBe(s.water!.count);
  expect(indices.slice().sort((a, b) => a - b)).toEqual(
    Array.from({ length: s.water!.count }, (_, i) => i),
  );
  const bytes =
    [...s.terrain.values(), s.water!].reduce(
      (n, s) => n + (s.kind === "float14" ? s.data.byteLength : 0),
      0,
    ) + m.waterTiles.reduce((n, t) => n + t.outputIndices.byteLength, 0);
  expect(s.ownedBytes).toBe(bytes);
  expect(m.peakKnownCpuBytes).toBe(
    m.retainedInputBytes + m.peakWorkspaceBytes + bytes,
  );
  expect(m.maxLogicalRadius).toBeGreaterThan(0);
  expect(m.version).toBe(1);
  expect(m.shorelineReach).toBe(0);
});
test("no-water fixed patch produces no procedural blanket and retains the original data", () => {
  const proxy = terrainProxyFixture(),
    p = terrainPlanFixture();
  p.terrain = {
    source: "patch",
    assetRef: { id: "constructed-patch", contentVersion: "constructed-v1" },
    transform: proxy.transform,
  };
  p.surfaceStyleRef = null;
  const w = value(
      water.solveWater(
        parsePlanDraft(p),
        value(buildTerrain(p, stateFixture(), proxy)),
      ),
    ),
    before = structuredClone(w);
  const s = value(sampleSurfaces(w, style(), 0));
  expect(s.terrain.size).toBe(0);
  expect(s.water).toBeNull();
  expect(s.pointCount).toBe(0);
  expect(w).toEqual(before);
});
test("duplicate and incomplete grid ownership are rejected rather than hidden by output deduplication", () => {
  const w = solved();
  w.field.tiles[0].outputIndices[0] = w.field.tiles[1].outputIndices[0];
  expect(sampleSurfaces(w, style(), 250000).ok).toBe(false);
});
test("world colors and geometry do not depend on how tiles are grouped", () => {
  const w = solved(),
    a = value(sampleSurfaces(w, style(), 250000));
  w.field.tiles = [
    {
      id: "combined",
      bounds: { min: [-2, -2], max: [2, 2] },
      nodeIndices: Uint32Array.from({ length: 1681 }, (_, i) => i),
      outputIndices: Uint32Array.from({ length: 1681 }, (_, i) => i),
    },
  ];
  const b = value(sampleSurfaces(w, style(), 250000));
  const sort = (s: SurfaceBuffers) =>
    points(s).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  expect(sort(a)).toEqual(sort(b));
});

test("support replays from stored bytes, style and field without terrain/water queries or solving", () => {
  const w = solved(true),
    s = value(sampleSurfaces(w, style(), 250000)),
    stored = structuredClone({
      sources: [...s.terrain.values(), s.water!],
      field: w.field,
      style: style(),
    });
  const expected = {
    supportPolicy: s.sampling!.supportPolicy,
    maxLogicalRadius: s.sampling!.maxLogicalRadius,
    candidateLogicalRadius: s.sampling!.candidateLogicalRadius,
    nominalErrorBound: s.sampling!.nominalErrorBound,
    normalReach: s.sampling!.normalReach,
    shorelineReach: s.sampling!.shorelineReach,
    shoreStep: s.sampling!.shoreStep,
  };
  const query = vi.spyOn(water, "sampleWaterDomain").mockImplementation(() => {
    throw Error("no query on reopen");
  });
  const solver = vi.spyOn(water, "solveWater").mockImplementation(() => {
    throw Error("no solver on reopen");
  });
  const heightQuery = vi
    .spyOn(terrain, "sampleTerrainWorld")
    .mockImplementation(() => {
      throw Error("no height query on reopen");
    });
  try {
    expect(
      value(analyzeSurfaceSupport(stored.sources, stored.field, stored.style)),
    ).toEqual(expected);
    expect(query).not.toHaveBeenCalled();
    expect(solver).not.toHaveBeenCalled();
    expect(heightQuery).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    solver.mockRestore();
    heightQuery.mockRestore();
  }
  expect(s.sampling!.observedMaxLogicalRadius).toBeLessThanOrEqual(
    expected.maxLogicalRadius,
  );
});
test("support envelope covers both half branches and future curvature flattening, not only parent sigmas", () => {
  const w = solved();
  for (let i = 0; i < w.field.heights.length; i++) {
    const x = (i % 41) * 0.1 - 2,
      z = Math.floor(i / 41) * 0.1 - 2;
    w.field.heights[i] = 0.15 * (x * x + z * z);
  }
  w.field.normals = terrainNormals(w.field);
  const parent = value(sampleSurfaces(w, style(), 250000)),
    candidate = value(sampleSurfaces(solved(), style(), 250000));
  expect(Math.max(...points(parent).map((p) => p[3]))).toBeLessThan(
    Math.max(...points(candidate).map((p) => p[3])),
  );
  expect(parent.sampling!.candidateLogicalRadius).toBeGreaterThanOrEqual(
    candidate.sampling!.maxLogicalRadius,
  );
  const stored = [...candidate.terrain.values()],
    support = value(analyzeSurfaceSupport(stored, w.field, style()));
  for (const p of points(candidate)) {
    const sigma = Math.max(...p.slice(3, 6).map(surfacePackedSigma));
    const trunc = (x: number) =>
      Math.sign(x) *
      Math.floor(
        Math.abs(x) /
          Math.max(2 ** -24, 2 ** (Math.floor(Math.log2(Math.abs(x))) - 10)),
      ) *
      Math.max(2 ** -24, 2 ** (Math.floor(Math.log2(Math.abs(x))) - 10));
    const err = Math.hypot(...p.slice(0, 3).map((x) => trunc(x) - x));
    expect(
      err + SURFACE_CUTOFF * sigma + support.nominalErrorBound,
    ).toBeLessThanOrEqual(support.maxLogicalRadius);
  }
});
test("unknown saved sampling/profile versions fail closed without rewriting stored buffers", () => {
  const w = solved(),
    s = value(sampleSurfaces(w, style(), 250000)),
    sources = [...s.terrain.values()],
    before = structuredClone(sources);
  expect(
    analyzeSurfaceSupport(sources, w.field, {
      ...style(),
      parameters: { ...style().parameters, "sampler-version": 2 },
    }).ok,
  ).toBe(false);
  expect(
    analyzeSurfaceSupport(
      sources,
      {
        ...w.field,
        heightModel: { kind: "water-profile", version: 2 } as never,
      },
      style(),
    ).ok,
  ).toBe(false);
  expect(sources).toEqual(before);
});

test("vertically translated rotated scaled raw-D preserve patch emits only water and preserves original geometry", () => {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0;
  proxy.transform = {
    position: [0, 0.1, 0],
    quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    scale: 2,
  };
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.29 ? -0.1 : 0;
  const p = terrainPlanFixture({ width: 8, depth: 8 });
  p.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  p.water = {
    ...waterFixture(),
    controlPoints: [
      [0, 0.5],
      [1, 0.5],
    ],
    width: 1.2,
    level: 0.1,
    reshapePolicy: "preserve",
  };
  const draft = parsePlanDraft(p),
    w = value(
      water.solveWater(
        draft,
        value(buildTerrain(draft, stateFixture(), proxy)),
      ),
    );
  const before = structuredClone(w),
    sampled = value(sampleSurfaces(w, style(), 250000));
  expect(sampled.terrain.size).toBe(0);
  expect(sampled.water!.count).toBeGreaterThan(0);
  expect(w).toEqual(before);
  expect(sampled.sampling!.maxLogicalRadius).toBeLessThanOrEqual(
    sampled.sampling!.candidateLogicalRadius,
  );
});
test("saved sources outside the version-1 finite world-XZ envelope are explicitly rejected", () => {
  const w = solved(),
    s = value(sampleSurfaces(w, style(), 250000)),
    sources = structuredClone([...s.terrain.values()]);
  if (sources[0].kind !== "float14") throw Error("float14 expected");
  sources[0].data[0] = 5.01;
  expect(analyzeSurfaceSupport(sources, w.field, style()).ok).toBe(false);
});

test("restored support rejects opacity outside the cutoff proof rather than reusing its radius", () => {
  const w = solved(),
    s = value(sampleSurfaces(w, style(), 250000)),
    sources = structuredClone([...s.terrain.values()]);
  if (sources[0].kind !== "float14") throw Error("float expected");
  sources[0].data[13] = 1.01;
  expect(analyzeSurfaceSupport(sources, w.field, style()).ok).toBe(false);
});

test("strict opacity lower endpoint survives Float32 storage and support replay", () => {
  const w = solved(),
    low = { ...style(), parameters: { ...style().parameters, opacity: 0.7 } };
  const s = value(sampleSurfaces(w, low, 250000));
  const sources = [...s.terrain.values()];
  if (sources[0].kind !== "float14") throw Error("float expected");
  expect(sources[0].data[13]).toBe(Math.fround(0.7));
  expect(
    value(analyzeSurfaceSupport(sources, w.field, low)).maxLogicalRadius,
  ).toBe(s.sampling!.maxLogicalRadius);
});

function preservePatch(
  mode: "unit" | "near-unit" | "void" | "near-water-void",
) {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0;
  const q = Math.SQRT1_2,
    qw = mode === "near-unit" ? 0.707107 : q,
    sy = 2 * q * qw;
  proxy.transform = {
    position: [0, 0.1, 0],
    quaternion: [0, q, 0, qw],
    scale: 1 / sy,
  };
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.29 ? -0.1 : 0;
  if (mode === "void")
    proxy.voidMask = [
      [
        [1, 1],
        [1.2, 1],
        [1.2, 1.2],
        [1, 1.2],
      ],
    ];
  if (mode === "near-water-void")
    proxy.voidMask = [
      [
        [-0.1, -0.1],
        [0.1, -0.1],
        [0.1, 0.1],
        [-0.1, 0.1],
      ],
    ];
  const p = terrainPlanFixture();
  p.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  p.water = {
    ...waterFixture(),
    controlPoints: [
      [0, 0.5],
      [1, 0.5],
    ],
    width: 0.6,
    level: 0.1,
    reshapePolicy: "preserve",
  };
  const draft = parsePlanDraft(p),
    field = value(buildTerrain(draft, stateFixture(), proxy));
  return water.solveWater(draft, field);
}
test.each(["near-unit", "void"] as const)(
  "legal preserve patch %s retains raw D and samples only its active water",
  (mode) => {
    const w = value(preservePatch(mode)),
      before = structuredClone(w),
      s = value(sampleSurfaces(w, style(), 250000));
    expect(s.water!.count).toBeGreaterThan(0);
    expect(s.terrain.size).toBe(0);
    expect(w).toEqual(before);
    const owned = s.sampling!.waterTiles.flatMap((t) =>
      Array.from(t.outputIndices),
    );
    expect(new Set(owned).size).toBe(s.water!.count);
  },
);
test("a void near water remains rejected by the authoritative solver", () => {
  expect(preservePatch("near-water-void").ok).toBe(false);
});
test("missing active-cell evidence is rejected, never interpreted as no water", () => {
  const w = value(preservePatch("unit"));
  w.domain.activeCells = new Uint8Array(0);
  expect(sampleSurfaces(w, style(), 250000).ok).toBe(false);
});
test("active preserve water uncertainty is still rejected after inactive node filtering", () => {
  const w = value(preservePatch("unit"));
  const spy = vi
    .spyOn(water, "sampleWaterDomain")
    .mockReturnValue({
      ok: true,
      value: {
        wet: null,
        signedDistance: 0,
        distanceError: 1e-8,
        classification: "uncertain",
      },
    });
  try {
    const r = sampleSurfaces(w, style(), 250000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].code).toBe("surface-water-uncertain");
  } finally {
    spy.mockRestore();
  }
});
