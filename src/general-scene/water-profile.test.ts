import { expect, test } from "vitest";
import {
  profileGeometry,
  certifyRiverStrip,
  profileDistance,
  evaluateWaterProfile,
} from "./water-profile.ts";
const water = {
  mode: "river",
  waterId: "river",
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
} as const;
const grid = { width: 4, depth: 4, spacing: 0.1, nx: 41, nz: 41 };
const model = () => ({
  kind: "water-profile" as const,
  version: 1 as const,
  baseHeights: new Float32Array(1681),
  water,
});
test("analytic source meets the exact offgrid half width and preserves continuous exterior", () => {
  const m = model();
  expect(evaluateWaterProfile(grid, m, 0.33, 0).height).toBe(0.05);
  expect(evaluateWaterProfile(grid, m, 1.19, 0).height).toBe(0);
  expect(evaluateWaterProfile(grid, m, 0, 0).height).toBe(-0.05);
  expect(evaluateWaterProfile(grid, m, 0.35, 0).height).toBeGreaterThan(0.05);
});
test("true cubic distance bounds contain independent exact curve witnesses and survive clone", () => {
  const w = {
    ...water,
    controlPoints: [
      [0.5, 0],
      [0.56, 0.3],
      [0.44, 0.7],
      [0.5, 1],
    ] as const,
  };
  const g = profileGeometry(w, grid),
    clone = structuredClone(g);
  if (g.mode !== "river") throw Error("Expected river");
  const b = g.cubics[1],
    t = 0.37,
    u = 1 - t;
  const p: [number, number] = [
    u * u * u * b[0][0] +
      3 * u * u * t * b[1][0] +
      3 * u * t * t * b[2][0] +
      t * t * t * b[3][0],
    u * u * u * b[0][1] +
      3 * u * u * t * b[1][1] +
      3 * u * t * t * b[2][1] +
      t * t * t * b[3][1],
  ];
  const q = profileDistance(g, p),
    r = profileDistance(clone, p);
  expect(q).toEqual(r);
  expect(q.lower).toBeLessThanOrEqual(-w.width / 2);
  expect(q.upper).toBeGreaterThanOrEqual(-w.width / 2);
  expect(q.upper - q.lower).toBeLessThan(1e-8);
  expect(q.error).toBeGreaterThan(0);
});
test("normal uses the analytic gradient rather than a cache interpolation", () => {
  const m = model(),
    x = 0.45,
    z = 0.023,
    h = 1e-5;
  const q = evaluateWaterProfile(grid, m, x, z);
  const dx =
    (evaluateWaterProfile(grid, m, x + h, z).height -
      evaluateWaterProfile(grid, m, x - h, z).height) /
    (2 * h);
  expect(-q.normal[0] / q.normal[1]).toBeCloseTo(dx, 6);
  expect(q.worldError).toBeGreaterThan(0);
  expect(q.slopeBound).toBeGreaterThanOrEqual(Math.abs(dx));
});
test("nonaligned surface shore and outer support use the same analytic source", () => {
  const { controlPoints: _, width: __, ...common } = water;
  const m = {
    ...model(),
    water: {
      ...common,
      mode: "surface" as const,
      polygon: [
        [-0.63, -0.63],
        [0.63, -0.63],
        [0.63, 0.63],
        [-0.63, 0.63],
      ] as const,
    },
  };
  expect(evaluateWaterProfile(grid, m, 0.63, 0).height).toBe(0.05);
  expect(evaluateWaterProfile(grid, m, 1.49, 0).height).toBe(0);
  expect(
    profileDistance(profileGeometry(m.water, grid), [0.66, 0]).lower,
  ).toBeGreaterThan(0);
});

test("curved boundary witnesses retain nominal display data while strict classification can be uncertain", async () => {
  const { profileBoundaryWitness } = await import("./water-profile.ts");
  const w = {
    ...water,
    controlPoints: [
      [0.5, 0],
      [0.56, 0.3],
      [0.44, 0.7],
      [0.5, 1],
    ] as const,
  };
  const g = profileGeometry(w, grid),
    witness = profileBoundaryWitness(g, 1, 0.371, 1);
  const q = profileDistance(g, witness.point);
  expect(Math.abs(q.signed)).toBeLessThanOrEqual(
    q.error + witness.coordinateError,
  );
  expect(witness.coordinateError).toBeGreaterThan(0);
  const h = evaluateWaterProfile(
    grid,
    { ...model(), water: w },
    ...witness.point,
  );
  expect(Math.abs(h.height - w.level)).toBeLessThanOrEqual(h.worldError);
  expect(h.normal.every(Number.isFinite)).toBe(true);
  expect(["boundary", "uncertain"]).toContain(q.classification);
});

test("one-sided display normal at a grid seam still bounds both incident slopes", () => {
  const m = model();
  for (let z = 0; z < 41; z++) m.baseHeights[z * 41 + 31] = 0.5;
  const q = evaluateWaterProfile(grid, m, 1.2, 0);
  expect(q.normal).toEqual([-0, 1, -0]);
  expect(q.slopeBound).toBeGreaterThanOrEqual(5);
});

test("fix2 full-strip certificate keeps structural normal endpoints and true curved interiors", () => {
  const geometry = profileGeometry(
    {
      ...water,
      controlPoints: [
        [0.5, 0],
        [0.5, 0.2],
        [0.56, 0.4],
        [0.44, 0.6],
        [0.5, 0.8],
        [0.5, 1],
      ],
    },
    { width: 8, depth: 8 },
  );
  if (geometry.mode !== "river") throw Error("river");
  const proof = certifyRiverStrip(geometry, { width: 8, depth: 8 }, 0.2);
  expect(proof.ok).toBe(true);
  expect(proof.work).toBeLessThanOrEqual(4096);
  expect(
    certifyRiverStrip(structuredClone(geometry), { width: 8, depth: 8 }, 0.2),
  ).toEqual(proof);
});
test("fix2 normal endpoints do not exempt an interior return to their host edge", () => {
  const geometry = profileGeometry(
    {
      ...water,
      controlPoints: [
        [0.2, 0],
        [0.2, 0.2],
        [0.5, 0.01],
        [0.8, 0.2],
        [0.8, 0.8],
        [0.8, 1],
      ],
    },
    { width: 10, depth: 10 },
  );
  if (geometry.mode !== "river") throw Error("river");
  expect(geometry.cubics[0][0][0]).toBe(geometry.cubics[0][1][0]);
  expect(geometry.cubics.at(-1)![2][0]).toBe(geometry.cubics.at(-1)![3][0]);
  const proof = certifyRiverStrip(geometry, { width: 10, depth: 10 }, 0.2);
  expect(proof.ok).toBe(false);
  expect(proof.work).toBeLessThanOrEqual(4096);
});
