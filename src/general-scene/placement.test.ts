import { expect, test } from "vitest";
import { buildFixture } from "../../tests/support/general-build-fixture";
import { buildTerrain } from "./terrain";
import { solveWater } from "./water";
import { parseScenePlan, parseEditableState } from "./contracts";
import { placeInstances } from "./placement";
import type { Result } from "./core";
const value = <T>(r: Result<T>): T => {
  if (!r.ok) throw Error(JSON.stringify(r.issues));
  return r.value;
};
async function setup(options: Parameters<typeof buildFixture>[0] = {}) {
  const f = await buildFixture(options);
  const solution = value(
    solveWater(
      f.draft,
      value(
        buildTerrain(
          f.draft,
          f.state,
          f.assets.find((a) => a.patch)?.patch ?? null,
        ),
      ),
    ),
  );
  return {
    ...f,
    solution,
    plan: parseScenePlan({ ...f.draft, water: solution.resolvedWater }),
  };
}
test("places rock grass reed reproducibly with independent slots", async () => {
  const f = await setup({ categories: ["rock", "grass", "reed"] });
  const a = value(placeInstances(f.plan, f.solution, f.assets, f.state, []));
  const b = value(placeInstances(f.plan, f.solution, f.assets, f.state, []));
  expect(a.instances).toEqual(b.instances);
  expect(a.instances).toHaveLength(3);
  expect(new Set(a.instances.map((i) => i.instanceId)).size).toBe(3);
});
test("rejects a large anchored footprint whose center is dry but edge enters water", async () => {
  const f = await setup({ river: true, radius: 0.35, anchor: 1 });
  const transform = {
    position: [0.6, 0.015, 0] as const,
    quaternion: [0, 0, 0, 1] as const,
    scale: 1,
  };
  const frozen = [
    {
      instanceId: "rock:0",
      groupId: "rock",
      assetRef: f.plan.groups[0].assetRef,
      transform,
      locked: true,
    },
  ];
  const state = parseEditableState({
    ...f.state,
    groups: [{ groupId: "rock", nextSlot: 1, retired: false }],
    lockedInstanceIds: ["rock:0"],
  });
  const r = placeInstances(f.plan, f.solution, f.assets, state, frozen);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("water");
  expect(frozen[0].transform).toEqual(transform);
});
test("stops exactly at 300 per slot and 6000 total with actual group deficits", async () => {
  const f = await setup({ count: 20, radius: 1 });
  const plan = parseScenePlan({
    ...f.plan,
    regions: [
      {
        regionId: "all",
        shape: { kind: "rectangle", min: [-0.01, -0.01], max: [0.01, 0.01] },
      },
    ],
  });
  const r = value(placeInstances(plan, f.solution, f.assets, f.state, []));
  expect(r.instances).toHaveLength(0);
  expect(r.shortfall.rock).toBe(20);
  expect(r.attempts).toBe(6000);
  expect(r.rejections.boundary).toBe(6000);
});
function fixed(f: Awaited<ReturnType<typeof setup>>, x = 0, z = 0, y = 0.015) {
  const instance = {
    instanceId: "rock:0",
    groupId: "rock",
    assetRef: f.plan.groups[0].assetRef,
    transform: {
      position: [x, y, z] as const,
      quaternion: [0, 0, 0, 1] as const,
      scale: 1,
    },
    locked: true,
  };
  const state = parseEditableState({
    ...f.state,
    groups: [{ groupId: "rock", nextSlot: 1, retired: false }],
    lockedInstanceIds: ["rock:0"],
  });
  return { instance, state };
}
test("rejects a steep cell inside the footprint although the center is flat", async () => {
  const f = await setup({ radius: 0.25 });
  const { instance, state } = fixed(f);
  const field = f.solution.field;
  field.heights[22 * field.nx + 22] = 0.15;
  const r = placeInstances(f.plan, f.solution, f.assets, state, [instance]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues[0].code).toBe("slope");
});
test.each([
  [-0.0200001, false],
  [-0.02, true],
  [0.05, true],
  [0.0500001, false],
])("contact exact boundary y=%s accepted=%s", async (y, expected) => {
  const f = await setup();
  const { instance, state } = fixed(f, 0, 0, y);
  const r = placeInstances(f.plan, f.solution, f.assets, state, [instance]);
  expect(r.ok).toBe(expected);
  if (!r.ok) expect(r.issues[0].code).toBe("support");
});
test("unknown support error is rejected", async () => {
  const f = await setup();
  f.solution.field.proxyError = NaN;
  const { instance, state } = fixed(f);
  const r = placeInstances(f.plan, f.solution, f.assets, state, [instance]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues[0].code).toBe("support");
});
test("interior scan void is rejected while a remote void leaves ordinary placements valid", async () => {
  const f = await setup({ patch: true, radius: 0.2 });
  const { instance, state } = fixed(f);
  f.solution.field.patchSupport!.voidMask = [
    [
      [0.08, 0.08],
      [0.1, 0.08],
      [0.1, 0.1],
      [0.08, 0.1],
    ],
  ];
  let r = placeInstances(f.plan, f.solution, f.assets, state, [instance]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues[0].code).toBe("void");
  f.solution.field.patchSupport!.voidMask = [
    [
      [1, 1],
      [1.1, 1],
      [1.1, 1.1],
      [1, 1.1],
    ],
  ];
  r = placeInstances(f.plan, f.solution, f.assets, state, [instance]);
  expect(r.ok).toBe(true);
});
test("locked instances occupy space first and stay exact across rebuild", async () => {
  const f = await setup({ count: 3 });
  const a = value(placeInstances(f.plan, f.solution, f.assets, f.state, []));
  const first = { ...a.instances[0], locked: true };
  const state = parseEditableState({
    ...a.state,
    lockedInstanceIds: [first.instanceId],
  });
  const b = value(placeInstances(f.plan, f.solution, f.assets, state, [first]));
  expect(b.instances.find((i) => i.instanceId === first.instanceId)).toEqual(
    first,
  );
  expect(new Set(b.instances.map((i) => i.instanceId))).toEqual(
    new Set(a.instances.map((i) => i.instanceId)),
  );
  for (const i of b.instances.slice(1))
    expect(
      Math.hypot(
        i.transform.position[0] - first.transform.position[0],
        i.transform.position[2] - first.transform.position[2],
      ),
    ).toBeGreaterThanOrEqual(Math.SQRT2 * 0.1 + 0.1);
});
test.each([{ slope: 8 }, { river: true }])(
  "ordinary small footprints remain placeable on %s",
  async (options) => {
    const f = await setup({
      ...options,
      categories: ["rock", "grass", "reed"],
    });
    expect(
      value(placeInstances(f.plan, f.solution, f.assets, f.state, []))
        .instances,
    ).toHaveLength(3);
  },
);

test("an explicitly admitted 20-degree fixed patch slope is not limited by the default 15 degrees", async () => {
  const f = await setup({ patch: true, patchSlope: 20, maxPlacementSlope: 25 });
  const r = value(placeInstances(f.plan, f.solution, f.assets, f.state, []));
  expect(r.instances).toHaveLength(1);
  const strict = parseScenePlan({
    ...f.plan,
    groups: f.plan.groups.map((g) => ({
      ...g,
      placementPolicy: { ...g.placementPolicy, maxSlopeDegrees: 15 },
    })),
  });
  const no = value(placeInstances(strict, f.solution, f.assets, f.state, []));
  expect(no.instances).toHaveLength(0);
  expect(no.rejections.slope).toBeGreaterThan(0);
});

test("nonfinite frozen support cannot bypass the exported placement boundary", async () => {
  const f = await setup();
  const { instance, state } = fixed(f, 0, 0, NaN);
  expect(
    placeInstances(f.plan, f.solution, f.assets, state, [instance]).ok,
  ).toBe(false);
});

test("raw fixed-D yaw/scale and rotated usable boundary preserve a legal interior footprint", async () => {
  const f = await setup({ patch: true, radius: 0.05 });
  const t = {
    position: [0.25, 0.2, -0.15] as const,
    quaternion: [
      0,
      Math.sin(Math.PI / 8) * 1.0000005,
      0,
      Math.cos(Math.PI / 8) * 1.0000005,
    ] as const,
    scale: 1.1,
  };
  const proxy = structuredClone(f.assets.find((a) => a.patch)!.patch!);
  proxy.transform = t;
  proxy.validPolygon = [
    [-1.2, -1.2],
    [1.2, -1.2],
    [1.2, 1.2],
    [-1.2, 1.2],
  ];
  proxy.voidMask = [
    [
      [0.8, 0.8],
      [0.9, 0.8],
      [0.9, 0.9],
      [0.8, 0.9],
    ],
  ];
  const plan = parseScenePlan({
    ...f.plan,
    terrain: { ...f.plan.terrain, transform: t },
  });
  const solution = value(
    solveWater(plan, value(buildTerrain(plan, f.state, proxy))),
  );
  const { instance, state } = fixed(
    f,
    t.position[0],
    t.position[2],
    t.position[1] + 0.015,
  );
  expect(placeInstances(plan, solution, f.assets, state, [instance]).ok).toBe(
    true,
  );
  const c = 1 - 2 * t.quaternion[1] ** 2,
    q = 2 * t.quaternion[1] * t.quaternion[3];
  const edge = {
    ...instance,
    transform: {
      ...instance.transform,
      position: [
        t.position[0] + 1.19 * t.scale * c,
        t.position[1] + 0.015,
        t.position[2] - 1.19 * t.scale * q,
      ] as const,
    },
  };
  const rejected = placeInstances(plan, solution, f.assets, state, [edge]);
  expect(rejected.ok).toBe(false);
  if (!rejected.ok)
    expect(rejected.issues.some((i) => i.code === "boundary")).toBe(true);
});

test("a large frozen replacement participates in spatial search beyond group defaults", async () => {
  const f = await buildFixture({
    count: 2,
    unusedVariant: true,
    variantRadius: 1.5,
  });
  const plan = parseScenePlan({
    ...f.draft,
    domain: { ...f.draft.domain, width: 10, depth: 10 },
    regions: [
      {
        regionId: "all",
        shape: { kind: "rectangle", min: [-5, -5], max: [5, 5] },
      },
    ],
  });
  const solution = value(
    solveWater(plan, value(buildTerrain(plan, f.state, null))),
  );
  const variant = f.assets.find((a) =>
    a.manifest.id.endsWith("-variant"),
  )!.manifest;
  const state = parseEditableState({
    ...f.state,
    groups: [{ groupId: "rock", nextSlot: 2, retired: false }],
    lockedInstanceIds: ["rock:0", "rock:1"],
  });
  const transform = (x: number) => ({
    position: [x, 0.015, 0] as const,
    quaternion: [0, 0, 0, 1] as const,
    scale: 1,
  });
  const frozen = [
    {
      instanceId: "rock:0",
      groupId: "rock",
      assetRef: { id: variant.id, contentVersion: variant.contentVersion },
      transform: transform(-2),
      locked: true,
    },
    {
      instanceId: "rock:1",
      groupId: "rock",
      assetRef: plan.groups[0].assetRef,
      transform: transform(0),
      locked: true,
    },
  ];
  const fixedState = parseEditableState({
    ...state,
    overrides: [
      {
        instanceId: frozen[0].instanceId,
        groupId: "rock",
        kind: "replace",
        assetRef: frozen[0].assetRef,
        transform: frozen[0].transform,
      },
    ],
  });
  const rejected = placeInstances(plan, solution, f.assets, fixedState, frozen);
  expect(rejected.ok).toBe(false);
  if (!rejected.ok)
    expect(
      rejected.issues.some((i) => i.code === "spacing"),
      JSON.stringify(rejected),
    ).toBe(true);
  frozen[1].transform = transform(1);
  expect(placeInstances(plan, solution, f.assets, fixedState, frozen).ok).toBe(
    true,
  );
});
