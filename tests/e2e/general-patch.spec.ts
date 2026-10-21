import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const call = (page: Page, action: string, options: any = {}) =>
  page.evaluate(
    ({ action, options }) => (window as any).general.patch(action, options),
    { action, options },
  );
const ready = async (page: Page) => {
  await page.goto("/tests/general-harness.html");
  await page.waitForFunction(() => (window as any).general?.ready);
};
const attach = async (info: TestInfo, name: string, value: unknown) => {
  const path = info.outputPath(name + ".json");
  writeFileSync(path, JSON.stringify(value, null, 2));
  await info.attach(name, { path, contentType: "application/json" });
};
const screenshot = async (page: Page, info: TestInfo, name: string) => {
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
};
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const id = (s: any, name: string) =>
  s.instances.find((i: any) => i.instanceId === name);
const slot = (s: any) =>
  s.state.groups.find((g: any) => g.groupId === "rock").nextSlot;
const sameParent = (actual: any, expected: any) => {
  for (const key of [
    "documentDigest",
    "stateDigest",
    "geometryDigest",
    "terrainDigest",
    "waterDigest",
    "surfaceDigest",
  ])
    expect(actual[key], key).toBe(expected[key]);
  expect(actual.instances).toEqual(expected.instances);
  expect(actual.state).toEqual(expected.state);
};

test("exposes the real patch proposal and preview harness", async ({
  page,
}) => {
  await ready(page);
  expect(await page.evaluate(() => typeof (window as any).general.patch)).toBe(
    "function",
  );
});

test("keeps far tiles byte-identical after brush and reopen", async ({
  page,
}, info) => {
  test.setTimeout(300000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  let current = await call(page, "seed");
  const initial = current,
    labels = { ...initial.labels },
    rows: any[] = [],
    snapshots = new Map<string, any>();
  const region = initial.region,
    brushRegion = initial.brushRegion;
  const farIds = initial.tiles
    .filter((t: any) => t.bounds.min[0] >= 1 && t.bounds.min[1] >= 1)
    .map((t: any) => t.tileId);
  expect(farIds.length).toBeGreaterThan(0);
  const far = (s: any) => s.tiles.filter((t: any) => farIds.includes(t.tileId));
  const beforeFarDigest = digest(far(initial));
  const original = id(initial, labels.A).assetRef,
    variant = id(initial, labels.F).assetRef;
  expect(original).not.toEqual(variant);
  const check = (s: any) => {
    const afterFarDigest = digest(far(s));
    expect(afterFarDigest).toBe(beforeFarDigest);
    expect(id(s, labels.F)).toEqual(id(initial, labels.F));
    expect(id(s, labels.lock)).toEqual(id(initial, labels.lock));
    expect(s.usage.candidateCpuBytes).toBeLessThanOrEqual(128 * 1024 ** 2);
    expect(s.usage.transitionBytes).toBeLessThanOrEqual(256 * 1024 ** 2);
    expect(s.stats.activeSplats).toBe(s.usage.worstSplats);
  };
  const record = async (step: number, kind: string, s: any) => {
    check(s);
    rows.push({
      step,
      kind,
      ...s,
      farTileIds: farIds,
      farDigest: digest(far(s)),
    });
    snapshots.set(s.revisionId, s);
    await attach(
      info,
      `step-${String(step).padStart(2, "0")}-${kind}`,
      rows.at(-1),
    );
    current = s;
  };
  const propose = async (step: number, operations: any[], R = region) => {
    const before = await call(page, "status");
    const historyBefore = await call(page, "history");
    const p = await call(page, "propose", {
      operations,
      region: R,
      patchId: `patch-${step}`,
      operationId: `patch-op-${step}`,
      revisionId: `patch-revision-${step}`,
    });
    expect(p.proposal.patch.review.scopeAccepted).toBe(false);
    expect(p.counts.build).toBe(before.counts.build);
    expect(await call(page, "history")).toEqual(historyBefore);
    sameParent(p.parent, current);
    expect(p.proposal.patch.affectedInstanceIds).toEqual(
      p.proposal.changedInstanceIds,
    );
    expect(p.proposal.patch.affectedTileIds).toEqual(p.proposal.changedTileIds);
    return p;
  };
  const compareLocal = (
    parent: any,
    candidate: any,
    p: any,
    brush: boolean,
  ) => {
    const changed = p.changedInstanceIds;
    for (const old of parent.instances)
      if (!changed.includes(old.instanceId))
        expect(id(candidate, old.instanceId)).toEqual(old);
    if (!brush) {
      expect(p.effectiveRegion).toEqual(p.requestedRegion);
      expect(candidate.tiles).toEqual(parent.tiles);
    } else {
      expect(p.changedTileIds.length).toBeGreaterThan(0);
      expect(p.changedTileIds.length).toBeLessThan(parent.tiles.length);
      for (const t of parent.tiles)
        if (!p.changedTileIds.includes(t.tileId))
          expect(
            candidate.tiles.find((x: any) => x.tileId === t.tileId),
          ).toEqual(t);
      const contains = (region: any[], point: number[]) =>
        point[0] >= Math.min(...region.map((p) => p[0])) &&
        point[0] <= Math.max(...region.map((p) => p[0])) &&
        point[1] >= Math.min(...region.map((p) => p[1])) &&
        point[1] <= Math.max(...region.map((p) => p[1]));
      const witness = id(parent, labels.G).transform.position;
      expect(contains(p.effectiveRegion, [witness[0], witness[2]])).toBe(true);
      expect(contains(p.requestedRegion, [witness[0], witness[2]])).toBe(false);
      const g = id(candidate, labels.G),
        old = id(parent, labels.G);
      expect(g.instanceId).toBe(old.instanceId);
      expect(g.assetRef).toEqual(old.assetRef);
      expect(g.transform.position[0]).toBe(old.transform.position[0]);
      expect(g.transform.position[2]).toBe(old.transform.position[2]);
      expect(g.transform.quaternion).toEqual(old.transform.quaternion);
      expect(g.transform.scale).toBe(old.transform.scale);
    }
  };
  const edit = async (
    step: number,
    kind: string,
    operations: any[],
    R = region,
    pictures = false,
  ) => {
    const parent = current,
      p = await propose(step, operations, R);
    if (pictures) await screenshot(page, info, `${kind}-parent`);
    let shown = await call(page, "preview");
    expect(shown.diff.instances.map((i: any) => i.instanceId).sort()).toEqual(
      [...p.proposal.changedInstanceIds].sort(),
    );
    expect(shown.diff.heights.every((h: any) => h.insideBrush)).toBe(true);
    if (operations.some((o) => o.kind === "brush"))
      expect(shown.diff.heights.length).toBeGreaterThan(0);
    compareLocal(
      parent,
      shown.candidate,
      p.proposal,
      operations.some((o) => o.kind === "brush"),
    );
    if (pictures) {
      await screenshot(page, info, `${kind}-candidate`);
      await call(page, "overlay", { visible: true });
      await screenshot(page, info, `${kind}-reviewed-R-H-overlay`);
      await call(page, "overlay", { visible: false });
      const beforeCancelHistory = await call(page, "history");
      const cancelled = await call(page, "cancel");
      expect(await call(page, "history")).toEqual(beforeCancelHistory);
      sameParent(cancelled.parent, parent);
      expect(cancelled.elapsedMs).toBeLessThan(1000);
      expect(cancelled.parent.camera).toEqual(shown.candidate.camera);
      expect(cancelled.parent.busy).toBe(false);
      await screenshot(page, info, `${kind}-cancelled`);
      await attach(info, `${kind}-parent-candidate-cancel-diff`, {
        parent,
        candidate: shown.candidate,
        actualDiff: shown.diff,
        cancelled,
        requestedRegion: p.proposal.requestedRegion,
        effectiveRegion: p.proposal.effectiveRegion,
        changedInstanceIds: p.proposal.changedInstanceIds,
        changedTileIds: p.proposal.changedTileIds,
      });
      await propose(step, operations, R);
      shown = await call(page, "preview");
    }
    const saved = await call(page, "commit");
    expect(saved.receipt.revisionId).toBe(saved.revisionId);
    expect(saved.parentRevisionId).toBe(parent.revisionId);
    expect(saved.geometryDigest).toBe(shown.candidate.geometryDigest);
    await record(step, kind, saved);
    return saved;
  };
  const undo = async (step: number, target: any) => {
    const s = await call(page, "undo", {
      target: target.revisionId,
      operationId: `undo-${step}`,
    });
    sameParent(s, target);
    await record(step, "undo", s);
    return s;
  };
  await attach(info, "initial-engineering-environment", {
    initial,
    diagnostics: await page.evaluate(() =>
      (window as any).general.diagnostics(),
    ),
  });
  // Every numbered row below is a real committed edit or native checkout. Reloads, cancellation and archive checkpoints are not counted.
  const s1 = await edit(1, "remove-A", [
    { kind: "remove", instanceId: labels.A },
  ]);
  expect(s1.state.tombstones).toContain(labels.A);
  expect(slot(s1)).toBe(slot(initial));
  await page.reload();
  await page.waitForFunction(() => (window as any).general?.ready);
  current = await call(page, "open");
  sameParent(current, s1);
  expect(current.counts).toEqual({
    propose: 0,
    resolve: 0,
    build: 0,
    workers: 0,
    moduleWorkers: 0,
    posted: 0,
    terminated: 0,
  });
  await attach(info, "checkpoint-A-native-reopen-zero-generation", current);
  const s2 = await edit(2, "add-C", [
    { kind: "add", groupId: "rock", assetRef: original, count: 1 },
  ]);
  labels.C = `rock:${slot(s1)}`;
  expect(id(s2, labels.C)).toBeTruthy();
  expect(labels.C).not.toBe(labels.A);
  expect(s2.state.tombstones).toContain(labels.A);
  await page.reload();
  await page.waitForFunction(() => (window as any).general?.ready);
  current = await call(page, "open");
  sameParent(current, s2);
  const replay = await call(page, "replay", {
    ref: s2.receipt,
    base: s1.revisionId,
  });
  expect(replay.receipt.duplicate).toBe(true);
  sameParent(replay.current, s2);
  expect(replay.after).toEqual(replay.before);
  await attach(info, "duplicate-after-reopen", replay);
  const move = (s: any, which: string, dx: number) => ({
    ...id(s, which).transform,
    position: [
      id(s, which).transform.position[0] + dx,
      id(s, which).transform.position[1],
      id(s, which).transform.position[2],
    ],
  });
  const moved3 = move(current, labels.B, 0.12);
  await edit(3, "move-B", [
    { kind: "move", instanceId: labels.B, transform: moved3 },
  ]);
  expect(id(current, labels.B).transform).toEqual(moved3);
  const s4 = await edit(4, "replace-B", [
    { kind: "replace", instanceId: labels.B, assetRef: variant },
  ]);
  expect(id(s4, labels.B).assetRef).toEqual(variant);
  expect(id(s4, labels.B).transform).toEqual(moved3);
  const s5 = await edit(5, "increase-local-count", [
    { kind: "set-count", groupId: "rock", count: 3 },
  ]);
  labels.D = `rock:${slot(s4)}`;
  expect(id(s5, labels.D)).toBeTruthy();
  expect(id(s5, labels.B)).toEqual(id(s4, labels.B));
  expect(id(s5, labels.C)).toEqual(id(s4, labels.C));
  await undo(6, s4);
  await edit(7, "reduce-local-count", [
    { kind: "set-count", groupId: "rock", count: 1 },
  ]);
  expect(id(current, labels.B)).toEqual(id(s4, labels.B));
  expect(id(current, labels.C)).toBeUndefined();
  await undo(8, s4);
  const moved9 = move(current, labels.B, -0.08);
  await edit(9, "replace-then-move-B", [
    { kind: "replace", instanceId: labels.B, assetRef: original },
    { kind: "move", instanceId: labels.B, transform: moved9 },
  ]);
  expect(id(current, labels.B).transform).toEqual(moved9);
  expect(id(current, labels.B).assetRef).toEqual(original);
  await undo(10, s4);
  await edit(
    11,
    "brush-one",
    [{ kind: "brush", center: [-2, -1.7], radius: 0.4, delta: 0.04 }],
    brushRegion,
    true,
  );
  expect(current.state.brushes).toHaveLength(1);
  const s12 = await edit(
    12,
    "brush-two",
    [{ kind: "brush", center: [-2, -1.7], radius: 0.4, delta: 0.015 }],
    brushRegion,
  );
  expect(s12.state.brushes).toHaveLength(2);
  expect(s12.state.brushes.map((b: any) => b.sequence)).toEqual([1, 2]);
  await page.reload();
  await page.waitForFunction(() => (window as any).general?.ready);
  current = await call(page, "open");
  sameParent(current, s12);
  check(current);
  expect(current.counts.build).toBe(0);
  const archive = await call(page, "export");
  writeFileSync(
    info.outputPath("checkpoint-B-embedded.zip"),
    Buffer.from(archive.bytes),
  );
  await attach(info, "checkpoint-B-archive", {
    digest: archive.digest,
    bytes: archive.bytes.length,
    current: archive.current,
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).general?.ready);
  const imported = await call(page, "import", { bytes: archive.bytes });
  current = imported;
  expect(imported.geometryDigest).toBe(s12.geometryDigest);
  expect(imported.state).toEqual(s12.state);
  expect(imported.instances).toEqual(s12.instances);
  expect(imported.tiles).toEqual(s12.tiles);
  expect(imported.counts.build).toBe(0);
  expect(imported.counts.resolve).toBe(0);
  expect(imported.counts.workers).toBe(0);
  expect(imported.sceneId).not.toBe(s12.sceneId);
  expect(imported.parentRevisionId).toBe(s12.parentRevisionId);
  expect(imported.historyNotice).toMatch(/此前撤销历史|history/i);
  check(imported);
  const rebuilt = await call(page, "rebuild");
  expect(rebuilt.rebuilt.geometryDigest).toBe(s12.geometryDigest);
  expect(rebuilt.rebuilt.instances).toEqual(s12.instances);
  expect(rebuilt.rebuilt.tiles).toEqual(s12.tiles);
  expect(rebuilt.rebuilt.terrainDigest).toBe(s12.terrainDigest);
  expect(rebuilt.rebuilt.surfaceDigest).toBe(s12.surfaceDigest);
  expect(rebuilt.counts.build).toBe(1);
  expect(rebuilt.counts.moduleWorkers).toBeGreaterThan(0);
  await attach(info, "checkpoint-B-independent-import-explicit-rebuild", {
    imported,
    rebuilt,
  });
  const i13 = await edit(13, "imported-add-E", [
    { kind: "add", groupId: "rock", assetRef: original, count: 1 },
  ]);
  labels.E = `rock:${slot(imported)}`;
  expect(labels.E).not.toBe(labels.A);
  expect(id(i13, labels.E)).toBeTruthy();
  expect(i13.parentRevisionId).toBe(imported.revisionId);
  await edit(14, "remove-E", [{ kind: "remove", instanceId: labels.E }]);
  expect(current.state.tombstones).toContain(labels.E);
  await undo(15, i13);
  expect(id(current, labels.E)).toEqual(id(i13, labels.E));
  await edit(16, "remove-highest-local-slot", [
    { kind: "set-count", groupId: "rock", count: 2 },
  ]);
  expect(id(current, labels.E)).toBeUndefined();
  expect(id(current, labels.B)).toEqual(id(i13, labels.B));
  await undo(17, i13);
  expect(current.state.brushes).toHaveLength(2);
  expect(current.state.tombstones).toContain(labels.A);
  const cancelled = await call(page, "cancel-inflight");
  expect(cancelled.observed).toEqual({ created: 1, posted: 1, terminated: 1 });
  expect(cancelled.result.ok).toBe(false);
  expect(cancelled.result.issues[0].code).toBe("cancelled");
  expect(cancelled.elapsedMs).toBeLessThan(1000);
  sameParent(cancelled.parent, i13);
  expect(cancelled.parent.busy).toBe(false);
  await attach(info, "actual-worker-cancellation", cancelled);
  const moved18 = move(current, labels.B, 0.06);
  const i18 = await edit(
    18,
    "move-B-after-cancel",
    [{ kind: "move", instanceId: labels.B, transform: moved18 }],
    region,
    true,
  );
  expect(id(i18, labels.B).transform).toEqual(moved18);
  await edit(19, "replace-C", [
    { kind: "replace", instanceId: labels.C, assetRef: variant },
  ]);
  expect(id(current, labels.C).assetRef).toEqual(variant);
  expect(id(current, labels.B).transform).toEqual(moved18);
  await undo(20, i18);
  expect(rows).toHaveLength(20);
  expect(rows.map((r) => r.step)).toEqual(
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  for (const [revisionId, saved] of snapshots)
    sameParent(await call(page, "read", { revisionId }), saved);
  expect(initial.counts.moduleWorkers).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await attach(info, "twenty-actual-edits-and-checkouts", {
    labels,
    farTileIds: farIds,
    beforeFarDigest,
    rows,
    errors,
  });
});
