import { afterAll, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  solveWater,
  sampleWaterDomain,
  prepareSupportCells,
  supportQueryRectangle,
  type WaterSolution,
} from "./water.ts";
import {
  buildTerrain,
  terrainNormals,
  terrainNodeWorld,
  sampleTerrainWorld,
  type TerrainField,
} from "./terrain.ts";
import { parsePlanDraft } from "./contracts.ts";
import { documentDigest } from "./canonical.ts";
import {
  terrainPlanFixture,
  terrainProxyFixture,
  stateFixture,
  waterFixture,
  brushFixture,
} from "./test-fixtures.ts";
import type { Result } from "./core.ts";
function value<T>(r: Result<T>): T {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw Error(JSON.stringify(r));
  return r.value;
}
function plan(
  water: Record<string, unknown> = waterFixture(true),
  width = 8,
  depth = 8,
) {
  const p = terrainPlanFixture({ width, depth });
  p.water = water;
  return parsePlanDraft(p);
}
function build(p = plan()) {
  return value(buildTerrain(p, stateFixture(), null));
}
function solved(p = plan(), f = build(p)) {
  return value(solveWater(p, f));
}
function referenceShore(
  solution: WaterSolution,
  points: readonly (readonly [number, number])[],
) {
  const clone = structuredClone(solution);
  if (clone.domain.geometry) {
    expect(clone.domain.shore).toEqual([]);
    expect(clone.domain.shoreIndex.byteLength).toBe(0);
    const g = clone.domain.geometry;
    if (g.mode !== "river") throw Error("Expected cubic reference");
    for (const [x, z] of points) {
      let best = Infinity,
        bound = 0;
      for (const b of g.cubics) {
        const at = (t: number): [number, number] => {
          const u = 1 - t;
          return [0, 1].map(
            (k) =>
              u ** 3 * b[0][k] +
              3 * u * u * t * b[1][k] +
              3 * u * t * t * b[2][k] +
              t ** 3 * b[3][k],
          ) as [number, number];
        };
        const second = Math.max(
          ...[0, 1].map(
            (i) =>
              6 *
              Math.hypot(
                ...[0, 1].map((k) => b[i + 2][k] - 2 * b[i + 1][k] + b[i][k]),
              ),
          ),
        );
        bound = Math.max(bound, second / (8 * 1000 ** 2));
        let a = at(0);
        for (let i = 1; i <= 1000; i++) {
          const c = at(i / 1000),
            dx = c[0] - a[0],
            dz = c[1] - a[1],
            t = Math.max(
              0,
              Math.min(
                1,
                ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz),
              ),
            );
          best = Math.min(
            best,
            Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz),
          );
          a = c;
        }
      }
      const q = value(sampleWaterDomain(clone, x, z));
      expect(q).toEqual(value(sampleWaterDomain(solution, x, z)));
      expect(
        Math.abs(q.signedDistance - (best - g.radius)),
      ).toBeLessThanOrEqual(bound + q.distanceError + 1e-12);
    }
    return;
  }
  expect(clone.domain.shoreIndex.byteLength).toBe(
    (2 * clone.domain.shore.length - 1) * 6 * 4,
  );
  for (const [x, z] of points) {
    let distance = Infinity;
    for (const [a, b] of clone.domain.shore) {
      const dx = b[0] - a[0],
        dz = b[1] - a[1];
      const t = Math.max(
        0,
        Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)),
      );
      distance = Math.min(
        distance,
        Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz),
      );
    }
    const original = value(sampleWaterDomain(solution, x, z)),
      indexed = value(sampleWaterDomain(clone, x, z));
    expect(indexed).toEqual(original);
    expect(indexed.signedDistance).toBeCloseTo(
      distance < 1e-9 ? 0 : indexed.wet ? -distance : distance,
      11,
    );
  }
}
function blocked(p: ReturnType<typeof plan>, f = build(p), code = /water-/) {
  const r = solveWater(p, f);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues[0].code).toMatch(code);
    expect(r.issues[0].code).not.toBe("water-unimplemented");
  }
  return r;
}
const surface = (extra: Record<string, unknown> = {}) => {
  const { controlPoints: _, width: __, ...w } = waterFixture(true);
  return {
    ...w,
    mode: "surface",
    polygon: [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
    ...extra,
  };
};
const obliqueS = [
  [0.5, 0],
  [0.55, 0.3],
  [0.45, 0.7],
  [0.5, 1],
];
// Independent genuine six-control curve; the historical oblique input remains
// above and is now an explicit unsupported-bank regression.
const steepNormalS = [
  [0.5, 0],
  [0.5, 0.2],
  [0.56, 0.4],
  [0.44, 0.6],
  [0.5, 0.8],
  [0.5, 1],
];
const gridBoundaryS = [
  [0.5, 0],
  [0.5, 0.2],
  [0.53, 0.4],
  [0.47, 0.6],
  [0.5, 0.8],
  [0.5, 1],
];
const S = [
  [0.500625, 0],
  [0.500625, 0.2],
  [0.530625, 0.4],
  [0.470625, 0.6],
  [0.500625, 0.8],
  [0.500625, 1],
];
test("fix2 exact-grid curved shore ambiguity remains an explicit rejection", () => {
  const p = plan({ ...waterFixture(), controlPoints: gridBoundaryS });
  const r = blocked(p);
  if (!r.ok) expect(JSON.stringify(r.issues)).toMatch(/water-precision/);
});
test("fix2 normal terminals do not waive an over-curved interior", () =>
  blocked(plan({ ...waterFixture(), controlPoints: steepNormalS })));
test("fix2 historical oblique S keeps its parameters and rejects its missing terminal bank", () => {
  const p = plan({ ...waterFixture(), controlPoints: obliqueS });
  const r = blocked(p);
  if (!r.ok) expect(r.issues[0].code).toBe("water-bank");
});
// Break: null/unspecified is silently converted into a default water body.
test("none has no wet nodes, finite positive dry distance and no earthworks", () => {
  const p = plan({ mode: "none" }),
    f = build(p),
    w = solved(p, f);
  expect(w.resolvedWater).toEqual({ mode: "none" });
  expect(w.wetMask.some(Boolean)).toBe(false);
  expect(w.bankMask.some(Boolean)).toBe(false);
  expect(w.shoreDistance.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
  expect(w.cutVolume + w.fillVolume).toBe(0);
  expect(w.field.heights).toEqual(f.heights);
  expect(value(sampleWaterDomain(w, 0, 0)).wet).toBe(false);
});
test("unspecified remains blocked, not none", () =>
  blocked(plan({ mode: "unspecified" })));
test.each([
  [
    "north-south",
    [
      [0.5, 0],
      [0.5, 1],
    ],
  ],
  [
    "east-west",
    [
      [0, 0.5],
      [1, 0.5],
    ],
  ],
  ["S", S],
  ["transposed-S", S.map(([x, z]) => [z, x])],
] as const)("%s river uses the same connected solver", (_, controlPoints) => {
  const p = plan({ ...waterFixture(true), controlPoints }),
    w = solved(p);
  expect(w.report.components).toBe(1);
  expect(w.report.wetNodes).toBeGreaterThan(0);
  expect(w.report.minimumDryBank).toBeGreaterThanOrEqual(0.2);
  expect(w.report.dryAreaFraction).toBeGreaterThanOrEqual(0.25);
  expect(w.resolvedWater.mode).toBe("river");
  expect(value(sampleWaterDomain(w, 0, 0)).wet).toBe(true);
});
test("explicit -0.025 and user provenance are retained without another candidate", () => {
  const p = plan({ ...waterFixture(), levelSource: "user" }),
    w = solved(p);
  expect(w.resolvedWater).toMatchObject({ level: -0.025, levelSource: "user" });
  expect(w.report.candidateLevels).toEqual([-0.025]);
  expect(w.report.levelSource).toBe("explicit");
});
test("flat original 0.02 is a candidate and the selected suggestion is visible", () => {
  const raw = terrainPlanFixture({
    width: 8,
    depth: 8,
    terrain: { elevation: 0.02 },
  });
  raw.water = waterFixture(true);
  const p = parsePlanDraft(raw),
    f = build(p),
    w = solved(p, f);
  expect(w.report.candidateLevels).toContain(terrainNodeWorld(f, 0)[1]);
  expect(w.report.levelSource).toBe("program-suggestion");
  expect(w.resolvedWater).toMatchObject({
    levelStatus: "resolved",
    levelSource: "default",
  });
});
test("costs use half edge / quarter corner area and lower-level tie ordering", () => {
  const w = solved();
  const candidates = w.report.candidates.filter((c) => c.feasible);
  expect(candidates.length).toBeGreaterThan(1);
  const best = [...candidates].sort(
    (a, b) => a.volume! - b.volume! || a.level - b.level,
  )[0];
  expect("level" in w.resolvedWater && w.resolvedWater.level).toBe(best.level);
  expect(w.cutVolume).toBeGreaterThan(0);
  expect(w.fillVolume).toBeGreaterThanOrEqual(0);
  const f = w.field;
  let cut = 0,
    fill = 0;
  for (let z = 0; z < f.nz; z++)
    for (let x = 0; x < f.nx; x++) {
      const area =
          0.01 *
          (x === 0 || x === f.nx - 1 ? 0.5 : 1) *
          (z === 0 || z === f.nz - 1 ? 0.5 : 1),
        delta = terrainNodeWorld(f, z * f.nx + x)[1];
      cut += Math.max(0, -delta) * area;
      fill += Math.max(0, delta) * area;
    }
  expect(w.cutVolume).toBeCloseTo(cut, 9);
  expect(w.fillVolume).toBeCloseTo(fill, 9);
});
test("closed surface has one wet basin, dry bank and no endpoint portals", () => {
  const w = solved(plan(surface()));
  expect(w.resolvedWater.mode).toBe("surface");
  expect(w.report.components).toBe(1);
  expect(value(sampleWaterDomain(w, 0, 0)).wet).toBe(true);
  expect(value(sampleWaterDomain(w, 1.3, 0)).wet).toBe(false);
  expect(w.report.minimumDryBank).toBeGreaterThanOrEqual(0.2);
});
test("surface and river queries agree with every final mask node and signed distances", () => {
  for (const p of [plan(), plan(surface())]) {
    const w = solved(p);
    for (let i = 0; i < w.wetMask.length; i += 17) {
      const [x, , z] = terrainNodeWorld(w.field, i),
        q = value(sampleWaterDomain(w, x, z));
      expect(q.wet).toBe(Boolean(w.wetMask[i]));
      expect(Math.sign(q.signedDistance)).toBe(Math.sign(w.shoreDistance[i]));
      if (q.wet)
        expect(w.field.heights[i]).toBeLessThan(
          (w.resolvedWater as { level: number }).level,
        );
    }
  }
});
test("final field normals update while parent buffers and draft remain byte-identical", async () => {
  const p = plan(),
    f = build(p),
    before = await documentDigest({ p, f });
  const w = solved(p, f);
  expect(await documentDigest({ p, f })).toBe(before);
  expect(w.field.heights).not.toBe(f.heights);
  expect(w.field.normals).toEqual(terrainNormals(w.field));
  // This grid can land on the flat bed/shore while the intervening analytic
  // bank still slopes. Compare the actual query, not a cache artefact.
  expect(value(sampleTerrainWorld(w.field, 0.26, 0)).normal).not.toEqual(
    value(sampleTerrainWorld(f, 0.26, 0)).normal,
  );
  expect(w.report.modifiedBounds).not.toBeNull();
});
test("all reshaping stays inside requested river plus bank width", () => {
  const p = plan({ ...waterFixture(), levelSource: "user" }),
    f = build(p),
    w = solved(p, f);
  for (let i = 0; i < f.heights.length; i++) {
    const x = (i % f.nx) * 0.1 - 4;
    if (Math.abs(x) > 0.7 + 1e-9) expect(w.field.heights[i]).toBe(f.heights[i]);
  }
});
test("cut-only refuses an explicit high level requiring fill", () =>
  blocked(
    plan({
      ...waterFixture(),
      level: 0.2,
      levelSource: "user",
      reshapePolicy: "cut-only",
    }),
    undefined,
    /water-(policy|blocked)/,
  ));
test("preserve refuses flat terrain instead of secretly digging a channel", () =>
  blocked(plan({ ...waterFixture(), level: 0, reshapePolicy: "preserve" })));
test("cut-only accepts a feasible cut channel without positive deltas", () => {
  const p = plan({ ...waterFixture(), level: 0, reshapePolicy: "cut-only" }),
    w = solved(p);
  expect(w.fillVolume).toBe(0);
  expect(w.cutVolume).toBeGreaterThan(0);
});
test("overflowing bed elevation is rejected rather than clamped", () =>
  blocked(
    plan({ ...waterFixture(), level: -2, depth: 0.5, levelSource: "user" }),
  ));
test("too little dry land and boundary-touching surface are rejected", () =>
  blocked(
    plan(
      surface({
        polygon: [
          [-4, -4],
          [4, -4],
          [4, 4],
          [-4, 4],
        ],
        level: 2,
        levelStatus: "resolved",
        levelSource: "user",
        reshapePolicy: "preserve",
      }),
    ),
  ));
test.each([
  [
    "sharp curvature",
    [
      [0.5, 0],
      [0.52, 0.45],
      [0.9, 0.5],
      [0.5, 1],
    ],
  ],
  [
    "curve escape",
    [
      [0.1, 0],
      [0, 0.3],
      [0, 0.7],
      [0.1, 1],
    ],
  ],
  [
    "nonlocal overlap",
    [
      [0.2, 0],
      [0.2, 0.8],
      [0.6, 0.8],
      [0.6, 0.2],
      [0.8, 0.2],
      [0.8, 1],
    ],
  ],
])("rejects actual interpolated %s without changing controls", (_, points) => {
  const p = plan(
    { ...waterFixture(true), controlPoints: points, width: 1.2 },
    10,
    10,
  );
  const original = JSON.stringify(p);
  blocked(p);
  expect(JSON.stringify(p)).toBe(original);
});
test("same-boundary or crossing input is a typed failure even if caller bypasses parser", () => {
  const p = structuredClone(plan()) as any;
  p.water.controlPoints = [
    [0.2, 0],
    [0.8, 0],
  ];
  blocked(p, build());
});
test("insufficient continuous banks reject an otherwise connected narrow-edge river", () =>
  blocked(
    plan(
      {
        ...waterFixture(true),
        controlPoints: [
          [0.035, 0],
          [0.035, 1],
        ],
        width: 0.4,
        bankWidth: 0.2,
      },
      4,
      4,
    ),
  ));
test("off-grid submerged ditch in the bank cannot be hidden by checking only a few samples", () => {
  const p = plan({ ...waterFixture(), level: 0, reshapePolicy: "preserve" }),
    f = build(p);
  for (let i = 0; i < f.heights.length; i++) {
    const x = i % f.nx;
    f.heights[i] = x >= 38 && x <= 42 ? -0.1 : 0;
  }
  f.heights[20 * f.nx + 44] = -0.2;
  f.normals = terrainNormals(f);
  blocked(p, f);
});
test("patch preserve never changes geometry or treats uncertain shore as dry", () => {
  const proxy = terrainProxyFixture();
  proxy.heights.fill(0);
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw),
    f = value(buildTerrain(p, stateFixture(), proxy)),
    before = f.heights.slice();
  blocked(p, f);
  expect(f.heights).toEqual(before);
});
test.each([false, true])(
  "rotated fixed-D patch continuous boundary, symmetric=%s",
  (symmetric) => {
    const proxy = terrainProxyFixture();
    proxy.errorBound = 0;
    proxy.transform = {
      position: [0, 0, 0],
      quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      scale: 2,
    };
    for (let i = 0; i < 1681; i++) {
      const x = (i % 41) * 0.1 - 2;
      proxy.heights[i] = Math.abs(x) < (symmetric ? 0.29 : 0.3) ? -0.1 : 0;
    }
    const raw = terrainPlanFixture({ width: 8, depth: 8 });
    raw.terrain = {
      source: "patch",
      assetRef: { id: "patch", contentVersion: "v1" },
      transform: proxy.transform,
    };
    raw.water = {
      ...waterFixture(),
      controlPoints: [
        [0, 0.5],
        [1, 0.5],
      ],
      width: 1.2,
      level: 0,
      reshapePolicy: "preserve",
    };
    const p = parsePlanDraft(raw),
      f = value(buildTerrain(p, stateFixture(), proxy));
    if (!symmetric) {
      const r = blocked(p, f);
      if (!r.ok) expect(JSON.stringify(r.issues)).toMatch(/water-boundary/);
      return;
    }
    const w = solved(p, f);
    expect(w.field.heights).toEqual(f.heights);
    expect(w.cutVolume + w.fillVolume).toBe(0);
    expect(w.report.requiresManifestValidation).toBe(true);
    expect(value(sampleWaterDomain(w, 0, 0)).wet).toBe(true);
    referenceShore(w, [
      [0, 0],
      [0.031, 0.5],
      [0.019, 0.6],
      [4, 0],
      [-4, 0.8],
      [-1.001, 1.2],
    ]);
    const cloned = structuredClone(w);
    for (let i = 0; i < f.heights.length; i++) {
      const [x, , z] = terrainNodeWorld(f, i);
      const q = value(sampleWaterDomain(cloned, x, z));
      expect(q.wet, `canonical node ${i}`).toBe(Boolean(w.wetMask[i]));
      expect(Math.abs(q.signedDistance - w.shoreDistance[i])).toBeLessThan(
        1e-6,
      );
    }
  },
);
test("patch void intersecting water or bank is not silently counted as dry", () => {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0;
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.3 ? -0.1 : 0;
  proxy.voidMask = [
    [
      [-0.1, -0.1],
      [0.1, -0.1],
      [0.1, 0.1],
      [-0.1, 0.1],
    ],
  ];
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw);
  blocked(p, value(buildTerrain(p, stateFixture(), proxy)));
});
test("draft/field domain mismatch fails rather than carving another scene", () =>
  blocked(plan(), build(plan(waterFixture(true), 4, 4))));
test("malformed or over-budget retained buffers reject before sampling", () => {
  const p = plan(),
    f = build(p);
  blocked(p, { ...f, heights: new Float32Array([NaN]) });
});
function measuredBuffers(value: unknown) {
  const buffers = new Set<ArrayBufferLike>(),
    seen = new Set<object>();
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      buffers.add(v.buffer);
      return;
    }
    for (const child of Object.values(v)) visit(child);
  };
  visit(value);
  return [...buffers].reduce((n, b) => n + b.byteLength, 0);
}
function measuredComponents(w: WaterSolution) {
  const mask = w.wetMask,
    nx = w.field.nx,
    visited = new Uint8Array(mask.length);
  let count = 0;
  for (let seed = 0; seed < mask.length; seed++)
    if (mask[seed] && !visited[seed]) {
      count++;
      const queue = [seed];
      visited[seed] = 1;
      for (let j = 0; j < queue.length; j++) {
        const i = queue[j],
          x = i % nx;
        for (const next of [
          x ? i - 1 : -1,
          x < nx - 1 ? i + 1 : -1,
          i - nx,
          i + nx,
        ])
          if (next >= 0 && next < mask.length && mask[next] && !visited[next]) {
            visited[next] = 1;
            queue.push(next);
          }
      }
    }
  return count;
}
const evidence: unknown[] = [];
const properties = JSON.parse(
  readFileSync(
    new URL(
      "../../tests/fixtures/general-scene-properties.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const requests = JSON.parse(
  readFileSync(
    new URL(
      "../../tests/fixtures/general-scene-requests.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const fixedCases = [
  ...properties.cases,
  ...requests.cases.filter((c: any) => c.kind === "positive"),
];
test.each(fixedCases as { id: string; structuredDraft: any }[])(
  "fixed $id records deterministic water outcome without changing the input",
  async (c) => {
    const p = parsePlanDraft(c.structuredDraft),
      f = build(p),
      before = await documentDigest({ p, f });
    const start = performance.now(),
      r = solveWater(p, f),
      firstSolveMilliseconds = performance.now() - start;
    const repeatStart = performance.now(),
      r2 = solveWater(p, f),
      repeatSolveMilliseconds = performance.now() - repeatStart;
    expect(await documentDigest({ p, f })).toBe(before);
    expect(await documentDigest(r)).toBe(await documentDigest(r2));
    if (r.ok) {
      expect(r.value.report.dryAreaFraction).toBeGreaterThanOrEqual(0.25);
      expect(r.value.shoreDistance.every(Number.isFinite)).toBe(true);
    } else {
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.issues[0].code).not.toBe("water-unimplemented");
    }
    evidence.push({
      id: c.id,
      firstSolveMilliseconds,
      repeatSolveMilliseconds,
      inputDigest: await documentDigest(p),
      outcome: r.ok ? "water-pass" : "water-reject",
      ...(r.ok
        ? {
            resultDigest: await documentDigest(r.value),
            water: r.value.resolvedWater,
            grid: {
              space: r.value.field.space,
              layout: r.value.field.layout,
              nx: r.value.field.nx,
              nz: r.value.field.nz,
              spacing: r.value.field.spacing,
              domain: r.value.field.domain,
              transform: r.value.field.transform,
              heights: [...r.value.field.heights],
              normals: [...r.value.field.normals],
              heightModel:
                r.value.field.heightModel.kind === "water-profile"
                  ? {
                      ...r.value.field.heightModel,
                      baseHeights: [...r.value.field.heightModel.baseHeights],
                    }
                  : r.value.field.heightModel,
            },
            finalDomain: {
              ...r.value.domain,
              activeCells: [...r.value.domain.activeCells],
              shoreIndex: [...r.value.domain.shoreIndex],
            },
            report: r.value.report,
            measured: {
              components: measuredComponents(r.value),
              bankNodes: r.value.bankMask.reduce((n, v) => n + v, 0),
              ownedBufferBytes: measuredBuffers(r.value),
              nodeCount: r.value.field.heights.length,
              baseBytes:
                r.value.field.heightModel.kind === "water-profile"
                  ? r.value.field.heightModel.baseHeights.byteLength
                  : 0,
              shoreIndexBytes: r.value.domain.shoreIndex.byteLength,
            },
            mask: [...r.value.wetMask],
            bankMask: [...r.value.bankMask],
            shoreDistance: [...r.value.shoreDistance],
            cutVolume: r.value.cutVolume,
            fillVolume: r.value.fillVolume,
          }
        : { issues: r.issues }),
    });
  },
);
afterAll(() => {
  if (process.env.WATER_EVIDENCE_PATH)
    writeFileSync(
      process.env.WATER_EVIDENCE_PATH,
      JSON.stringify({ provenance: "constructed", cases: evidence }, null, 2) +
        "\n",
    );
});
// Break: bankMask used the original height after filling a valid bank.
test("bank mask uses final raised terrain, not original low ground", () => {
  const p = plan(
      { ...waterFixture(), level: 0.05, levelSource: "user", bankWidth: 0.8 },
      4,
      4,
    ),
    w = solved(p);
  expect(w.fillVolume).toBeGreaterThan(0);
  expect(w.bankMask.some(Boolean)).toBe(true);
  for (let i = 0; i < w.bankMask.length; i++)
    if (w.bankMask[i]) expect(w.field.heights[i]).toBeGreaterThanOrEqual(0.05);
});
test("patch nonzero shoreline error reports an uncertifiable domain instead of precision promotion", () => {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0.01;
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.3 ? -0.2 : 0.2;
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw),
    r = blocked(p, value(buildTerrain(p, stateFixture(), proxy)));
  if (!r.ok) expect(JSON.stringify(r.issues)).toMatch(/uncertain/);
});

test("none rejects corrupted terrain elevations rather than admitting a nonfinite scene", () => {
  const p = plan({ mode: "none" }),
    f = build(p);
  f.heights[0] = 3;
  blocked(p, f);
});
test("patch field transform must still match the input draft", () => {
  const proxy = terrainProxyFixture(),
    raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { mode: "none" };
  const p = parsePlanDraft(raw),
    f = value(buildTerrain(p, stateFixture(), proxy));
  f.transform = { ...f.transform!, position: [1, 0, 0] };
  blocked(p, f);
});
test("preserve certifies center depth between curve subdivision samples", () => {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0;
  for (let i = 0; i < 1681; i++) {
    const x = (i % 41) * 0.1 - 2;
    proxy.heights[i] = Math.abs(x) < 0.3 ? -0.1 : 0;
  }
  for (let x = 18; x <= 22; x++) proxy.heights[41 + x] = -0.1 + 1.05e-6;
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw);
  blocked(p, value(buildTerrain(p, stateFixture(), proxy)));
});

test("values outside the reshape band keep their exact Float32 bytes", () => {
  const p = plan({ ...waterFixture(), levelSource: "user" }),
    f = build(p);
  f.heights[0] = 0.1234567;
  f.normals = terrainNormals(f);
  const w = solved(p, f);
  expect(w.field.heights[0]).toBe(f.heights[0]);
});
// Break: quantization after the policy check may create forbidden positive fill.
test("cut-only never gains positive fill from rounding the final Float32 terrain", () => {
  const p = plan({
      ...waterFixture(),
      level: 0.1234567,
      reshapePolicy: "cut-only",
    }),
    f = build(p);
  f.heights.fill(0.1234567);
  f.normals = terrainNormals(f);
  const r = solveWater(p, f);
  if (r.ok) expect(r.value.fillVolume).toBe(0);
  else expect(JSON.stringify(r.issues)).toMatch(/water-policy/);
});

test("true cubic distance matches an independently bounded polyline reference and clone", () => {
  const w = solved(plan({ ...waterFixture(), controlPoints: S }));
  const points: [number, number][] = [
    [0, 0],
    [0.1, 0.2],
    [0.03, 1.013],
    [0, 4],
    [2.131, -1.07],
    [-4, 4],
  ];
  for (const [a, b] of w.domain.shore.filter(
    (_, i) => i % Math.max(1, Math.floor(w.domain.shore.length / 5)) === 0,
  )) {
    const x = (a[0] + b[0]) / 2,
      z = (a[1] + b[1]) / 2;
    if (Math.abs(x) < 3.99 && Math.abs(z) < 3.99)
      points.push([x, z], [x + 1e-6, z + 1e-6], [x - 1e-6, z - 1e-6]);
  }
  referenceShore(w, points);
});
// Break: one Float32 ULP cannot undo a larger 1e-6 quantization gap at tiny levels.
test("tiny explicit level keeps the actual half-width boundary dry", () => {
  const raw = terrainPlanFixture({
    width: 8,
    depth: 8,
    terrain: { elevation: 0.02 },
  });
  raw.water = { ...waterFixture(), level: 1e-7, levelSource: "user" };
  const w = solved(parsePlanDraft(raw)),
    i = 40 * w.field.nx + 43;
  expect(w.resolvedWater).toMatchObject({ level: 1e-7 });
  expect(w.field.heights[i]).toBeGreaterThanOrEqual(1e-7);
  expect(w.wetMask[i]).toBe(0);
});

// Fix round 1: assertions exercise the actual continuous field, not just nodes.
test("fix1 outer river support cannot change ground beyond a nonaligned bank edge", () => {
  const p = plan(
      { ...waterFixture(), level: 0.05, levelSource: "user", bankWidth: 0.85 },
      4,
      4,
    ),
    f = build(p),
    r = solveWater(p, f);
  if (!r.ok) {
    expect(JSON.stringify(r.issues)).toMatch(/water-reshape-support/);
    return;
  }
  expect(value(sampleTerrainWorld(r.value.field, 1.17, 0)).height).toBe(
    value(sampleTerrainWorld(f, 1.17, 0)).height,
  );
  expect(r.value.report.modifiedBounds!.max[0]).toBeLessThanOrEqual(1.15);
});
test("fix1 outer surface support cannot change ground beyond a nonaligned bank edge", () => {
  const p = plan(
      surface({
        polygon: [
          [-0.9, -0.9],
          [0.9, -0.9],
          [0.9, 0.9],
          [-0.9, 0.9],
        ],
        level: 0.05,
        levelSource: "user",
        levelStatus: "resolved",
        bankWidth: 0.85,
      }),
      4,
      4,
    ),
    f = build(p),
    r = solveWater(p, f);
  if (!r.ok) {
    expect(JSON.stringify(r.issues)).toMatch(/water-reshape-support/);
    return;
  }
  expect(value(sampleTerrainWorld(r.value.field, 1.77, 0)).height).toBe(
    value(sampleTerrainWorld(f, 1.77, 0)).height,
  );
  expect(r.value.report.modifiedBounds!.max[0]).toBeLessThanOrEqual(1.75);
});
test("fix1 inner offgrid river width must meet level and keep the exterior dry", () => {
  const p = plan({
      ...waterFixture(),
      width: 0.66,
      level: 0,
      levelSource: "user",
    }),
    r = solveWater(p, build(p));
  if (!r.ok) {
    expect(JSON.stringify(r.issues)).toMatch(/water-boundary/);
    return;
  }
  expect(value(sampleTerrainWorld(r.value.field, 0.33, 0)).height).toBe(0);
  expect(value(sampleWaterDomain(r.value, 0.35, 0)).wet).toBe(false);
});
test("fix1 inner offgrid surface edge must meet level and keep the exterior dry", () => {
  const p = plan(
      surface({
        polygon: [
          [-0.63, -0.63],
          [0.63, -0.63],
          [0.63, 0.63],
          [-0.63, 0.63],
        ],
        level: 0,
        levelSource: "user",
        levelStatus: "resolved",
      }),
    ),
    r = solveWater(p, build(p));
  if (!r.ok) {
    expect(JSON.stringify(r.issues)).toMatch(/water-boundary/);
    return;
  }
  expect(value(sampleTerrainWorld(r.value.field, 0.63, 0)).height).toBe(0);
  expect(value(sampleWaterDomain(r.value, 0.66, 0)).wet).toBe(false);
});
test("fix1 pending preserve retains the exact world min median max candidates", () => {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0;
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] =
      Math.abs((i % 41) * 0.1 - 2) < 0.29 ? 0.0200006 - 0.1 : 0.0200006;
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(true), reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw),
    f = value(buildTerrain(p, stateFixture(), proxy)),
    before = f.heights.slice(),
    w = solved(p, f);
  const high = terrainNodeWorld(f, 0)[1],
    low = terrainNodeWorld(f, 20)[1];
  expect(w.report.candidateLevels).toContain(high);
  expect(w.report.candidateLevels).toContain(low);
  expect(w.resolvedWater).toMatchObject({ level: high });
  expect(w.cutVolume + w.fillVolume).toBe(0);
  expect(f.heights).toEqual(before);
});

test("analytic source owns pre-water deformation bytes and preserves exterior queries", async () => {
  const p = plan({ ...waterFixture(), level: 0, levelSource: "user" });
  const f = build(p);
  for (let i = 0; i < f.heights.length; i++)
    f.heights[i] = 0.25 + 0.001 * (i % f.nx) + 0.0003 * Math.floor(i / f.nx);
  f.normals = terrainNormals(f);
  const before = await documentDigest(f),
    w = solved(p, f),
    model = w.field.heightModel;
  expect(model.kind).toBe("water-profile");
  if (model.kind !== "water-profile") return;
  expect(model.baseHeights).toEqual(f.heights);
  expect(model.baseHeights.buffer).not.toBe(f.heights.buffer);
  for (const [x, z] of [
    [1.17, 0.031],
    [-1.234, -0.731],
    [3.99, 2.231],
  ])
    expect(value(sampleTerrainWorld(w.field, x, z)).height).toBe(
      value(sampleTerrainWorld(f, x, z)).height,
    );
  expect(await documentDigest(f)).toBe(before);
  const clone = structuredClone(w);
  if (clone.domain.geometry?.mode !== "river")
    throw Error("Expected analytic river");
  clone.domain.geometry.radius += 0.01;
  const mismatch = sampleWaterDomain(clone, 0, 0);
  expect(mismatch.ok).toBe(false);
  if (!mismatch.ok) expect(mismatch.issues[0].code).toBe("water-binding");
  blocked(plan({ mode: "none" }), w.field, /water-input/);
});

test("water retains prior brush bytes rather than regenerating or applying brushes twice", () => {
  const p = plan({ ...waterFixture(), level: 0 }),
    state = stateFixture();
  state.brushes = [
    { ...brushFixture(), center: [1.5, 0], radius: 0.5, delta: 0.2 },
  ];
  const f = value(buildTerrain(p, state, null)),
    w = solved(p, f);
  expect(f.heights.some((v) => v > 0)).toBe(true);
  expect(w.field.heightModel.kind).toBe("water-profile");
  if (w.field.heightModel.kind === "water-profile")
    expect(w.field.heightModel.baseHeights).toEqual(f.heights);
  expect(value(sampleTerrainWorld(w.field, 1.5, 0)).height).toBe(
    value(sampleTerrainWorld(f, 1.5, 0)).height,
  );
});

// FIX2: a portal exempts only its terminal section, never its whole host edge.
test.each([
  [
    [0.1, 0],
    [1, 0.2],
  ],
  [
    [0.9, 0],
    [0, 0.2],
  ],
  [
    [0, 0.1],
    [0.2, 1],
  ],
])("fix2 rejects unsupported oblique lateral collar %j", (a, b) => {
  const p = plan(
    {
      ...waterFixture(),
      width: 0.41,
      bankWidth: 0.4,
      level: 0,
      controlPoints: [a, b],
    },
    10,
    10,
  );
  const r = solveWater(p, build(p));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues[0].code).toBe("water-bank");
});

test.each(["void", "valid-notch"] as const)(
  "fix2 preserve %s entering only the dry collar remains unsupported",
  (kind) => {
    const proxy = terrainProxyFixture();
    proxy.errorBound = 0;
    for (let i = 0; i < 1681; i++)
      proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.29 ? -0.1 : 0;
    // Shore x=.3. This obstruction starts at x=.42, touching no wet cell,
    // but removing part of the required .2 dry collar before x=.5.
    if (kind === "void")
      proxy.voidMask = [
        [
          [0.42, -0.18],
          [0.48, -0.18],
          [0.48, 0.18],
          [0.42, 0.18],
        ],
      ];
    else
      proxy.validPolygon = [
        [-2, -2],
        [2, -2],
        [2, -0.18],
        [0.42, -0.18],
        [0.42, 0.18],
        [2, 0.18],
        [2, 2],
        [-2, 2],
      ];
    const raw = terrainPlanFixture();
    raw.terrain = {
      source: "patch",
      assetRef: { id: "patch", contentVersion: "v1" },
      transform: proxy.transform,
    };
    raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
    const p = parsePlanDraft(raw),
      f = value(buildTerrain(p, stateFixture(), proxy));
    const r = blocked(p, f);
    if (!r.ok) expect(JSON.stringify(r.issues)).toMatch(/water-bank/);
    expect(f.heights).toEqual(proxy.heights);
  },
);

test("fix3 exact boundary-to-boundary triangular void cannot certify a dry collar", async () => {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0;
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.29 ? -0.1 : 0;
  proxy.voidMask = [
    [
      [0.4, 0.05],
      [0.45, 0],
      [0.5, 0.05],
    ],
  ];
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw),
    f = value(buildTerrain(p, stateFixture(), proxy));
  for (const [x, z] of [
    [0.4, 0],
    [0.5, 0],
    [0.5, 0.1],
    [0.4, 0.1],
  ])
    expect(sampleTerrainWorld(f, x, z).ok).toBe(true);
  expect(sampleTerrainWorld(f, 0.45, 0.025).ok).toBe(false);
  const before = await documentDigest({ p, f, proxy }),
    r = solveWater(p, f);
  expect(r.ok).toBe(false);
  if (!r.ok)
    expect(JSON.stringify(r.issues)).toMatch(/water-bank|water-support/);
  expect(await documentDigest({ p, f, proxy })).toBe(before);
});

test.each([
  {
    name: "closed void touches required collar",
    polygon: [
      [0.5, 0.05],
      [0.6, 0],
      [0.6, 0.1],
    ],
    success: false,
  },
  {
    name: "void crosses cell corners",
    polygon: [
      [0.4, 0],
      [0.5, 0.1],
      [0.5, 0],
    ],
    success: false,
  },
  {
    name: "remote boundary-to-boundary void leaves sufficient collar",
    polygon: [
      [0.7, 0.05],
      [0.75, 0],
      [0.8, 0.05],
    ],
    success: true,
  },
])("fix3 $name", async ({ polygon, success }) => {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0;
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.29 ? -0.1 : 0;
  proxy.voidMask = [polygon as [number, number][]];
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw),
    f = value(buildTerrain(p, stateFixture(), proxy)),
    before = await documentDigest({ p, f, proxy });
  const r = solveWater(p, f);
  expect(r.ok, JSON.stringify(r.ok ? r.value.report : r.issues)).toBe(success);
  if (r.ok) {
    expect(r.value.cutVolume + r.value.fillVolume).toBe(0);
    expect(r.value.report.minimumDryBank).toBeGreaterThanOrEqual(0.2);
  } else expect(JSON.stringify(r.issues)).toMatch(/water-bank|water-support/);
  expect(await documentDigest({ p, f, proxy })).toBe(before);
});

test("fix3 nonfinite or oversized support cannot enter exact rational preparation", () => {
  const proxy = terrainProxyFixture();
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw),
    f = value(buildTerrain(p, stateFixture(), proxy));
  const nonfinite = structuredClone(f);
  Reflect.set(nonfinite.patchSupport!.validPolygon[0], 0, NaN);
  const excessive = structuredClone(f);
  excessive.patchSupport!.voidMask = Array.from(
    { length: 129 },
    () => proxy.validPolygon,
  );
  for (const invalid of [nonfinite, excessive]) {
    const r = blocked(p, invalid);
    if (!r.ok) expect(r.issues[0].code).toBe("water-input");
  }
});

test("fix4 shared-query tolerance void cannot certify the exact reviewed dry collar", async () => {
  const proxy = terrainProxyFixture();
  proxy.errorBound = 0;
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.29 ? -0.1 : 0;
  proxy.voidMask = [
    [
      [0.5000000005, 0.05],
      [0.6, 0],
      [0.6, 0.1],
    ],
  ];
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw),
    f = value(buildTerrain(p, stateFixture(), proxy)),
    before = await documentDigest({ p, f, proxy });
  for (const [x, z] of [
    [0.4, 0],
    [0.5, 0],
    [0.5, 0.1],
    [0.4, 0.1],
  ])
    expect(sampleTerrainWorld(f, x, z).ok).toBe(true);
  const q = sampleTerrainWorld(f, 0.4999999999, 0.05);
  expect(q.ok).toBe(false);
  if (!q.ok) expect(q.issues[0].code).toBe("terrain-support");
  const r = solveWater(p, f);
  // Check parents before the expected RED assertion, so even the failing run
  // establishes that reproducing the defect did not mutate its inputs.
  expect(await documentDigest({ p, f, proxy })).toBe(before);
  expect(r.ok).toBe(false);
  if (!r.ok)
    expect(JSON.stringify(r.issues)).toMatch(/water-bank|water-support/);
});

function fix4Patch(proxy = terrainProxyFixture()) {
  proxy.errorBound = 0;
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = { ...waterFixture(), level: 0, reshapePolicy: "preserve" };
  const p = parsePlanDraft(raw);
  return { p, f: value(buildTerrain(p, stateFixture(), proxy)), proxy };
}

test("fix4 cell certificate rejects tolerance-only valid-notch corners", () => {
  const proxy = terrainProxyFixture();
  proxy.validPolygon = [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
    [-2, 0.1000000001],
    [0.5000000001, 0.1000000001],
    [0.5000000001, -1e-10],
    [-2, -1e-10],
  ];
  const { f } = fix4Patch(proxy);
  for (const [x, z] of [
    [0.4, 0],
    [0.5, 0],
    [0.5, 0.1],
    [0.4, 0.1],
  ])
    expect(sampleTerrainWorld(f, x, z).ok).toBe(true);
  expect(sampleTerrainWorld(f, 0.45, 0.05).ok).toBe(false);
  const valid = Uint8Array.from({ length: 1681 }, (_, i) => {
    const [x, , z] = terrainNodeWorld(f, i);
    return +sampleTerrainWorld(f, x, z).ok;
  });
  // This is the accepted-input LOCAL certificate counterexample. No assertion
  // claims that solving this entire notched patch used to succeed.
  expect(prepareSupportCells(f, valid)[824]).toBe(0);
});

test("fix4 cell certificate excludes a void surrounding a complete cell", () => {
  const proxy = terrainProxyFixture();
  proxy.voidMask = [
    [
      [0.2, -0.2],
      [0.7, -0.2],
      [0.7, 0.3],
      [0.2, 0.3],
    ],
  ];
  const { f } = fix4Patch(proxy);
  expect(sampleTerrainWorld(f, 0.45, 0.05).ok).toBe(false);
  // Deliberately bypass the optional early filter: boundary disjointness must
  // not certify a cell enclosed by a void even without reliable corner hints.
  expect(prepareSupportCells(f, new Uint8Array(1681).fill(1))[824]).toBe(0);
});

test("fix4 transposed reverse-winding query-band void rejects without input changes", async () => {
  const proxy = terrainProxyFixture();
  for (let i = 0; i < 1681; i++)
    proxy.heights[i] = Math.abs(Math.floor(i / 41) * 0.1 - 2) < 0.29 ? -0.1 : 0;
  proxy.voidMask = [
    [
      [0.1, 0.6],
      [0, 0.6],
      [0.05, 0.5000000005],
    ],
  ];
  proxy.errorBound = 0;
  const raw = terrainPlanFixture();
  raw.terrain = {
    source: "patch",
    assetRef: { id: "patch", contentVersion: "v1" },
    transform: proxy.transform,
  };
  raw.water = {
    ...waterFixture(),
    controlPoints: [
      [0, 0.5],
      [1, 0.5],
    ],
    level: 0,
    reshapePolicy: "preserve",
  };
  const p = parsePlanDraft(raw),
    f = value(buildTerrain(p, stateFixture(), proxy)),
    before = await documentDigest({ p, f, proxy });
  const q = sampleTerrainWorld(f, 0.05, 0.4999999999);
  expect(q.ok).toBe(false);
  if (!q.ok) expect(q.issues[0].code).toBe("terrain-support");
  const r = solveWater(p, f);
  expect(r.ok).toBe(false);
  if (!r.ok)
    expect(JSON.stringify(r.issues)).toMatch(/water-bank|water-support/);
  expect(await documentDigest({ p, f, proxy })).toBe(before);
});

test.each([false, true])(
  "fix4 full rectangular boundary retains every cell and dry bank reversed=%s",
  async (reversed) => {
    const proxy = terrainProxyFixture();
    if (reversed) proxy.validPolygon = [...proxy.validPolygon].reverse();
    for (let i = 0; i < 1681; i++)
      proxy.heights[i] = Math.abs((i % 41) * 0.1 - 2) < 0.29 ? -0.1 : 0;
    const { p, f } = fix4Patch(proxy),
      before = await documentDigest({ p, f, proxy });
    expect(
      prepareSupportCells(f, new Uint8Array(1681).fill(1)).every(
        (v) => v === 1,
      ),
    ).toBe(true);
    const r = solved(p, f);
    expect(r.report.minimumDryBank).toBeGreaterThanOrEqual(0.2);
    expect(r.report.dryAreaFraction).toBeGreaterThanOrEqual(0.25);
    expect(r.cutVolume + r.fillVolume).toBe(0);
    expect(await documentDigest({ p, f, proxy })).toBe(before);
  },
);

test("fix4 query rectangle covers rounded crossing beyond the stored endpoint and reflection", () => {
  // At the upper straddle endpoint: fl(1-1e16)=-1e16 and the ordered
  // expression returns 0, although the exact crossing is the stored x=1.
  // Merely expanding [1,1e16] by 1e-9 misses this computed crossing.
  const forward = supportQueryRectangle(
    [
      [1e16, 0],
      [1, 1],
    ],
    [-2, 2],
  );
  expect(forward.min[0]).toBe(0);
  expect(forward.max[0]).toBeGreaterThanOrEqual(1e16);
  const reflected = supportQueryRectangle(
    [
      [-1e16, 0],
      [-1, 1],
    ],
    [-2, 2],
  );
  expect(reflected.max[0]).toBe(0);
  expect(reflected.min[0]).toBeLessThanOrEqual(-1e16);
  // Include equality at the clipped straddle endpoint; do not make J open.
  expect(
    supportQueryRectangle(
      [
        [1e16, 0],
        [1, 1],
      ],
      [1, 2],
    ).min[0],
  ).toBe(0);
  const reversed = supportQueryRectangle(
    [
      [1, 1],
      [1e16, 0],
    ],
    [-2, 2],
  );
  expect(reversed.min[0]).toBeLessThanOrEqual(1);
  expect(reversed.max[0]).toBeGreaterThanOrEqual(1e16);
});

test.each([
  {
    name: "horizontal",
    edge: [
      [0, 0],
      [1, 0],
    ],
    point: [0.5, 0],
  },
  {
    name: "vertical descending",
    edge: [
      [0, 1],
      [0, -1],
    ],
    point: [0, 0],
  },
  {
    name: "subnormal product plateau",
    edge: [
      [0, 0],
      [Number.MIN_VALUE, Number.MIN_VALUE],
    ],
    point: [0, Number.MIN_VALUE],
  },
  {
    name: "signed zero",
    edge: [
      [-0, -1],
      [0, 1],
    ],
    point: [0, 0],
  },
])("fix4 query rectangle encloses $name crossings", ({ edge, point }) => {
  const r = supportQueryRectangle(
    edge as [[number, number], [number, number]],
    [-2, 2],
  );
  for (const k of [0, 1]) {
    expect(r.min[k]).toBeLessThanOrEqual(point[k]);
    expect(r.max[k]).toBeGreaterThanOrEqual(point[k]);
  }
});

test("fix4 query rectangle skips an empty straddle and clips before ray evaluation", () => {
  // dx overflows but there is no straddle in the grid, hence no ray obligation.
  const remote = supportQueryRectangle(
    [
      [-1e308, 3],
      [1e308, 4],
    ],
    [-2, 2],
  );
  expect(remote.min[1]).toBeGreaterThan(2);
  // The far endpoint would overflow dx*(z-az); the clipped interval does not.
  const clipped = supportQueryRectangle(
    [
      [0, 0],
      [1e308, 4],
    ],
    [-1, 1],
  );
  expect(clipped.max[0]).toBeGreaterThanOrEqual(1e308);
});

test.each([
  {
    name: "finite endpoint difference overflow",
    edge: [
      [-1e308, 0],
      [1e308, 1],
    ],
  },
  {
    name: "finite ordered product overflow",
    edge: [
      [0, -1],
      [1e308, 1],
    ],
  },
])("fix4 $name fails with typed inability to certify", ({ edge }) => {
  try {
    supportQueryRectangle(
      edge as [[number, number], [number, number]],
      [-2, 2],
    );
    expect.fail("Expected a support arithmetic rejection");
  } catch (e) {
    expect(e).toMatchObject({ code: "water-support-precision" });
  }
});

test("fix4 accepted finite polygon with overflowing axis difference cannot receive a support certificate", () => {
  const proxy = terrainProxyFixture();
  // Its area products remain finite, so T6 accepts the polygon. Its horizontal
  // endpoint subtraction overflows; certifying 0*Infinity at boundary is unsafe.
  proxy.validPolygon = [
    [-1e308, -1e-308],
    [1e308, -1e-308],
    [1e308, 1e-308],
    [-1e308, 1e-308],
  ];
  const { p, f } = fix4Patch(proxy);
  const r = solveWater(p, f);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues[0].code).toBe("water-support-precision");
});
