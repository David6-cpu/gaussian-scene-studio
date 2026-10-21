import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  acquireBuildInputs,
  buildOwnedBytes,
  compileScene,
  proposePreparedPatch,
  resolvePlan,
  storedResultsToRenderPacket,
  surfaceTilePayloadDigest,
  type PatchProposal,
} from "./compile";
import { previewPatch, proposePatch, type PatchContext } from "./patch";
import {
  parseEditableState,
  parsePatch,
  parsePlanDraft,
  parseSnapshot,
  type EditableSnapshot,
  type Polygon,
  type ScenePatch,
} from "./contracts";
import { canonicalJson, documentDigest } from "./canonical";
import { encodeGeneralArchive, decodeGeneralArchive } from "./archive";
import { footprintInPolygon, instanceEnvelope } from "./placement";
import type { AssetLibrary } from "./asset-library";
import { createBuildClient, type BuildClient } from "./worker-client";
import type { Result } from "./core";
import { buildFixture } from "../../tests/support/general-build-fixture";

const value = <T>(r: Result<T>): T => {
  expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
  if (!r.ok) throw Error(JSON.stringify(r.issues));
  return r.value;
};
const box = (x: number, z: number, radius: number): Polygon => [
  [x - radius, z - radius],
  [x + radius, z - radius],
  [x + radius, z + radius],
  [x - radius, z + radius],
];
const ref = (f: Awaited<ReturnType<typeof buildFixture>>, index = 0) => ({
  id: f.assets[index].manifest.id,
  contentVersion: f.assets[index].manifest.contentVersion,
});
function context(base: EditableSnapshot, suffix = "edit"): PatchContext {
  return {
    operationId: suffix,
    baseRevisionId: base.revisionId,
    sceneId: base.sceneId,
    revisionId: `${suffix}-revision`,
    signal: new AbortController().signal,
    resources: { retainedBytes: 0 },
  };
}
function patch(
  base: EditableSnapshot,
  operations: ScenePatch["operations"],
  region: Polygon = box(-2, -2, 0.8),
  suffix = "edit",
): ScenePatch {
  const targets = [
    ...new Set(
      operations.flatMap((o) => ("instanceId" in o ? [o.instanceId] : [])),
    ),
  ];
  return parsePatch({
    documentType: "general-scene-patch",
    schemaVersion: 1,
    patchId: suffix,
    baseRevisionId: base.revisionId,
    raw: "Constructed local edit",
    requestedRegion: region,
    effectiveRegion: region,
    targetInstanceIds: targets,
    lockedInstanceIds: base.state.lockedInstanceIds,
    affectedInstanceIds: targets,
    affectedTileIds: [],
    operations,
    review: {
      scopeAccepted: false,
      planDigest: "0".repeat(64),
      catalogDigest: base.plan.catalogDigest,
      assetBindings: [],
    },
  });
}
function accepted(p: PatchProposal): ScenePatch {
  return parsePatch({
    ...p.patch,
    review: { ...p.patch.review, scopeAccepted: true },
  });
}
/** Unit adapter runs the production CPU functions. Browser coverage exercises the real worker. */
function directClient(): BuildClient {
  let retained: AssetLibrary | null = null;
  return {
    propose: vi.fn(async (base, edit, library, ctx) => {
      retained = library;
      const inputs = await acquireBuildInputs(
        base.plan,
        base.state,
        library,
        ctx.signal,
        ctx.resources,
        { patch: edit, baseSnapshot: base },
      );
      return proposePreparedPatch(base, edit, inputs, ctx);
    }),
    resolve: vi.fn(async (draft, state, library, ctx) => {
      retained = library;
      return resolvePlan(
        draft,
        state,
        library,
        ctx.signal,
        ctx.resources,
        ctx.dependencies,
      );
    }),
    build: vi.fn(compileScene),
    operationLibrary: vi.fn(() => retained),
    activity: vi.fn(() => ({ busy: false, preparing: false })),
    whenPreparationSettled: vi.fn(async () => {}),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
}
function untouchedClient(): BuildClient {
  const unexpected = () => {
    throw Error("Unexpected BuildClient call");
  };
  return {
    propose: vi.fn(unexpected),
    resolve: vi.fn(unexpected),
    build: vi.fn(unexpected),
    operationLibrary: vi.fn(unexpected),
    activity: vi.fn(() => ({ busy: false, preparing: false })),
    whenPreparationSettled: vi.fn(async () => {}),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
}
function expectNoBuildCalls(client: BuildClient) {
  for (const method of [
    client.propose,
    client.resolve,
    client.build,
    client.operationLibrary,
  ])
    expect(method).not.toHaveBeenCalled();
}
async function compileFixture(
  options: Parameters<typeof buildFixture>[0] = {},
  arranged = false,
  locked = false,
) {
  const f = await buildFixture(options);
  if (arranged) {
    f.draft = parsePlanDraft({
      ...f.draft,
      domain: { ...f.draft.domain, width: 8, depth: 8 },
      terrain: { ...f.draft.terrain, spacing: 0.2 },
      regions: [
        {
          regionId: "all",
          shape: { kind: "rectangle", min: [-4, -4], max: [4, 4] },
        },
      ],
    });
    // The second valid support interval starts near its lower bound so a small
    // peripheral brush forces reattachment rather than leaving a feasible Y unchanged.
    const coordinates = [
      [-2, -2],
      [-1.6, -2],
      [-2, 2],
      [2, -2],
      [2, 2],
      [0, 2],
    ];
    f.state = parseEditableState({
      ...f.state,
      groups: [{ groupId: "rock", nextSlot: 6, retired: false }],
      lockedInstanceIds: locked ? ["rock:0"] : [],
      overrides: coordinates.map(([x, z], i) => ({
        instanceId: `rock:${i}`,
        groupId: "rock",
        kind: "move",
        assetRef: ref(f),
        transform: {
          position: [x, i === 1 ? -0.019 : 0.015, z],
          quaternion: [0, 0, 0, 1],
          scale: 1,
        },
      })),
    });
  }
  const resolved = value(
    await resolvePlan(
      f.draft,
      f.state,
      f.library,
      f.context.signal,
      f.context.resources,
    ),
  );
  const base = value(
    await compileScene(
      resolved,
      f.state,
      f.assets.filter((a) =>
        resolved.sourceEvidence.members.some(
          (m) => m.assetRef.id === a.manifest.id,
        ),
      ),
      f.context,
    ),
  ).snapshot;
  return { f, base };
}
let standard: Awaited<ReturnType<typeof compileFixture>>;
beforeAll(async () => {
  standard = await compileFixture({ count: 6, unusedVariant: true }, true);
});
afterEach(() => vi.restoreAllMocks());
async function preview(
  base: EditableSnapshot,
  edit: ScenePatch,
  library = standard.f.library,
) {
  const client = directClient(),
    ctx = context(base, edit.patchId);
  const proposed = value(await proposePatch(base, edit, library, ctx, client));
  return {
    proposed,
    client,
    out: value(
      await previewPatch(base, accepted(proposed), library, ctx, client),
    ),
  };
}
function outside(base: EditableSnapshot, region: Polygon) {
  return base.instances.filter((i) => {
    const manifest = base.assets.find(
      (a) => canonicalJson(a.assetRef) === canonicalJson(i.assetRef),
    )!.manifest;
    if (manifest.kind !== "object") throw Error("Expected object");
    const e = instanceEnvelope(manifest, i.transform);
    return !footprintInPolygon(region, e.center, e.radius + 0.1);
  });
}

// Entry gates must fail before even asking the build client for a proposal.
test("rejects legacy snapshots before compilation", async () => {
  const { f, base } = standard,
    client = untouchedClient();
  const legacy = parseSnapshot({
    ...structuredClone(base),
    capability: "legacy-readonly",
    intent: null,
    plan: null,
    state: null,
    originVersion: "legacy-v1",
    original: { digest: "a".repeat(64), bytes: new Uint8Array([1, 2, 3]) },
  });
  const out = await previewPatch(
    legacy,
    patch(base, [{ kind: "remove", instanceId: "rock:0" }]),
    f.library,
    context(base),
    client,
  );
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.issues[0].message).toMatch(/legacy.*read.only/i);
  expectNoBuildCalls(client);
});
test.each(["unaccepted", "stale", "unknown-version"])(
  "rejects %s before build work",
  async (mode) => {
    const { f, base } = standard,
      client = untouchedClient();
    const edit = patch(base, [{ kind: "remove", instanceId: "rock:0" }]);
    const input =
      mode === "unknown-version" ? { ...base, schemaVersion: 99 } : base;
    const ctx = context(base);
    if (mode === "stale") ctx.baseRevisionId = "newer-revision";
    expect(
      (
        await previewPatch(
          input as EditableSnapshot,
          edit,
          f.library,
          ctx,
          client,
        )
      ).ok,
    ).toBe(false);
    expectNoBuildCalls(client);
  },
);
test("rejects a known retained-memory overrun before cloning or build work", async () => {
  const { f, base } = standard,
    client = untouchedClient();
  const edit = patch(base, [{ kind: "remove", instanceId: "rock:0" }]);
  const clone = vi.spyOn(globalThis, "structuredClone"),
    ctx = context(base);
  ctx.resources.retainedBytes = 256 * 1024 ** 2;
  const out = await proposePatch(base, edit, f.library, ctx, client);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.issues[0].code).toBe("budget");
  expect(
    clone.mock.calls.every(([input]) => buildOwnedBytes(input) === 0),
  ).toBe(true);
  expectNoBuildCalls(client);
});
test("offers an unaccepted local proposal without compiling a candidate", async () => {
  const { f, base } = standard,
    client = directClient(),
    before = await documentDigest(base);
  const p = value(
    await proposePatch(
      base,
      patch(base, [
        { kind: "add", groupId: "rock", assetRef: ref(f), count: 1 },
      ]),
      f.library,
      context(base),
      client,
    ),
  );
  expect(p.patch.review.scopeAccepted).toBe(false);
  expect(p.changedInstanceIds).toEqual(["rock:6"]);
  expect(p.plan.groups[0].count).toBe(7);
  expect(p.instances).toHaveLength(7);
  expect(p.patch.review.planDigest).toBe(await documentDigest(p.plan));
  expect(p.effectiveRegion).toEqual(p.requestedRegion);
  expect(client.resolve).not.toHaveBeenCalled();
  expect(client.build).not.toHaveBeenCalled();
  expect(await documentDigest(base)).toBe(before);
});
test.each(["add", "remove", "move", "replace", "set-count"] as const)(
  "%s preserves complete records outside R and does not mutate its parent",
  async (kind) => {
    const { f, base } = standard,
      old = base.instances.find((i) => i.instanceId === "rock:0")!;
    const operations: ScenePatch["operations"] =
      kind === "add"
        ? [{ kind, groupId: "rock", assetRef: ref(f), count: 1 }]
        : kind === "set-count"
          ? [{ kind, groupId: "rock", count: 1 }]
          : kind === "move"
            ? [
                {
                  kind,
                  instanceId: old.instanceId,
                  transform: { ...old.transform, position: [-2.1, 0.015, -2] },
                },
              ]
            : kind === "replace"
              ? [{ kind, instanceId: old.instanceId, assetRef: ref(f, 1) }]
              : [{ kind, instanceId: old.instanceId }];
    const before = await documentDigest(base),
      edit = patch(base, operations, box(-2, -2, 0.8), kind);
    const { proposed, out } = await preview(base, edit);
    const frozen = outside(base, proposed.requestedRegion);
    expect(frozen.length).toBeGreaterThan(0);
    expect(proposed.effectiveRegion).toEqual(proposed.requestedRegion);
    expect(out.changedTileIds).toEqual([]);
    for (const i of frozen)
      expect(
        out.compiled.snapshot.instances.find(
          (n) => n.instanceId === i.instanceId,
        ),
      ).toEqual(i);
    expect(out.compiled.snapshot.surfaces).toEqual(base.surfaces);
    expect(out.compiled.snapshot.terrain).toEqual(base.terrain);
    expect(await documentDigest(base)).toBe(before);
    if (kind === "move")
      expect(
        out.compiled.snapshot.instances.find(
          (i) => i.instanceId === old.instanceId,
        )!.transform,
      ).toEqual(
        (
          operations[0] as Extract<
            ScenePatch["operations"][number],
            { kind: "move" }
          >
        ).transform,
      );
    if (kind === "replace") {
      expect(
        out.compiled.snapshot.instances.find(
          (i) => i.instanceId === old.instanceId,
        )!.assetRef,
      ).toEqual(ref(f, 1));
      expect(out.compiled.snapshot.plan.groups[0].assetRef).toEqual(
        base.plan.groups[0].assetRef,
      );
    }
    if (kind === "set-count") {
      expect(out.compiled.snapshot.instances).toHaveLength(5);
      expect(out.compiled.snapshot.state.tombstones).toContain("rock:1");
      expect(
        out.compiled.snapshot.instances.some((i) => i.instanceId === "rock:0"),
      ).toBe(true);
      expect(out.compiled.snapshot.plan.review.fieldSources).toContainEqual(
        expect.objectContaining({
          key: "manual-group-count",
          value: { groupId: "rock", count: 5 },
        }),
      );
    }
  },
);
test("expands an undersized move request to include both complete footprints and requires fresh acceptance", async () => {
  const { f, base } = standard,
    old = base.instances[0],
    client = directClient(),
    ctx = context(base);
  const edit = patch(
    base,
    [
      {
        kind: "move",
        instanceId: old.instanceId,
        transform: { ...old.transform, position: [-2.3, 0.015, -2] },
      },
    ],
    box(-2, -2, 0.01),
  );
  const p = value(await proposePatch(base, edit, f.library, ctx, client));
  expect(p.requestedRegion).not.toEqual(edit.requestedRegion);
  expect(p.effectiveRegion).toEqual(p.requestedRegion);
  expect(p.patch.review.scopeAccepted).toBe(false);
  const stale = parsePatch({
    ...edit,
    review: { ...p.patch.review, scopeAccepted: true },
  });
  const out = await previewPatch(base, stale, f.library, ctx, client);
  expect(out.ok).toBe(false);
  expect(client.build).not.toHaveBeenCalled();
});
test.each([
  "operations",
  "scope",
  "plan-digest",
  "asset-bindings",
  "changed-ids",
  "raw",
  "patch-id",
])("rejects accepted proposal tampering: %s", async (mode) => {
  const { f, base } = standard,
    client = directClient(),
    ctx = context(base);
  const p = value(
    await proposePatch(
      base,
      patch(base, [
        { kind: "add", groupId: "rock", assetRef: ref(f), count: 1 },
      ]),
      f.library,
      ctx,
      client,
    ),
  );
  const edit = structuredClone(accepted(p));
  if (mode === "operations")
    edit.operations = [
      { kind: "add", groupId: "rock", assetRef: ref(f), count: 2 },
    ];
  if (mode === "scope")
    edit.requestedRegion = edit.effectiveRegion = box(-2, -2, 1);
  if (mode === "plan-digest") edit.review.planDigest = "f".repeat(64);
  if (mode === "asset-bindings") edit.review.assetBindings = [];
  if (mode === "changed-ids") edit.affectedInstanceIds = [];
  if (mode === "raw") edit.raw = "Different request";
  if (mode === "patch-id") edit.patchId = "different-patch";
  const out = await previewPatch(base, edit, f.library, ctx, client);
  expect(out.ok).toBe(false);
  expect(client.resolve).not.toHaveBeenCalled();
  expect(client.build).not.toHaveBeenCalled();
});
test("delete then reopen from stored CPU results then add retains tombstones and consumes the next slot", async () => {
  const { f, base } = standard;
  const removed = (
    await preview(
      base,
      patch(
        base,
        [{ kind: "remove", instanceId: "rock:0" }],
        undefined,
        "remove-first",
      ),
    )
  ).out.compiled.snapshot;
  const reopened = parseSnapshot(structuredClone(removed));
  if (reopened.capability !== "editable")
    throw Error("Expected editable stored snapshot");
  value(
    await storedResultsToRenderPacket(
      reopened,
      f.assets.filter((a) =>
        reopened.assets.some((m) => m.assetRef.id === a.manifest.id),
      ),
      context(reopened).signal,
      { retainedBytes: 0 },
    ),
  );
  const edit = patch(
    reopened,
    [{ kind: "add", groupId: "rock", assetRef: ref(f), count: 1 }],
    undefined,
    "add-after-reopen",
  );
  const next = (await preview(reopened, edit)).out.compiled.snapshot;
  expect(next.state.tombstones).toContain("rock:0");
  expect(next.state.groups[0].nextSlot).toBe(base.state.groups[0].nextSlot + 1);
  expect(next.instances.some((i) => i.instanceId === "rock:6")).toBe(true);
  expect(next.instances.some((i) => i.instanceId === "rock:0")).toBe(false);
});

test.each([false, true])(
  "ordered replacement and brush preserve explicit move authority (move=%s)",
  async (explicitMove) => {
    const { f, base } = standard,
      old = base.instances[0],
      before = await documentDigest(base),
      client = directClient();
    const operations: ScenePatch["operations"] = [
      ...(explicitMove
        ? [
            {
              kind: "move" as const,
              instanceId: old.instanceId,
              transform: old.transform,
            },
          ]
        : []),
      { kind: "replace", instanceId: old.instanceId, assetRef: ref(f, 1) },
      { kind: "brush", center: [-2, -2], radius: 0.4, delta: 0.04 },
    ];
    const edit = patch(base, operations, box(-2, -2, 0.4));
    const result = await proposePatch(
      base,
      edit,
      f.library,
      context(base),
      client,
    );
    if (explicitMove) {
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.issues).toContainEqual(
          expect.objectContaining({ code: "support", path: "patch.brush" }),
        );
      expect(client.build).not.toHaveBeenCalled();
    } else {
      const p = value(result),
        out = value(
          await previewPatch(
            base,
            accepted(p),
            f.library,
            context(base),
            client,
          ),
        );
      const changed = out.compiled.snapshot.instances.find(
        (i) => i.instanceId === old.instanceId,
      )!;
      expect(changed.assetRef).toEqual(ref(f, 1));
      expect(changed.transform.position[1]).toBeGreaterThan(
        old.transform.position[1],
      );
      expect(changed.transform.position[0]).toBe(old.transform.position[0]);
      expect(changed.transform.position[2]).toBe(old.transform.position[2]);
    }
    expect(await documentDigest(base)).toBe(before);
  },
);
test("replace then move and a later overriding move preserve the final exact transform", async () => {
  const { f, base } = standard,
    old = base.instances[0];
  const final = { ...old.transform, position: [-2.2, 0.015, -2] as const };
  const edit = patch(base, [
    { kind: "replace", instanceId: old.instanceId, assetRef: ref(f, 1) },
    {
      kind: "move",
      instanceId: old.instanceId,
      transform: { ...old.transform, position: [-2.1, 0.015, -2] },
    },
    { kind: "move", instanceId: old.instanceId, transform: final },
  ]);
  const next = (await preview(base, edit)).out.compiled.snapshot;
  expect(next.instances.find((i) => i.instanceId === old.instanceId)).toEqual({
    ...old,
    assetRef: ref(f, 1),
    transform: final,
  });
  expect(
    next.state.overrides.filter((o) => o.instanceId === old.instanceId),
  ).toEqual([
    {
      instanceId: old.instanceId,
      groupId: old.groupId,
      kind: "move",
      assetRef: ref(f, 1),
      transform: final,
    },
  ]);
});
test("a brush freezes H exterior and only reattaches a complete-footprint witness outside R", async () => {
  const { base } = standard;
  const edit = patch(
    base,
    [{ kind: "brush", center: [-2, -2], radius: 0.4, delta: 0.04 }],
    box(-2, -2, 0.4),
  );
  const { proposed, out } = await preview(base, edit),
    next = out.compiled.snapshot;
  expect(out.changedTileIds.length).toBeGreaterThan(0);
  expect(out.changedTileIds.length).toBeLessThan(base.terrain.tiles.length);
  const far = outside(base, proposed.effectiveRegion);
  expect(far.length).toBeGreaterThan(0);
  for (const i of far)
    expect(next.instances.find((n) => n.instanceId === i.instanceId)).toEqual(
      i,
    );
  const witness = base.instances.find((i) => i.instanceId === "rock:1")!;
  expect(outside(base, proposed.requestedRegion)).toContainEqual(witness);
  expect(outside(base, proposed.effectiveRegion)).not.toContainEqual(witness);
  const reattached = next.instances.find(
    (i) => i.instanceId === witness.instanceId,
  )!;
  expect(reattached).toEqual({
    ...witness,
    transform: {
      ...witness.transform,
      position: [
        witness.transform.position[0],
        reattached.transform.position[1],
        witness.transform.position[2],
      ],
    },
  });
  expect(reattached.transform.position[1]).not.toBe(
    witness.transform.position[1],
  );
  expect(proposed.changedInstanceIds).toContain(witness.instanceId);
  for (let n = 0; n < base.terrain.heights.length; n++) {
    const x =
      -base.terrain.width / 2 + (n % base.terrain.nx) * base.terrain.spacing;
    const z =
      -base.terrain.depth / 2 +
      Math.floor(n / base.terrain.nx) * base.terrain.spacing;
    if (Math.hypot(x + 2, z + 2) > 0.4 + 1e-8)
      expect(next.terrain.heights[n]).toBe(base.terrain.heights[n]);
  }
});
async function farDigest(snapshot: EditableSnapshot, ids: string[]) {
  const terrain = snapshot.terrain,
    tiles = terrain.tiles.filter((t) => ids.includes(t.id));
  const nodes = [...new Set(tiles.flatMap((t) => [...t.nodeIndices]))].sort(
    (a, b) => a - b,
  );
  const surfaces = [];
  for (const surface of snapshot.surfaces)
    for (const tile of surface.tiles.filter((t) => ids.includes(t.tileId))) {
      surfaces.push({
        role: surface.role,
        tileId: tile.tileId,
        digest: await surfaceTilePayloadDigest(surface.data, tile),
      });
    }
  return documentDigest({
    nodes: nodes.map((i) => ({
      i,
      height: terrain.heights[i],
      normals: [...terrain.normals.slice(i * 3, i * 3 + 3)],
    })),
    surfaces,
  });
}
test("keeps far tiles byte-identical after brush and reopen", async () => {
  const { f, base } = standard;
  const first = await preview(
    base,
    patch(
      base,
      [{ kind: "brush", center: [-2, -2], radius: 0.4, delta: 0.04 }],
      box(-2, -2, 0.4),
      "brush-one",
    ),
  );
  const second = await preview(
    first.out.compiled.snapshot,
    patch(
      first.out.compiled.snapshot,
      [{ kind: "brush", center: [-2, -2], radius: 0.4, delta: -0.02 }],
      box(-2, -2, 0.4),
      "brush-two",
    ),
  );
  const next = second.out.compiled.snapshot;
  expect(next.state.brushes.map((b) => [b.sequence, b.delta])).toEqual([
    [1, 0.04],
    [2, -0.02],
  ]);
  expect(next.state.brushes[0]).toEqual(
    first.out.compiled.snapshot.state.brushes[0],
  );
  const farIds = base.terrain.tiles
    .map((t) => t.id)
    .filter(
      (id) =>
        !first.out.changedTileIds.includes(id) &&
        !second.out.changedTileIds.includes(id),
    );
  expect(farIds.length).toBeGreaterThan(0);
  const beforeFarDigest = await farDigest(base, farIds);
  const reopened = parseSnapshot(structuredClone(next));
  if (reopened.capability !== "editable") throw Error("Expected editable");
  value(
    await storedResultsToRenderPacket(
      reopened,
      f.assets.filter((a) =>
        reopened.assets.some((m) => m.assetRef.id === a.manifest.id),
      ),
      context(reopened).signal,
      { retainedBytes: 0 },
    ),
  );
  const afterFarDigest = await farDigest(reopened, farIds);
  expect(afterFarDigest).toBe(beforeFarDigest);
  const resolved = value(
    await resolvePlan(
      reopened.plan,
      reopened.state,
      f.library,
      context(reopened).signal,
      { retainedBytes: 0 },
    ),
  );
  const rebuilt = value(
    await compileScene(
      resolved,
      reopened.state,
      f.assets.filter((a) =>
        reopened.assets.some((m) => m.assetRef.id === a.manifest.id),
      ),
      {
        ...context(reopened, "explicit-rebuild"),
        intent: reopened.intent,
        modelEvidence: reopened.modelEvidence,
        camera: reopened.camera,
        patch: null,
        baseSnapshot: reopened,
      },
    ),
  );
  expect(next.quality.semanticMode).toBe("manual-corrected");
  expect(next.quality.semantic.status).toBe("pass");
  expect(rebuilt.report.semanticMode).toBe("manual-corrected");
  expect(rebuilt.report.semantic.status).toBe("pass");
  expect(rebuilt.snapshot.geometryDigest).toBe(next.geometryDigest);
  expect(rebuilt.snapshot.instances).toEqual(next.instances);
  expect(rebuilt.snapshot.terrain).toEqual(next.terrain);
});
test.each(["brush", "set-count"] as const)(
  "rejects %s when an existing lock would become infeasible",
  async (mode) => {
    const { f, base } = await compileFixture({ count: 6 }, true, true),
      before = await documentDigest(base),
      client = directClient();
    const edit = patch(
      base,
      mode === "brush"
        ? [{ kind: "brush", center: [-2, -2], radius: 0.4, delta: 0.04 }]
        : [{ kind: "set-count", groupId: "rock", count: 0 }],
      box(-2, -2, 0.4),
    );
    expect(
      (await proposePatch(base, edit, f.library, context(base), client)).ok,
    ).toBe(false);
    expect(client.build).not.toHaveBeenCalled();
    expect(await documentDigest(base)).toBe(before);
  },
);
test("rejects a brush whose support halo touches a river bank", async () => {
  const { f, base } = await compileFixture({ river: true }),
    client = directClient();
  const edit = patch(
    base,
    [{ kind: "brush", center: [0, 0], radius: 0.2, delta: 0.02 }],
    box(0, 0, 0.2),
  );
  const result = await proposePatch(
    base,
    edit,
    f.library,
    context(base),
    client,
  );
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(
      result.issues.some((i) => /water|bank/i.test(i.path + i.message)),
    ).toBe(true);
  expect(client.build).not.toHaveBeenCalled();
});
test("rejects a brush on a rigid scanned patch", async () => {
  const { f, base } = await compileFixture({ patch: true }),
    client = directClient();
  const edit = patch(
    base,
    [{ kind: "brush", center: [0, 0], radius: 0.2, delta: 0.02 }],
    box(0, 0, 0.2),
  );
  expect(
    (await proposePatch(base, edit, f.library, context(base), client)).ok,
  ).toBe(false);
  expect(client.build).not.toHaveBeenCalled();
});
test.each([
  "seed",
  "domain",
  "slopeAzimuthDegrees",
  "noiseScale",
  "controlPoints",
])(
  "rejects a global %s change as a local operation before BuildClient calls",
  async (field) => {
    const { f, base } = standard,
      client = untouchedClient();
    const edit = {
      ...patch(base, [{ kind: "remove", instanceId: "rock:0" }]),
      operations: [{ kind: "set-global", field, value: 123 }],
    };
    expect(
      (
        await proposePatch(
          base,
          edit as unknown as ScenePatch,
          f.library,
          context(base),
          client,
        )
      ).ok,
    ).toBe(false);
    expectNoBuildCalls(client);
  },
);
test("repeating the same patch against the same immutable parent never allocates another slot", async () => {
  const { f, base } = standard;
  const edit = patch(base, [
    { kind: "add", groupId: "rock", assetRef: ref(f), count: 1 },
  ]);
  const one = await preview(base, edit),
    two = await preview(base, edit);
  expect(two.out.compiled.snapshot.state).toEqual(
    one.out.compiled.snapshot.state,
  );
  expect(two.out.compiled.snapshot.instances).toEqual(
    one.out.compiled.snapshot.instances,
  );
  expect(two.out.compiled.snapshot.geometryDigest).toBe(
    one.out.compiled.snapshot.geometryDigest,
  );
  expect(two.out.compiled.snapshot.state.groups[0].nextSlot).toBe(
    base.state.groups[0].nextSlot + 1,
  );
});

test("captures parent buffers and operations before its first asynchronous proposal step", async () => {
  const { f, base } = standard,
    mutableBase = structuredClone(base),
    client = directClient();
  const edit = structuredClone(
    patch(base, [{ kind: "add", groupId: "rock", assetRef: ref(f), count: 1 }]),
  );
  const pending = proposePatch(
    mutableBase,
    edit,
    f.library,
    context(base),
    client,
  );
  mutableBase.terrain.heights[0] += 0.1;
  edit.operations = [
    { kind: "add", groupId: "rock", assetRef: ref(f), count: 2 },
  ];
  const proposal = value(await pending);
  expect(proposal.instances).toHaveLength(base.instances.length + 1);
  expect(proposal.changedInstanceIds).toEqual(["rock:6"]);
  expect(client.build).not.toHaveBeenCalled();
});
test("an abort after proposal work prevents candidate compilation and preserves the parent", async () => {
  const { f, base } = standard,
    client = directClient(),
    ctx = context(base),
    abort = new AbortController();
  const p = value(
    await proposePatch(
      base,
      patch(base, [
        { kind: "add", groupId: "rock", assetRef: ref(f), count: 1 },
      ]),
      f.library,
      ctx,
      client,
    ),
  );
  const before = await documentDigest(base),
    original = client.propose;
  client.propose = vi.fn(
    async (...args: Parameters<BuildClient["propose"]>) => {
      const result = await original(...args);
      abort.abort();
      return result;
    },
  );
  const result = await previewPatch(
    base,
    accepted(p),
    f.library,
    { ...ctx, signal: abort.signal },
    client,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues[0].code).toBe("cancelled");
  expect(client.resolve).not.toHaveBeenCalled();
  expect(client.build).not.toHaveBeenCalled();
  expect(await documentDigest(base)).toBe(before);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function snapshotCaptures(
  spy: { mock: { calls: unknown[][] } },
  base: EditableSnapshot,
) {
  return spy.mock.calls.filter(
    ([input]) =>
      input &&
      typeof input === "object" &&
      "documentType" in input &&
      input.documentType === base.documentType,
  ).length;
}

test.each(["propose", "preview"] as const)(
  "21 identical public %s calls share one promise and capture; conflicting input cannot capture",
  async (kind) => {
    const { f, base } = standard,
      ctx = context(base, `dedupe-${kind}`);
    const initial = patch(
      base,
      [{ kind: "add", groupId: "rock", assetRef: ref(f), count: 1 }],
      undefined,
      `dedupe-${kind}`,
    );
    const proposal = value(
      await proposePatch(base, initial, f.library, ctx, directClient()),
    );
    const edit = kind === "preview" ? accepted(proposal) : initial;
    const gate = deferred<void>(),
      client = directClient();
    client.propose = vi.fn(async () => {
      await gate.promise;
      return { ok: true as const, value: proposal };
    });
    const clone = vi.spyOn(globalThis, "structuredClone");
    const invoke = () =>
      kind === "propose"
        ? proposePatch(base, edit, f.library, ctx, client)
        : previewPatch(base, edit, f.library, ctx, client);
    const requests = Array.from({ length: 21 }, invoke);
    try {
      for (const request of requests) expect(request).toBe(requests[0]);
      expect(client.propose).toHaveBeenCalledTimes(1);
      expect(snapshotCaptures(clone, base)).toBe(1);
      const conflicting = { ...edit, raw: "A different active request" };
      const conflict = await (kind === "propose"
        ? proposePatch(base, conflicting, f.library, ctx, client)
        : previewPatch(base, conflicting, f.library, ctx, client));
      expect(conflict.ok).toBe(false);
      expect(snapshotCaptures(clone, base)).toBe(1);
      expect(client.propose).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
    }
    const results = await Promise.all(requests);
    for (const result of results) {
      expect(result.ok, JSON.stringify(result.ok ? null : result.issues)).toBe(
        true,
      );
      expect(result).toBe(results[0]);
    }
    expect(client.resolve).toHaveBeenCalledTimes(kind === "preview" ? 1 : 0);
    expect(client.build).toHaveBeenCalledTimes(kind === "preview" ? 1 : 0);
  },
);

test("a successful public proposal releases its capture fence before sequential awaited preview", async () => {
  const { f, base } = standard,
    client = directClient(),
    ctx = context(base, "sequential");
  const edit = patch(
    base,
    [{ kind: "add", groupId: "rock", assetRef: ref(f), count: 1 }],
    undefined,
    "sequential",
  );
  const proposal = value(
    await proposePatch(base, edit, f.library, ctx, client),
  );
  // No timer or extra microtask between the two public stages.
  const result = value(
    await previewPatch(base, accepted(proposal), f.library, ctx, client),
  );
  expect(result.compiled.snapshot.instances).toHaveLength(
    base.instances.length + 1,
  );
  expect(client.propose).toHaveBeenCalledTimes(2);
  expect(client.build).toHaveBeenCalledTimes(1);
});

/** A transport double only; preparation/cancellation/residency use the real BuildClient. */
class PatchTransportWorker {
  static all: PatchTransportWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: unknown[] = [];
  terminated = false;
  constructor() {
    PatchTransportWorker.all.push(this);
  }
  postMessage(message: unknown, transfer: Transferable[]) {
    this.messages.push(structuredClone(message, { transfer }));
  }
  terminate() {
    this.terminated = true;
  }
}
test.each([false, true])(
  "a publicly aborted proposal keeps the capture fence until real preparation settles (dispose=%s)",
  async (dispose) => {
    const { f, base } = standard,
      gate = deferred<void>(),
      entered = deferred<void>();
    const controller = new AbortController(),
      client = createBuildClient();
    const ctx = {
      ...context(base, "held-preparation"),
      signal: controller.signal,
    };
    const edit = patch(
      base,
      [{ kind: "add", groupId: "rock", assetRef: ref(f), count: 1 }],
      undefined,
      "held-preparation",
    );
    let calls = 0;
    const library: AssetLibrary = {
      ...f.library,
      resolveMember: async (...args) => {
        calls++;
        if (calls === 1) {
          entered.resolve();
          await gate.promise;
        }
        return f.library.resolveMember(...args);
      },
    };
    vi.stubGlobal("Worker", PatchTransportWorker);
    PatchTransportWorker.all = [];
    const clone = vi.spyOn(globalThis, "structuredClone");
    let settled = false;
    try {
      const pending = proposePatch(base, edit, library, ctx, client);
      await entered.promise;
      controller.abort();
      expect(await pending).toMatchObject({
        ok: false,
        issues: [{ code: "cancelled" }],
      });
      expect(client.activity()).toEqual({ busy: true, preparing: true });
      const cleanup = client.whenPreparationSettled().then(() => {
        settled = true;
      });
      const before = snapshotCaptures(clone, base);
      const nextContext = context(base, "after-held-preparation");
      const nextPatch = patch(
        base,
        edit.operations,
        edit.requestedRegion,
        "after-held-preparation",
      );
      if (dispose) client.dispose();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(client.activity()).toEqual({ busy: true, preparing: true });
      for (let i = 0; i < 3; i++) {
        expect(
          (await proposePatch(base, nextPatch, f.library, nextContext, client))
            .ok,
        ).toBe(false);
        expect(snapshotCaptures(clone, base)).toBe(before);
      }
      expect(PatchTransportWorker.all).toHaveLength(0);
      gate.resolve();
      await cleanup;
      expect(settled).toBe(true);
      expect(client.activity()).toEqual({ busy: false, preparing: false });
      if (!dispose) {
        const next = proposePatch(
          base,
          nextPatch,
          f.library,
          nextContext,
          client,
        );
        await vi.waitFor(() =>
          expect(PatchTransportWorker.all[0]?.messages.length).toBe(1),
        );
        expect(snapshotCaptures(clone, base)).toBeGreaterThan(before);
        client.cancel(nextContext.operationId);
        expect(await next).toMatchObject({
          ok: false,
          issues: [{ code: "cancelled" }],
        });
      }
    } finally {
      gate.resolve();
      await client.whenPreparationSettled();
      client.dispose();
      vi.unstubAllGlobals();
      PatchTransportWorker.all = [];
    }
  },
);

async function originalVersionRebuild(
  base: EditableSnapshot,
  f: Awaited<ReturnType<typeof buildFixture>>,
) {
  const ctx = context(base, "semantic-rebuild");
  const resolved = value(
    await resolvePlan(
      base.plan,
      base.state,
      f.library,
      ctx.signal,
      ctx.resources,
    ),
  );
  const assets = f.assets.filter((a) =>
    base.assets.some((item) => item.assetRef.id === a.manifest.id),
  );
  return compileScene(resolved, base.state, assets, {
    ...ctx,
    patch: null,
    baseSnapshot: base,
    intent: base.intent,
    modelEvidence: base.modelEvidence,
    camera: base.camera,
  });
}
test("original-version rebuilding an unverified scene retains unverified pending semantics", async () => {
  const { f, base } = standard;
  expect(base.quality.semanticMode).toBe("unverified");
  expect(base.quality.semantic.status).toBe("pending");
  const rebuilt = value(await originalVersionRebuild(base, f));
  expect(rebuilt.snapshot.geometryDigest).toBe(base.geometryDigest);
  expect(rebuilt.report.semanticMode).toBe("unverified");
  expect(rebuilt.report.semantic.status).toBe("pending");
});
test("a fake saved scope marker never promotes initial compile or original-version rebuild semantics", async () => {
  const f = await buildFixture();
  f.draft = parsePlanDraft({
    ...f.draft,
    review: {
      ...f.draft.review,
      fieldSources: [
        ...f.draft.review.fieldSources,
        {
          key: "manual-patch-scope",
          value: { patchId: "forged-scope" },
          source: "manual",
          span: null,
          strength: "hard",
          negated: false,
        },
      ],
    },
  });
  const resolved = value(
    await resolvePlan(
      f.draft,
      f.state,
      f.library,
      f.context.signal,
      f.context.resources,
    ),
  );
  const base = value(
    await compileScene(resolved, f.state, f.assets, f.context),
  ).snapshot;
  expect(base.quality.semanticMode).toBe("unverified");
  expect(base.quality.semantic.status).toBe("pending");
  const rebuilt = value(await originalVersionRebuild(base, f));
  expect(rebuilt.snapshot.geometryDigest).toBe(base.geometryDigest);
  expect(rebuilt.report.semanticMode).toBe("unverified");
  expect(rebuilt.report.semantic.status).toBe("pending");
});

async function lockMetadataFixture(grassInside: boolean) {
  const f = await buildFixture({ categories: ["rock", "grass"] });
  f.state = parseEditableState({
    ...f.state,
    groups: [
      { groupId: "rock", nextSlot: 1, retired: false },
      { groupId: "grass", nextSlot: 1, retired: false },
    ],
    overrides: f.draft.groups.map((g) => ({
      instanceId: `${g.groupId}:0`,
      groupId: g.groupId,
      kind: "move",
      assetRef: g.assetRef,
      transform: {
        position:
          g.groupId === "rock"
            ? [-1.2, 0.015, 0]
            : grassInside
              ? [-0.5, 0.015, 0]
              : [1, 0.015, 1],
        quaternion: [0, 0, 0, 1],
        scale: 1,
      },
    })),
  });
  const r = value(
    await resolvePlan(
      f.draft,
      f.state,
      f.library,
      f.context.signal,
      f.context.resources,
    ),
  );
  const base = value(
    await compileScene(r, f.state, f.assets, f.context),
  ).snapshot;
  const rock = base.instances.find((i) => i.instanceId === "rock:0")!;
  const edit = parsePatch({
    ...patch(
      base,
      [
        {
          kind: "move",
          instanceId: rock.instanceId,
          transform: { ...rock.transform, position: [-1.3, 0.015, 0] },
        },
      ],
      box(-1, 0, 0.8),
      `new-lock-${grassInside}`,
    ),
    lockedInstanceIds: ["grass:0"],
  });
  return { f, base, edit };
}
test.each([true, false])(
  "new lock metadata inside R=%s does not turn unchanged grass into a changed object",
  async (grassInside) => {
    const { f, base, edit } = await lockMetadataFixture(grassInside),
      before = await documentDigest(base);
    const { proposed, out } = await preview(base, edit, f.library),
      next = out.compiled.snapshot;
    const grass = base.instances.find((i) => i.instanceId === "grass:0")!;
    expect(
      outside(base, proposed.requestedRegion).some(
        (i) => i.instanceId === grass.instanceId,
      ),
    ).toBe(!grassInside);
    expect(proposed.changedInstanceIds).toEqual(["rock:0"]);
    expect(proposed.patch.affectedInstanceIds).toEqual(["rock:0"]);
    expect(out.changedInstanceIds).toEqual(["rock:0"]);
    expect(next.state.lockedInstanceIds).toEqual(["grass:0"]);
    expect(next.instances.find((i) => i.instanceId === "grass:0")).toEqual({
      ...grass,
      locked: true,
    });
    expect(next.instances.find((i) => i.instanceId === "rock:0")).toEqual({
      ...base.instances.find((i) => i.instanceId === "rock:0")!,
      transform: (
        edit.operations[0] as Extract<
          ScenePatch["operations"][number],
          { kind: "move" }
        >
      ).transform,
    });
    expect(next.terrain).toEqual(base.terrain);
    expect(next.water).toEqual(base.water);
    expect(next.surfaces).toEqual(base.surfaces);
    expect(await documentDigest(base)).toBe(before);
    const retained = buildOwnedBytes({
      base,
      next,
      assets: f.assets,
      packages: f.packages,
    });
    // Production ZIP/storage codecs, not an invented IndexedDB commit receipt.
    const bytes = await encodeGeneralArchive(next, f.assets, "reference", {
      signal: new AbortController().signal,
      resources: { retainedBytes: retained },
      library: f.library,
    });
    const imported = value(
      await decodeGeneralArchive(bytes, f.library, {
        signal: new AbortController().signal,
        resources: { retainedBytes: retained + bytes.byteLength },
      }),
    );
    try {
      expect(imported.editable).toBe(true);
      expect(imported.snapshot).toEqual(next);
      expect(await documentDigest(imported.snapshot)).toBe(
        await documentDigest(next),
      );
      if (imported.snapshot.capability !== "editable")
        throw Error("Expected editable roundtrip");
      const reopened = imported.snapshot;
      const cumulative = parsePatch({
        ...patch(
          reopened,
          [{ kind: "add", groupId: "rock", assetRef: ref(f), count: 1 }],
          box(0, 0, 1.9),
          `cumulative-lock-${grassInside}`,
        ),
        lockedInstanceIds: ["grass:0", "rock:0"],
      });
      const again = (await preview(reopened, cumulative, imported.library!)).out
        .compiled.snapshot;
      expect(again.state.lockedInstanceIds).toEqual(["grass:0", "rock:0"]);
      for (const old of reopened.instances)
        expect(
          again.instances.find((i) => i.instanceId === old.instanceId),
        ).toEqual({ ...old, locked: true });
    } finally {
      imported.ownership.dispose();
    }
  },
);

test.each(["new", "existing"] as const)(
  "%s locks still reject actual move, remove and replacement targets",
  async (mode) => {
    const { f, base, edit } = await lockMetadataFixture(false);
    const parent =
      mode === "new"
        ? base
        : (await preview(base, edit, f.library)).out.compiled.snapshot;
    const grass = parent.instances.find((i) => i.instanceId === "grass:0")!;
    for (const kind of ["move", "remove", "replace"] as const) {
      const op: ScenePatch["operations"][number] =
        kind === "move"
          ? {
              kind,
              instanceId: grass.instanceId,
              transform: { ...grass.transform, position: [1.1, 0.015, 1] },
            }
          : kind === "replace"
            ? { kind, instanceId: grass.instanceId, assetRef: grass.assetRef }
            : { kind, instanceId: grass.instanceId };
      const unsafe: ScenePatch = {
        ...patch(
          parent,
          [{ kind: "add", groupId: "rock", assetRef: ref(f), count: 1 }],
          box(1, 1, 0.5),
          `locked-${mode}-${kind}`,
        ),
        operations: [op],
        targetInstanceIds: [grass.instanceId],
        affectedInstanceIds: [grass.instanceId],
        lockedInstanceIds: [grass.instanceId],
      };
      const client = untouchedClient(),
        before = await documentDigest(parent);
      const result = await proposePatch(
        parent,
        unsafe,
        f.library,
        context(parent, unsafe.patchId),
        client,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0].message).toMatch(/lock/i);
      expectNoBuildCalls(client);
      expect(await documentDigest(parent)).toBe(before);
    }
  },
);

test("an existing grass lock cannot be removed or changed after concrete scope acceptance", async () => {
  const { f, base, edit } = await lockMetadataFixture(false);
  const { proposed } = await preview(base, edit, f.library);
  const changed = parsePatch({ ...accepted(proposed), lockedInstanceIds: [] }),
    client = directClient();
  const tampered = await previewPatch(
    base,
    changed,
    f.library,
    context(base, edit.patchId),
    client,
  );
  expect(tampered.ok).toBe(false);
  if (!tampered.ok) expect(tampered.issues[0].message).toMatch(/scope|lock/i);
  expect(client.build).not.toHaveBeenCalled();
  const saved = (await preview(base, edit, f.library)).out.compiled.snapshot;
  const rock = saved.instances.find((i) => i.instanceId === "rock:0")!;
  const losing = parsePatch({
    ...patch(
      saved,
      [
        {
          kind: "move",
          instanceId: rock.instanceId,
          transform: { ...rock.transform, position: [-1.4, 0.015, 0] },
        },
      ],
      box(-1, 0, 0.8),
      "lose-existing-lock",
    ),
    lockedInstanceIds: [],
  });
  const result = await proposePatch(
    saved,
    losing,
    f.library,
    context(saved, losing.patchId),
    directClient(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "patch-scope",
        path: "state.lockedInstanceIds",
      }),
    );
});
