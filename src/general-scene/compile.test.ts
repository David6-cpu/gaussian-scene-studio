import { test, expect, vi } from "vitest";
import * as assetLoader from "./asset-loader";
import { buildFixture } from "../../tests/support/general-build-fixture";
import { compileScene, resolvePlan, requiredBrushScope } from "./compile";
import { parseScenePlan, parseEditableState } from "./contracts";
import { documentDigest } from "./canonical";
import type { Result } from "./core";
const value = <T>(r: Result<T>): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw Error(JSON.stringify(r.issues));
  return r.value;
};
async function resolve(f: Awaited<ReturnType<typeof buildFixture>>) {
  return value(
    await resolvePlan(
      f.draft,
      f.state,
      f.library,
      f.context.signal,
      f.context.resources,
    ),
  );
}
test("compiles constructed rock grass reed through actual terrain water and surfaces", async () => {
  const f = await buildFixture({ categories: ["rock", "grass", "reed"] });
  const r = await resolve(f);
  const out = value(await compileScene(r, f.state, f.assets, f.context));
  expect(out.snapshot.instances).toHaveLength(3);
  expect(out.snapshot.surfaces[0].count).toBeGreaterThan(0);
  expect(out.snapshot.validation.usage.worstSplats).toBe(
    out.snapshot.surfaces.reduce((n: number, s: any) => n + s.count, 0) + 12,
  );
  expect(out.snapshot.reviewStatus).toBe("draft");
  expect(out.report.visual.status).toBe("pending");
});
test("fixed patch plus none needs no generated style and preserves original D", async () => {
  const f = await buildFixture({ patch: true });
  const r = await resolve(f);
  const out = value(await compileScene(r, f.state, f.assets, f.context));
  expect(out.snapshot.surfaces).toEqual([]);
  expect(out.snapshot.surfaceStyle).toBe(null);
  expect(out.snapshot.terrain.transform).toEqual(
    f.draft.terrain.source === "patch" ? f.draft.terrain.transform : null,
  );
});
test("same input produces the same final CPU geometry digest", async () => {
  const f = await buildFixture({ river: true });
  const r = await resolve(f);
  const a = value(await compileScene(r, f.state, f.assets, f.context));
  const b = value(
    await compileScene(r, f.state, f.assets, {
      ...f.context,
      revisionId: "second",
    }),
  );
  expect(a.snapshot.geometryDigest).toBe(b.snapshot.geometryDigest);
  expect(a.snapshot.terrain.heightModel.kind).toBe("water-profile");
  expect((a.snapshot.terrain.heightModel as any).baseHeights.buffer).not.toBe(
    a.snapshot.terrain.heights.buffer,
  );
  expect(a.surfaceSupport).toEqual(b.surfaceSupport);
});
test("rejects mutated continuous source or cache after preflight", async () => {
  for (const part of ["heights", "baseHeights"] as const) {
    const f = await buildFixture({ river: true });
    const r = await resolve(f);
    const array =
      part === "heights"
        ? r.geometry.field.heights
        : (r.geometry.field.heightModel as any).baseHeights;
    array[0] += 0.01;
    const out = await compileScene(r, f.state, f.assets, f.context);
    expect(out.ok).toBe(false);
    if (!out.ok)
      expect(out.issues.some((i) => i.code === "geometry-binding")).toBe(true);
  }
});
test("rejects changed decoded source and raw member bytes", async () => {
  for (const part of ["decoded", "raw"] as const) {
    const f = await buildFixture();
    const r = await resolve(f);
    if (part === "decoded" && f.assets[0].full.kind === "float14")
      f.assets[0].full.data[0] += 0.1;
    else r.sourceEvidence.members[0].bytes[0] ^= 1;
    const out = await compileScene(r, f.state, f.assets, f.context);
    expect(out.ok).toBe(false);
    if (!out.ok)
      expect(out.issues.some((i) => i.code === "asset-integrity")).toBe(true);
  }
});
test("hard shortfall keeps exact group deficit and reason", async () => {
  const f = await buildFixture({ count: 20, radius: 1 });
  f.draft = parseScenePlan({
    ...f.draft,
    regions: [
      {
        regionId: "all",
        shape: { kind: "rectangle", min: [-0.01, -0.01], max: [0.01, 0.01] },
      },
    ],
  });
  const r = await resolve(f);
  const out = await compileScene(r, f.state, f.assets, f.context);
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(
      out.issues.some(
        (i) =>
          i.code === "quantity" &&
          i.path === "groups.rock" &&
          i.message.includes("20"),
      ),
    ).toBe(true);
    expect(out.issues.some((i) => i.code === "boundary")).toBe(true);
  }
});
test("refuses a semantic change despite correct recomputed plan digest", async () => {
  const f = await buildFixture();
  f.draft = parseScenePlan({
    ...f.draft,
    groups: f.draft.groups.map((g) => ({ ...g, count: 2 })),
  });
  const r = await resolve(f);
  const out = await compileScene(r, f.state, f.assets, f.context);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.issues.some((i) => i.code === "semantic")).toBe(true);
});
test("budget includes retained current residency before resolving or allocating", async () => {
  const f = await buildFixture();
  const out = await resolvePlan(f.draft, f.state, f.library, f.context.signal, {
    retainedBytes: 256 * 1024 ** 2,
  });
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.issues.some((i) => i.code === "budget")).toBe(true);
});
test("explicit manual intent marker is bound; absent evidence never implies manual authority", async () => {
  const f = await buildFixture();
  const p = parseScenePlan({
    ...f.draft,
    review: {
      ...f.draft.review,
      fieldSources: [
        {
          key: "manual-intent",
          value: {
            requestId: f.intent.requestId,
            intentDigest: f.draft.intentDigest,
          },
          source: "manual",
          span: null,
          strength: "hard",
          negated: false,
        },
      ],
    },
  });
  f.draft = p;
  const r = await resolve(f);
  const out = value(await compileScene(r, f.state, f.assets, f.context));
  expect(out.report.semanticMode).toBe("manual-corrected");
  expect(out.report.semantic.status).toBe("pass");
});
test("stored render assembly preserves bytes ownership and support without generation", async () => {
  const f = await buildFixture({ river: true });
  const r = await resolve(f),
    out = value(await compileScene(r, f.state, f.assets, f.context));
  const { storedResultsToRenderPacket } = await import("./compile");
  const restored = value(
    await storedResultsToRenderPacket(
      out.snapshot,
      f.assets,
      f.context.signal,
      { retainedBytes: 0 },
    ),
  );
  expect(restored.surfaceSupport).toEqual(out.surfaceSupport);
  expect([...restored.render.sources.keys()]).toEqual([
    ...out.render.sources.keys(),
  ]);
  expect(await documentDigest(out.snapshot)).toBe(
    await documentDigest(structuredClone(out.snapshot)),
  );
  const bad = structuredClone(out.snapshot);
  bad.surfaces[0].tiles[0].outputIndices[0] ^= 1;
  expect(
    (
      await storedResultsToRenderPacket(bad, f.assets, f.context.signal, {
        retainedBytes: 0,
      })
    ).ok,
  ).toBe(false);
});
test("requires current procedural asset and style confirmations", async () => {
  const f = await buildFixture();
  f.draft = parseScenePlan({
    ...f.draft,
    review: {
      ...f.draft.review,
      substitutions: [],
      acceptedSubstitutions: [],
      manualOverrides: [],
    },
  });
  const r = await resolve(f),
    out = await compileScene(r, f.state, f.assets, f.context);
  expect(out.ok).toBe(false);
  if (!out.ok)
    expect(out.issues.some((i) => i.code === "confirmation")).toBe(true);
});
test("global environment is enforced by the actual selected assets", async () => {
  const f = await buildFixture();
  const intent = {
    ...f.intent,
    terrain: [
      ...f.intent.terrain,
      {
        key: "environment",
        value: "unavailable-environment",
        source: "manual" as const,
        span: null,
        strength: "hard" as const,
        negated: false,
      },
    ],
  };
  f.intent = intent;
  f.context = { ...f.context, intent };
  f.draft = parseScenePlan({
    ...f.draft,
    intentDigest: await documentDigest(intent),
  });
  const out = await compileScene(
    await resolve(f),
    f.state,
    f.assets,
    f.context,
  );
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.issues.some((i) => i.code === "semantic")).toBe(true);
});
test("a valid category origin exclusion does not forbid the remaining origin", async () => {
  const f = await buildFixture();
  const intent = {
    ...f.intent,
    prohibitions: [
      {
        key: "rock.origin",
        value: "captured",
        source: "manual" as const,
        span: null,
        strength: "hard" as const,
        negated: true,
      },
    ],
  };
  f.intent = intent;
  f.context = { ...f.context, intent };
  f.draft = parseScenePlan({
    ...f.draft,
    intentDigest: await documentDigest(intent),
  });
  expect(
    (await compileScene(await resolve(f), f.state, f.assets, f.context)).ok,
  ).toBe(true);
});
async function moveCase() {
  const f = await buildFixture({ count: 2 });
  const resolved = await resolve(f),
    base = value(
      await compileScene(resolved, f.state, f.assets, f.context),
    ).snapshot;
  const old = base.instances[0],
    transform = {
      ...old.transform,
      position: [
        old.transform.position[0] + 0.05,
        old.transform.position[1],
        old.transform.position[2],
      ] as const,
    };
  const r = 0.3,
    x = old.transform.position[0],
    z = old.transform.position[2],
    region = [
      [x - r, z - r],
      [x + r + 0.05, z - r],
      [x + r + 0.05, z + r],
      [x - r, z + r],
    ];
  const state = {
    ...base.state,
    overrides: [
      {
        instanceId: old.instanceId,
        groupId: old.groupId,
        kind: "move" as const,
        assetRef: old.assetRef,
        transform,
      },
    ],
  };
  const patch = {
    documentType: "general-scene-patch",
    schemaVersion: 1,
    patchId: "move-patch",
    baseRevisionId: base.revisionId,
    raw: "move selected instance",
    requestedRegion: region,
    effectiveRegion: region,
    targetInstanceIds: [old.instanceId],
    lockedInstanceIds: [],
    affectedInstanceIds: [old.instanceId],
    affectedTileIds: [],
    operations: [{ kind: "move", instanceId: old.instanceId, transform }],
    review: {
      scopeAccepted: true,
      planDigest: await documentDigest(base.plan),
      catalogDigest: base.plan.catalogDigest,
      assetBindings: resolved.assetBindings.map((x) => JSON.parse(x)),
    },
  };
  const ctx = {
    ...f.context,
    operationId: "move-operation",
    baseRevisionId: base.revisionId,
    revisionId: "move-revision",
    baseSnapshot: base,
    patch: patch as any,
  };
  return { f, base, old, transform, state, ctx };
}
test("accepted object move changes only the selected transform and preserves remote payloads", async () => {
  const c = await moveCase();
  const r = value(
    await resolvePlan(
      c.base.plan,
      c.state,
      c.f.library,
      c.ctx.signal,
      c.ctx.resources,
    ),
  );
  const out = value(await compileScene(r, c.state, c.f.assets, c.ctx));
  expect(
    out.snapshot.instances.find((i) => i.instanceId === c.old.instanceId)
      ?.transform,
  ).toEqual(c.transform);
  expect(
    out.snapshot.instances.filter((i) => i.instanceId !== c.old.instanceId),
  ).toEqual(c.base.instances.filter((i) => i.instanceId !== c.old.instanceId));
  expect(out.snapshot.surfaces).toEqual(c.base.surfaces);
  expect(out.report.semanticMode).toBe("manual-corrected");
});
test("local move cannot compile without accepted scope or after base mismatch", async () => {
  for (const mode of ["unaccepted", "stale"] as const) {
    const c = await moveCase();
    if (mode === "unaccepted") c.ctx.patch!.review.scopeAccepted = false;
    else c.ctx.baseRevisionId = "newer-revision";
    const r = value(
      await resolvePlan(
        c.base.plan,
        c.state,
        c.f.library,
        c.ctx.signal,
        c.ctx.resources,
      ),
    );
    const out = await compileScene(r, c.state, c.f.assets, c.ctx);
    expect(out.ok).toBe(false);
  }
});
test("a too-small reviewed R cannot authorize old or new full footprints", async () => {
  const c = await moveCase();
  const x = c.old.transform.position[0],
    z = c.old.transform.position[2],
    small = [
      [x - 0.01, z - 0.01],
      [x + 0.01, z - 0.01],
      [x + 0.01, z + 0.01],
      [x - 0.01, z + 0.01],
    ];
  c.ctx.patch!.requestedRegion = small as any;
  c.ctx.patch!.effectiveRegion = small as any;
  const r = value(
    await resolvePlan(
      c.base.plan,
      c.state,
      c.f.library,
      c.ctx.signal,
      c.ctx.resources,
    ),
  );
  const out = await compileScene(r, c.state, c.f.assets, c.ctx);
  expect(out.ok).toBe(false);
  if (!out.ok)
    expect(out.issues.some((i) => i.code === "patch-scope")).toBe(true);
});
test("stored assembly captures stable caller buffers before its first await", async () => {
  const f = await buildFixture(),
    r = await resolve(f),
    out = value(await compileScene(r, f.state, f.assets, f.context));
  const { storedResultsToRenderPacket } = await import("./compile");
  const before = await documentDigest(out.snapshot);
  const pending = storedResultsToRenderPacket(
    out.snapshot,
    f.assets,
    f.context.signal,
    { retainedBytes: 0 },
  );
  out.snapshot.terrain.heights[0] += 0.1;
  if (f.assets[0].full.kind === "float14") f.assets[0].full.data[0] += 0.1;
  const captured = value(await pending);
  expect(captured.render.sources.size).toBeGreaterThan(0);
  expect(await documentDigest(out.snapshot)).not.toBe(before);
});
test("local count target includes frozen members and survives a later unchanged rebuild", async () => {
  const c = await moveCase();
  const next = c.base.state.groups[0].nextSlot,
    newId = `rock:${next}`,
    region = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ] as const;
  const plan = parseScenePlan({
    ...c.base.plan,
    groups: c.base.plan.groups.map((g) => ({ ...g, count: 3 })),
    review: {
      ...c.base.plan.review,
      fieldSources: [
        ...c.base.plan.review.fieldSources,
        {
          key: "manual-group-count",
          value: { groupId: "rock", count: 3 },
          source: "manual",
          span: null,
          strength: "hard",
          negated: false,
        },
      ],
    },
  });
  const state = {
    ...c.base.state,
    groups: c.base.state.groups.map((g) => ({ ...g, nextSlot: next + 1 })),
  };
  const patch = {
    ...c.ctx.patch!,
    requestedRegion: region,
    effectiveRegion: region,
    targetInstanceIds: [],
    affectedInstanceIds: [newId],
    operations: [{ kind: "set-count" as const, groupId: "rock", count: 3 }],
    review: { ...c.ctx.patch!.review, planDigest: await documentDigest(plan) },
  };
  const ctx = { ...c.ctx, patch };
  const r = value(
      await resolvePlan(plan, state, c.f.library, ctx.signal, ctx.resources),
    ),
    out = value(await compileScene(r, state, c.f.assets, ctx));
  expect(out.snapshot.instances).toHaveLength(3);
  for (const old of c.base.instances)
    expect(
      out.snapshot.instances.find((i) => i.instanceId === old.instanceId),
    ).toEqual(old);
  const nextResolved = value(
    await resolvePlan(
      out.snapshot.plan,
      out.snapshot.state,
      c.f.library,
      ctx.signal,
      ctx.resources,
    ),
  );
  const again = value(
    await compileScene(nextResolved, out.snapshot.state, c.f.assets, {
      ...ctx,
      operationId: "rebuild",
      revisionId: "rebuild-revision",
      baseRevisionId: out.snapshot.revisionId,
      baseSnapshot: out.snapshot,
      patch: null,
    }),
  );
  expect(again.snapshot.instances).toEqual(out.snapshot.instances);
});

test("tile payload identity is stable when preceding tile changes its global offset", async () => {
  const { surfaceTilePayloadDigest } = await import("./compile");
  const point = new Float32Array([
      0, 0, 0, 0.1, 0.1, 0.1, 0, 0, 0, 1, 0.2, 0.3, 0.4, 1,
    ]),
    shifted = new Float32Array(28);
  shifted.set(point, 14);
  expect(
    await surfaceTilePayloadDigest(point, {
      tileId: "tile:1:0",
      outputIndices: new Uint32Array([0]),
    }),
  ).toBe(
    await surfaceTilePayloadDigest(shifted, {
      tileId: "tile:1:0",
      outputIndices: new Uint32Array([1]),
    }),
  );
});
async function brushCase(locked = false, variant = false) {
  const f = await buildFixture({ unusedVariant: variant });
  const initial = await resolve(f),
    base = value(
      await compileScene(initial, f.state, [f.assets[0]], f.context),
    ).snapshot,
    old = base.instances[0];
  const x = old.transform.position[0],
    z = old.transform.position[2],
    r = 0.4,
    requested = [
      [x - r, z - r],
      [x + r, z - r],
      [x + r, z + r],
      [x - r, z + r],
    ] as const;
  const scope = value(requiredBrushScope(base, base.plan, f.assets, requested));
  const effective = scope.effectiveRegion;
  const state = parseEditableState({
    ...base.state,
    lockedInstanceIds: locked ? [old.instanceId] : [],
    brushes: [
      {
        sequence: 1,
        center: [x, z],
        radius: r,
        delta: 0.04,
        requestedRegion: requested,
        effectiveRegion: effective,
      },
    ],
  });
  const patch = {
    documentType: "general-scene-patch",
    schemaVersion: 1,
    patchId: "brush-patch",
    baseRevisionId: base.revisionId,
    raw: "raise only this area",
    requestedRegion: requested,
    effectiveRegion: effective,
    targetInstanceIds: [],
    lockedInstanceIds: state.lockedInstanceIds,
    affectedInstanceIds: locked ? [] : [old.instanceId],
    affectedTileIds: scope.affectedTileIds,
    operations: [{ kind: "brush", center: [x, z], radius: r, delta: 0.04 }],
    review: {
      scopeAccepted: true,
      planDigest: await documentDigest(base.plan),
      catalogDigest: base.plan.catalogDigest,
      assetBindings: initial.assetBindings.map((x) => JSON.parse(x)),
    },
  };
  const ctx = {
    ...f.context,
    operationId: "brush-operation",
    baseRevisionId: base.revisionId,
    revisionId: "brush-revision",
    baseSnapshot: base,
    patch: patch as any,
  };
  return { f, base, old, state, ctx };
}
test("reviewed brush preserves XZ rotation identity and only reattaches infeasible supports", async () => {
  const c = await brushCase();
  const r = value(
    await resolvePlan(
      c.base.plan,
      c.state,
      c.f.library,
      c.ctx.signal,
      c.ctx.resources,
    ),
  );
  const out = value(await compileScene(r, c.state, c.f.assets, c.ctx)),
    next = out.snapshot.instances[0];
  expect(next.instanceId).toBe(c.old.instanceId);
  expect(next.transform.position[0]).toBe(c.old.transform.position[0]);
  expect(next.transform.position[2]).toBe(c.old.transform.position[2]);
  expect(next.transform.quaternion).toEqual(c.old.transform.quaternion);
  expect(next.transform.position[1]).toBeGreaterThan(
    c.old.transform.position[1],
  );
});
test("brush that makes a locked support infeasible fails without moving it", async () => {
  const c = await brushCase(true);
  const r = value(
      await resolvePlan(
        c.base.plan,
        c.state,
        c.f.library,
        c.ctx.signal,
        c.ctx.resources,
      ),
    ),
    out = await compileScene(r, c.state, c.f.assets, c.ctx);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.issues.some((i) => i.code === "support")).toBe(true);
});

test("unrelated successful-looking raw model evidence cannot certify a scene", async () => {
  const f = await buildFixture();
  f.context.modelEvidence = ["intent", "plan"].map((stage) => ({
    stage: stage as "intent" | "plan",
    provenance: "real" as const,
    requestedModel: "local-model",
    model: "local-model",
    raw: "{}",
    promptVersion: "general-planner-v1",
    startedAt: "2026-10-13T00:00:00Z",
    endedAt: "2026-10-13T00:00:00Z",
    failureReason: null,
  }));
  const out = value(
    await compileScene(await resolve(f), f.state, f.assets, f.context),
  );
  expect(out.report.semanticMode).toBe("unverified");
  expect(out.report.semantic.status).toBe("pending");
});
test("compiled local output records exact reviewed R H and membership once", async () => {
  const c = await moveCase();
  const out = value(
    await compileScene(
      value(
        await resolvePlan(
          c.base.plan,
          c.state,
          c.f.library,
          c.ctx.signal,
          c.ctx.resources,
        ),
      ),
      c.state,
      c.f.assets,
      c.ctx,
    ),
  );
  expect(out.snapshot.state.affectedRegions).toEqual([
    ...c.base.state.affectedRegions,
    {
      requestedRegion: c.ctx.patch!.requestedRegion,
      effectiveRegion: c.ctx.patch!.effectiveRegion,
      tileIds: [],
      instanceIds: [c.old.instanceId],
    },
  ]);
});
test("saved helper rejects descriptor identity tampering even when payload buffers match", async () => {
  const f = await buildFixture();
  const out = value(
    await compileScene(await resolve(f), f.state, f.assets, f.context),
  );
  const { verifyStoredResults } = await import("./compile");
  const tampered = structuredClone(out.snapshot);
  (tampered.assets[0].manifest as any).environments = [
    ...tampered.assets[0].manifest.environments,
    "invented-environment",
  ];
  let rejected = false;
  try {
    await verifyStoredResults(tampered, f.context.signal);
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
});

test("ordered move then replace validates one final coalesced override", async () => {
  const c = await moveCase();
  c.ctx.patch!.operations.push({
    kind: "replace",
    instanceId: c.old.instanceId,
    assetRef: c.old.assetRef,
  });
  c.state.overrides[0] = { ...c.state.overrides[0], kind: "replace" } as any;
  const out = value(
    await compileScene(
      value(
        await resolvePlan(
          c.base.plan,
          c.state,
          c.f.library,
          c.ctx.signal,
          c.ctx.resources,
        ),
      ),
      c.state,
      c.f.assets,
      c.ctx,
    ),
  );
  expect(
    out.snapshot.instances.find((i) => i.instanceId === c.old.instanceId)
      ?.transform,
  ).toEqual(c.transform);
  expect(out.snapshot.state.overrides).toHaveLength(1);
  expect(out.snapshot.state.overrides[0].kind).toBe("replace");
});
test("ordered add then local count reduction consumes slots and coalesces deletion", async () => {
  const c = await moveCase(),
    next = c.base.state.groups[0].nextSlot,
    kept = `rock:${next}`,
    removed = `rock:${next + 1}`,
    region = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ];
  const plan = parseScenePlan({
    ...c.base.plan,
    groups: c.base.plan.groups.map((g) => ({ ...g, count: 3 })),
    review: {
      ...c.base.plan.review,
      fieldSources: [
        {
          key: "manual-group-count",
          value: { groupId: "rock", count: 3 },
          source: "manual",
          span: null,
          strength: "hard",
          negated: false,
        },
      ],
    },
  });
  const state = parseEditableState({
    ...c.base.state,
    groups: c.base.state.groups.map((g) => ({ ...g, nextSlot: next + 2 })),
    tombstones: [removed],
    overrides: [
      {
        instanceId: removed,
        groupId: "rock",
        kind: "remove",
        assetRef: null,
        transform: null,
      },
    ],
  });
  const patch = {
    ...c.ctx.patch!,
    requestedRegion: region,
    effectiveRegion: region,
    targetInstanceIds: [],
    affectedInstanceIds: [kept],
    operations: [
      { kind: "add", groupId: "rock", assetRef: c.old.assetRef, count: 2 },
      { kind: "set-count", groupId: "rock", count: 3 },
    ],
    review: { ...c.ctx.patch!.review, planDigest: await documentDigest(plan) },
  };
  const ctx = { ...c.ctx, patch: patch as any };
  const out = value(
    await compileScene(
      value(
        await resolvePlan(plan, state, c.f.library, ctx.signal, ctx.resources),
      ),
      state,
      c.f.assets,
      ctx,
    ),
  );
  expect(out.snapshot.instances).toHaveLength(3);
  expect(out.snapshot.instances.some((i) => i.instanceId === kept)).toBe(true);
  expect(out.snapshot.state.groups[0].nextSlot).toBe(next + 2);
  expect(out.snapshot.state.tombstones).toContain(removed);
});
test("ordered brush then move uses one working state and final explicit transform", async () => {
  const c = await brushCase();
  const r = value(
    await resolvePlan(
      c.base.plan,
      c.state,
      c.f.library,
      c.ctx.signal,
      c.ctx.resources,
    ),
  );
  const { sampleTerrainWorld } = await import("./terrain");
  const x = c.old.transform.position[0] + 0.04,
    z = c.old.transform.position[2],
    height = value(sampleTerrainWorld(r.geometry.field, x, z)).height,
    transform = {
      ...c.old.transform,
      position: [x, height + 0.015, z] as const,
    };
  c.state = parseEditableState({
    ...c.state,
    overrides: [
      {
        instanceId: c.old.instanceId,
        groupId: "rock",
        kind: "move",
        assetRef: c.old.assetRef,
        transform,
      },
    ],
  });
  c.ctx.patch!.operations.push({
    kind: "move",
    instanceId: c.old.instanceId,
    transform,
  });
  c.ctx.patch!.targetInstanceIds = [c.old.instanceId];
  const out = value(
    await compileScene(
      value(
        await resolvePlan(
          c.base.plan,
          c.state,
          c.f.library,
          c.ctx.signal,
          c.ctx.resources,
        ),
      ),
      c.state,
      c.f.assets,
      c.ctx,
    ),
  );
  expect(out.snapshot.instances[0].transform).toEqual(transform);
  expect(out.snapshot.state.brushes).toHaveLength(1);
  expect(out.snapshot.state.overrides).toHaveLength(1);
});

test("explicit move followed by a brush that invalidates it is rejected without changing the hard transform", async () => {
  const c = await brushCase();
  const transform = c.old.transform;
  c.state = parseEditableState({
    ...c.state,
    overrides: [
      {
        instanceId: c.old.instanceId,
        groupId: "rock",
        kind: "move",
        assetRef: c.old.assetRef,
        transform,
      },
    ],
  });
  c.ctx.patch!.operations.unshift({
    kind: "move",
    instanceId: c.old.instanceId,
    transform,
  });
  c.ctx.patch!.targetInstanceIds = [c.old.instanceId];
  const out = await compileScene(
    value(
      await resolvePlan(
        c.base.plan,
        c.state,
        c.f.library,
        c.ctx.signal,
        c.ctx.resources,
      ),
    ),
    c.state,
    c.f.assets,
    c.ctx,
  );
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.issues.some((i) => i.code === "support")).toBe(true);
});
test.each([true, false])(
  "ordered replacement and brush preserve explicit move authority (move=%s)",
  async (explicitMove) => {
    const c = await brushCase(false, true),
      before = structuredClone(c.base),
      variant = c.f.assets[1],
      assetRef = {
        id: variant.manifest.id,
        contentVersion: variant.manifest.contentVersion,
      };
    c.ctx.patch!.operations.unshift({
      kind: "replace",
      instanceId: c.old.instanceId,
      assetRef,
    });
    if (explicitMove)
      c.ctx.patch!.operations.unshift({
        kind: "move",
        instanceId: c.old.instanceId,
        transform: c.old.transform,
      });
    c.ctx.patch!.targetInstanceIds = [c.old.instanceId];
    const { reattachInstance } = await import("./placement");
    const terrain = value(
      await resolvePlan(
        c.base.plan,
        c.state,
        c.f.library,
        c.ctx.signal,
        c.ctx.resources,
      ),
    );
    if (variant.manifest.kind !== "object")
      throw Error("Expected object fixture");
    const next = value(
      reattachInstance(
        { ...c.old, assetRef },
        terrain.geometry,
        variant.manifest,
      ),
    );
    expect(next.transform).not.toEqual(c.old.transform);
    c.state = parseEditableState({
      ...c.state,
      overrides: [
        {
          instanceId: c.old.instanceId,
          groupId: c.old.groupId,
          kind: "replace",
          assetRef,
          transform: next.transform,
        },
      ],
    });
    const r = value(
      await resolvePlan(
        c.base.plan,
        c.state,
        c.f.library,
        c.ctx.signal,
        c.ctx.resources,
        { patch: c.ctx.patch, baseSnapshot: c.base },
      ),
    );
    c.ctx.patch!.review.assetBindings = r.assetBindings.map((x) =>
      JSON.parse(x),
    );
    const out = await compileScene(r, c.state, c.f.assets, c.ctx);
    expect(
      out.ok,
      JSON.stringify(out.ok ? out.value.snapshot.instances : out.issues),
    ).toBe(!explicitMove);
    if (!out.ok)
      expect(out.issues).toContainEqual(
        expect.objectContaining({ code: "support", path: "patch.brush" }),
      );
    else
      expect(out.value.snapshot.instances[0].transform).toEqual(next.transform);
    expect(c.base).toEqual(before);
  },
);
test("replacement cannot reattach an explicit move into a different valid transform", async () => {
  const c = await moveCase(),
    before = structuredClone(c.base);
  const requested = {
    ...c.transform,
    position: [
      c.transform.position[0],
      c.transform.position[1] + 0.06,
      c.transform.position[2],
    ] as const,
  };
  c.ctx.patch!.operations = [
    { kind: "move", instanceId: c.old.instanceId, transform: requested },
    { kind: "replace", instanceId: c.old.instanceId, assetRef: c.old.assetRef },
  ];
  // Supply the transform the vulnerable implementation would silently substitute.
  c.state.overrides[0] = { ...c.state.overrides[0], kind: "replace" } as any;
  const r = value(
    await resolvePlan(
      c.base.plan,
      c.state,
      c.f.library,
      c.ctx.signal,
      c.ctx.resources,
    ),
  );
  const out = await compileScene(r, c.state, c.f.assets, c.ctx);
  expect(out.ok).toBe(false);
  if (!out.ok)
    expect(out.issues).toContainEqual(
      expect.objectContaining({ code: "support", path: "patch.replace" }),
    );
  expect(c.base).toEqual(before);
});
test("a later explicit move supersedes the earlier move across replacement", async () => {
  const c = await moveCase(),
    before = structuredClone(c.base);
  c.ctx.patch!.operations = [
    { kind: "move", instanceId: c.old.instanceId, transform: c.old.transform },
    { kind: "replace", instanceId: c.old.instanceId, assetRef: c.old.assetRef },
    { kind: "move", instanceId: c.old.instanceId, transform: c.transform },
  ];
  const r = value(
    await resolvePlan(
      c.base.plan,
      c.state,
      c.f.library,
      c.ctx.signal,
      c.ctx.resources,
    ),
  );
  const out = value(await compileScene(r, c.state, c.f.assets, c.ctx));
  expect(
    out.snapshot.instances.find((i) => i.instanceId === c.old.instanceId)
      ?.transform,
  ).toEqual(c.transform);
  expect(c.base).toEqual(before);
});

test("transient replacement B then A is verified but excluded from saved dependencies and rebuild geometry", async () => {
  const f = await buildFixture({ unusedVariant: true }),
    a = f.assets[0],
    b = f.assets[1],
    initial = await resolve(f),
    base = value(await compileScene(initial, f.state, [a], f.context)).snapshot,
    old = base.instances[0];
  const state = parseEditableState({
    ...base.state,
    overrides: [
      {
        instanceId: old.instanceId,
        groupId: old.groupId,
        kind: "replace",
        assetRef: old.assetRef,
        transform: old.transform,
      },
    ],
  });
  const region = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ],
    operations = [
      {
        kind: "replace",
        instanceId: old.instanceId,
        assetRef: {
          id: b.manifest.id,
          contentVersion: b.manifest.contentVersion,
        },
      },
      { kind: "replace", instanceId: old.instanceId, assetRef: old.assetRef },
    ];
  const patch: any = {
    documentType: "general-scene-patch",
    schemaVersion: 1,
    patchId: "transient",
    baseRevisionId: base.revisionId,
    raw: "replace B then return A",
    requestedRegion: region,
    effectiveRegion: region,
    targetInstanceIds: [old.instanceId],
    lockedInstanceIds: [],
    affectedInstanceIds: [old.instanceId],
    affectedTileIds: [],
    operations,
    review: {
      scopeAccepted: true,
      planDigest: await documentDigest(base.plan),
      catalogDigest: f.library.digest,
      assetBindings: [],
    },
  };
  const ctx = {
    ...f.context,
    operationId: "transient-op",
    revisionId: "transient-revision",
    baseRevisionId: base.revisionId,
    baseSnapshot: base,
    patch,
  };
  const r = value(
    await resolvePlan(base.plan, state, f.library, ctx.signal, ctx.resources, {
      patch,
      baseSnapshot: base,
    }),
  );
  patch.review.assetBindings = r.assetBindings.map((x) => JSON.parse(x));
  const out = await compileScene(r, state, [a, b], ctx);
  // No-op final replacements have no changed instance bytes; T4 requires explicit target membership, so report that exact conflict, never invent a difference.
  expect(r.transientRefs).toEqual([
    { id: b.manifest.id, contentVersion: b.manifest.contentVersion },
  ]);
  expect(out.ok).toBe(false);
  if (!out.ok)
    expect(out.issues.some((i) => i.path === "patch.affectedInstanceIds")).toBe(
      true,
    );
  const moved = {
    ...old.transform,
    position: [
      old.transform.position[0] + 0.03,
      old.transform.position[1],
      old.transform.position[2],
    ] as const,
  };
  patch.operations.push({
    kind: "move",
    instanceId: old.instanceId,
    transform: moved,
  });
  const finalState = parseEditableState({
    ...state,
    overrides: [{ ...state.overrides[0], kind: "move", transform: moved }],
  });
  const next = value(
    await resolvePlan(
      base.plan,
      finalState,
      f.library,
      ctx.signal,
      ctx.resources,
      { patch, baseSnapshot: base },
    ),
  );
  const compiled = value(await compileScene(next, finalState, [a, b], ctx));
  expect(compiled.snapshot.assets.map((x) => x.assetRef.id)).toEqual([
    a.manifest.id,
  ]);
  const rebuilt = value(
    await resolvePlan(
      compiled.snapshot.plan,
      compiled.snapshot.state,
      f.library,
      ctx.signal,
      ctx.resources,
      { patch: null, baseSnapshot: compiled.snapshot },
    ),
  );
  const again = value(
    await compileScene(rebuilt, compiled.snapshot.state, [a], {
      ...ctx,
      operationId: "rebuild-transient",
      revisionId: "rebuild-transient-revision",
      baseRevisionId: compiled.snapshot.revisionId,
      baseSnapshot: compiled.snapshot,
      patch: null,
    }),
  );
  expect(again.snapshot.geometryDigest).toBe(compiled.snapshot.geometryDigest);
});
test("20 instances compile while a 21st is rejected at the contract boundary", async () => {
  const f = await buildFixture({ count: 20 });
  expect(
    value(await compileScene(await resolve(f), f.state, f.assets, f.context))
      .snapshot.instances,
  ).toHaveLength(20);
  expect(() =>
    parseScenePlan({
      ...f.draft,
      groups: [
        ...f.draft.groups,
        { ...f.draft.groups[0], groupId: "extra", count: 1 },
      ],
    }),
  ).toThrow();
});
test("exact 250000 worst points compile on fixed patch; 250001 reject without reducing sources", async () => {
  for (const points of [249996, 249997]) {
    const f = await buildFixture({ patch: true, points }),
      r = await resolve(f),
      out = await compileScene(r, f.state, f.assets, f.context);
    expect(out.ok).toBe(points === 249996);
    if (out.ok)
      expect(out.value.snapshot.validation.usage.worstSplats).toBe(250000);
    else expect(out.issues.some((i) => i.code === "budget")).toBe(true);
  }
}, 15000);
test("actual compiled residency accepts exact 256MiB transition and rejects one additional byte", async () => {
  const f = await buildFixture(),
    r = await resolve(f),
    out = value(await compileScene(r, f.state, f.assets, f.context)),
    retained = 256 * 1024 ** 2 - out.snapshot.validation.usage.transitionBytes;
  const exact = value(
    await compileScene(r, f.state, f.assets, {
      ...f.context,
      resources: { retainedBytes: retained },
    }),
  );
  expect(exact.snapshot.validation.usage.transitionBytes).toBe(256 * 1024 ** 2);
  const over = await compileScene(r, f.state, f.assets, {
    ...f.context,
    resources: { retainedBytes: retained + 1 },
  });
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.issues.some((i) => i.code === "budget")).toBe(true);
});

test("the actual local catalog has no admitted styles and every candidate is rejected before member acquisition", async () => {
  const { loadLibrary } = await import("./asset-library-server");
  const library = await loadLibrary(".local/general-scene-library/index.json");
  expect(library.styles).toEqual([]);
  expect(library.manifests).toHaveLength(3);
  let fetches = 0;
  const source = {
    ...library,
    resolveMember: async () => {
      fetches++;
      throw Error("Admission must precede source bytes");
    },
  };
  const f = await buildFixture();
  for (const m of library.manifests) {
    expect(m.quality.status).toBe("candidate");
    expect(m.quality.humanReview).toBe(null);
    const draft = parseScenePlan({
      ...f.draft,
      review: {
        ...f.draft.review,
        substitutions: [],
        acceptedSubstitutions: [],
        manualOverrides: [],
      },
      catalogDigest: library.digest,
      groups: [
        {
          ...f.draft.groups[0],
          assetRef: { id: m.id, contentVersion: m.contentVersion },
        },
      ],
    });
    const result = await resolvePlan(
      draft,
      f.state,
      source,
      f.context.signal,
      f.context.resources,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.some((i) => i.code === "asset-admission")).toBe(
        true,
      );
  }
  expect(fetches).toBe(0);
});

test("aggregate legal declarations reach the exact 128MiB preallocation boundary; one extra byte stops before resolver", async () => {
  const { assetContentVersion, assertAssetLayout } =
      await import("./asset-package"),
    { createCatalogView, makeAssetLibrary } = await import("./asset-library");
  const f = await buildFixture({ categories: ["rock", "grass", "reed"] });
  for (const extra of [0, 1]) {
    const points = 248000,
      bytes = points * 56,
      totalLicense =
        128 * 1024 ** 2 - (9 * bytes + 8 * 1024 ** 2 + 10201 * 64) + extra,
      manifests: (typeof f.assets)[number]["manifest"][] = [];
    for (const [index, asset] of f.assets.entries()) {
      const m: any = structuredClone(asset.manifest),
        review = structuredClone(m.quality.humanReview);
      m.quality.status = "candidate";
      m.quality.humanReview = null;
      m.gaussian.full.points = points;
      m.files.find((file: any) => file.path.endsWith(".f32")).bytes = bytes;
      m.files.find((file: any) => file.path === "license.txt").bytes =
        index === 0 ? totalLicense - 2 : 1;
      m.resources.decodedBytes = bytes;
      m.resources.cpuSourceBytes = bytes + (index === 0 ? totalLicense - 2 : 1);
      m.resources.uploadBytes = bytes;
      m.contentVersion = await assetContentVersion(m);
      m.quality.status = "accepted";
      m.quality.humanReview = {
        ...review,
        asset: { id: m.id, contentVersion: m.contentVersion },
      };
      assertAssetLayout(m);
      manifests.push(m);
    }
    let calls = 0;
    const library = makeAssetLibrary(
      await createCatalogView(manifests, [f.style]),
      async () => {
        calls++;
        throw Error("PREALLOCATION_BOUNDARY_PROBE_NO_PAYLOAD");
      },
    );
    const draft = parseScenePlan({
      ...f.draft,
      catalogDigest: library.digest,
      groups: f.draft.groups.map((g) => ({
        ...g,
        assetRef: {
          id: g.assetRef!.id,
          contentVersion: manifests.find((m) => m.id === g.assetRef!.id)!
            .contentVersion,
        },
      })),
      review: {
        ...f.draft.review,
        substitutions: [],
        acceptedSubstitutions: [],
        manualOverrides: [],
      },
    });
    const out = await resolvePlan(
      draft,
      f.state,
      library,
      f.context.signal,
      f.context.resources,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw Error("probe");
    expect(calls).toBe(extra === 0 ? 1 : 0);
    expect(out.issues.some((i) => i.code === "budget")).toBe(extra === 1);
    if (extra === 0)
      expect(out.issues[0].message).toContain(
        "PREALLOCATION_BOUNDARY_PROBE_NO_PAYLOAD",
      );
  }
});

test("an explicit suggested water level is still binding and an absent level needs actual solver provenance", async () => {
  const { validateBuildSemantics } = await import("./compile");
  const f = await buildFixture({ river: true }),
    r = await resolve(f);
  const intent = {
    ...f.intent,
    water: {
      ...f.intent.water,
      constraints: [
        {
          key: "level",
          value: 0.05,
          source: "manual" as const,
          span: null,
          strength: "suggestion" as const,
          negated: false,
        },
      ],
    },
  };
  expect(
    validateBuildSemantics(
      r.plan,
      { ...f.context, intent },
      f.assets.map((a) => a.manifest),
    ).some((i) => i.code === "semantic"),
  ).toBe(true);
  const missing = {
    ...f.intent,
    water: { ...f.intent.water, constraints: [] },
  };
  const draft = parseScenePlan({
      ...f.draft,
      intentDigest: await documentDigest(missing),
    }),
    resolved = value(
      await resolvePlan(
        draft,
        f.state,
        f.library,
        f.context.signal,
        f.context.resources,
      ),
    );
  const out = await compileScene(resolved, f.state, f.assets, {
    ...f.context,
    intent: missing,
  });
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.issues.some((i) => i.code === "semantic")).toBe(true);
});

async function sh3PatchBudgetCase(points: number, exactCandidate = false) {
  const { generalFixture } =
    await import("../../tests/support/general-fixture");
  const { assetContentVersion, assertAssetLayout } =
    await import("./asset-package");
  const { createCatalogView, makeAssetLibrary } =
    await import("./asset-library");
  const { parseAssetManifest } = await import("./asset-manifest");
  const { jsonDigest } = await import("../io/prepared-ground");
  const { sha256 } = await import("../io/hash");
  const f = await buildFixture({ patch: true }),
    p = await generalFixture({ patch: true, sh3: true, count: points });
  const m: any = structuredClone(p.manifest);
  const coarse = m.files
    .filter((x: any) => x.path.includes("-full-"))
    .map((x: any) => ({ ...x, path: x.path.replace("-full-", "-coarse-") }));
  for (const file of coarse)
    p.members.set(
      file.path,
      new Uint8Array(p.members.get(file.path.replace("-coarse-", "-full-"))!),
    );
  m.files.push(...coarse);
  m.gaussian.coarse = {
    ...structuredClone(m.gaussian.full),
    sha256: await jsonDigest(coarse),
  };
  m.patch.heightProxy.maxError = 0;
  const object = f.packages.find((x) => x.manifest.kind === "object")!;
  const objectRaw = object.manifest.files.reduce((n, x) => n + x.bytes, 0);
  const decoded = Math.ceil(points / 2048) * 2048 * 16 * 12 + 1681 * 16;
  const maximum = Math.max(...m.files.map((x: any) => x.bytes));
  if (exactCandidate) {
    const currentRaw =
      objectRaw + m.files.reduce((n: number, x: any) => n + x.bytes, 0);
    const currentPeak =
      2 * currentRaw + decoded + 8 * 1024 ** 2 + 3 * maximum + 10201 * 64;
    const padding = (128 * 1024 ** 2 - currentPeak) / 2;
    expect(Number.isSafeInteger(padding) && padding > 0).toBe(true);
    const license = m.files.find((x: any) => x.path === "license.txt");
    const bytes = new Uint8Array(license.bytes + padding).fill(32);
    bytes.set(p.members.get("license.txt")!);
    p.members.set("license.txt", bytes);
    license.bytes = bytes.length;
    license.sha256 = await sha256(bytes);
  }
  const n = m.files.reduce((n: number, x: any) => n + x.bytes, 0);
  m.resources = { cpuSourceBytes: n, decodedBytes: n, uploadBytes: n };
  m.contentVersion = await assetContentVersion(m);
  const admission = f.assets.find((a) => a.manifest.kind === "patch")!.manifest
    .quality;
  m.gaussian.full.quality = {
    status: "passed",
    report: "docs/constructed-only.md",
  };
  m.gaussian.coarse.quality = { ...m.gaussian.full.quality };
  m.quality = {
    ...admission,
    humanReview: {
      ...admission.humanReview,
      asset: { id: m.id, contentVersion: m.contentVersion },
      files: m.files.map(({ path, sha256 }: any) => ({ path, sha256 })),
    },
  };
  const manifest = parseAssetManifest(m);
  const library = makeAssetLibrary(
    await createCatalogView([object.manifest, manifest], []),
    async (r, path, signal) => {
      signal.throwIfAborted();
      return r.id === manifest.id
        ? p.members.get(path)!
        : object.members.get(path)!;
    },
  );
  const draft = parseScenePlan({
    ...f.draft,
    catalogDigest: library.digest,
    review: {
      ...f.draft.review,
      substitutions: [],
      acceptedSubstitutions: [],
      manualOverrides: [],
    },
    terrain: {
      ...f.draft.terrain,
      assetRef: { id: manifest.id, contentVersion: manifest.contentVersion },
      transform: m.patch.displayTransform,
    },
  });
  const raw = objectRaw + n,
    peak = 2 * raw + decoded + 8 * 1024 ** 2 + 3 * maximum + 10201 * 64;
  expect(assertAssetLayout(manifest).decodedBytes).toBe(decoded);
  return { f, draft, library, peak, raw, decoded };
}
test("patch resolution rejects the reproduced full/coarse SH3 decode peak before loadAsset allocates", async () => {
  const { acquireBuildInputs, resolvePreparedPlan } = await import("./compile");
  const c = await sh3PatchBudgetCase(249996);
  const inputs = await acquireBuildInputs(
    c.draft,
    c.f.state,
    c.library,
    c.f.context.signal,
    { retainedBytes: 0 },
  );
  expect(c.peak).toBeGreaterThan(128 * 1024 ** 2);
  const loader = vi
    .spyOn(assetLoader, "loadAsset")
    .mockRejectedValue(Error("UNEXPECTED_DECODE_ALLOCATION"));
  try {
    for (const retainedBytes of [0, 256 * 1024 ** 2 - (c.peak - c.decoded)]) {
      const out = await resolvePreparedPlan(
        c.draft,
        c.f.state,
        inputs,
        c.f.context.signal,
        { retainedBytes },
      );
      expect(out.ok).toBe(false);
      if (!out.ok)
        expect(out.issues).toContainEqual(
          expect.objectContaining({ code: "budget" }),
        );
    }
    const direct = await resolvePlan(
      c.draft,
      c.f.state,
      c.library,
      c.f.context.signal,
      { retainedBytes: 0 },
    );
    expect(direct.ok).toBe(false);
    if (!direct.ok)
      expect(direct.issues).toContainEqual(
        expect.objectContaining({ code: "budget" }),
      );
    expect(loader).not.toHaveBeenCalled();
  } finally {
    loader.mockRestore();
  }
}, 15000);
test("patch decode preflight admits exact 128/256MiB and rejects one retained byte before decoding", async () => {
  const { acquireBuildInputs, resolvePreparedPlan, buildOwnedBytes } =
    await import("./compile");
  const c = await sh3PatchBudgetCase(198000, true);
  expect(c.peak).toBe(128 * 1024 ** 2);
  const inputs = await acquireBuildInputs(
    c.draft,
    c.f.state,
    c.library,
    c.f.context.signal,
    { retainedBytes: 0 },
  );
  const loader = vi.spyOn(assetLoader, "loadAsset");
  try {
    const exact = value(
      await resolvePreparedPlan(
        c.draft,
        c.f.state,
        inputs,
        c.f.context.signal,
        { retainedBytes: 128 * 1024 ** 2 },
      ),
    );
    expect(exact.geometry.field.heights).toHaveLength(1681);
    expect(buildOwnedBytes(inputs)).toBe(c.raw);
    expect(loader).toHaveBeenCalledTimes(1);
    loader.mockClear();
    const over = await resolvePreparedPlan(
      c.draft,
      c.f.state,
      inputs,
      c.f.context.signal,
      { retainedBytes: 128 * 1024 ** 2 + 1 },
    );
    expect(over.ok).toBe(false);
    if (!over.ok)
      expect(over.issues).toContainEqual(
        expect.objectContaining({ code: "budget" }),
      );
    expect(loader).not.toHaveBeenCalled();
  } finally {
    loader.mockRestore();
  }
}, 15000);
