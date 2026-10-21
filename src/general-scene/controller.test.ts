import { makeAssetLibrary, type AssetLibrary } from "./asset-library";
import { documentDigest } from "./canonical";
import {
  makeManualDraft,
  confirmProceduralChoices,
  proceduralChoices,
} from "./manual-plan";
import { beforeAll, expect, test, vi } from "vitest";
import {
  createSceneController,
  createBrowserPlanner,
  collectBuffers,
} from "./controller";
import { buildFixture } from "../../tests/support/general-build-fixture";
import {
  compileScene,
  resolvePlan,
  acquireBuildInputs,
  proposePreparedPatch,
} from "./compile";
import type { BuildClient } from "./worker-client";
import type { SceneStore } from "./storage";
import { encodeGeneralArchive, checkIO } from "./archive";
import { GENERAL_LIMITS } from "./core";
import { patchFixture } from "./test-fixtures";
import type { GeneralView, GeneralSwap } from "./render/types";
const take = <T>(r: any): T => {
  if (!r.ok) throw Error(JSON.stringify(r.issues));
  return r.value;
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
let f: Awaited<ReturnType<typeof buildFixture>>;
beforeAll(async () => {
  f = await buildFixture({ count: 1 });
});
function setup(fixture = f) {
  let lib = fixture.library,
    usable = true,
    preparing = false,
    saved: any = null;
  const prepared = deferred<void>();
  const swap: GeneralSwap = {
    activate: vi.fn(),
    rollback: vi.fn(),
    commit: vi.fn(),
    isUsable: () => usable,
  };
  const view: GeneralView = {
    activity: () => ({ preparing: false, available: true }),
    whenPreparationSettled: async () => {},
    prepare: vi.fn(async () => swap),
    getCamera: () => fixture.context.camera,
    setCamera: vi.fn(),
    stats: () => ({
      ownedBytes: 0,
      sourceCount: 0,
      instanceCount: 0,
      activeSplats: 0,
    }),
    render: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const client: BuildClient = {
    resolve: vi.fn(async (d, s, l, c) => {
      lib = l;
      return resolvePlan(d, s, l, c.signal, c.resources, c.dependencies);
    }),
    build: vi.fn(compileScene),
    propose: vi.fn(async (b, p, l, c) =>
      proposePreparedPatch(
        b,
        p,
        await acquireBuildInputs(b.plan, b.state, l, c.signal, c.resources, {
          patch: p,
          baseSnapshot: b,
        }),
        c,
      ),
    ),
    activity: () => ({ busy: preparing, preparing }),
    whenPreparationSettled: () =>
      preparing ? prepared.promise : Promise.resolve(),
    operationLibrary: () => lib,
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
  const store = {
    stage: vi.fn(async (s: any) => {
      saved = s;
      return {
        sceneId: s.sceneId,
        revisionId: s.revisionId,
        operationId: s.operationId,
      };
    }),
    commit: vi.fn(async (ref: any) => ({ ...ref, duplicate: false })),
    open: vi.fn(async () => saved),
    readRevision: vi.fn(async () => saved),
    libraryForRevision: vi.fn(async () => lib),
    discardStage: vi.fn(async () => {}),
    checkout: vi.fn(),
    list: vi.fn(async () => []),
  } as unknown as SceneStore;
  const planner = vi.fn(async (r: any, _s: any, phase: any) => {
    phase("parsing");
    return {
      ok: false as const,
      request: r,
      query: null,
      inputs: [],
      issues: [{ code: "offline", path: "planner", message: "offline" }],
      partial: { intent: null, draft: null, evidence: [] },
      mode: "manual" as const,
    };
  });
  const ports = {
    planner,
    buildClient: client,
    store,
    library: async () => lib,
    display: {
      current: () => view,
      views: () => [view],
      waitForDisplayed: vi.fn(async () => {
        if (!usable) throw Error("not drawn");
      }),
      replace: vi.fn(async () => view),
      showLegacy: vi.fn(async () => {}),
    },
    externalResidency: () => ({
      buffers: [] as ArrayBuffer[],
      extraBytes: 0,
      settled: true,
    }),
  };
  const c = createSceneController(ports);
  const request = {
    operationId: fixture.context.intent.requestId,
    prompt: fixture.context.intent.raw,
    baseRevisionId: null,
    manualOverrides: [],
  };
  const review = async () => {
    await c.plan(request);
    return take<any>(
      await c.review(fixture.draft, [], {
        kind: "manual-intent",
        intent: fixture.context.intent,
      }),
    );
  };
  const preview = async () => take<any>(await c.preview(await review()));
  return {
    c,
    ports,
    client,
    store,
    swap,
    view,
    request,
    review,
    preview,
    setUsable: (v: boolean) => (usable = v),
    setPreparing: (v: boolean) => (preparing = v),
    prepared,
  };
}
test("deduplicates frozen request, retains original offline evidence and manual review builds without model retry", async () => {
  const x = setup();
  const a = x.c.plan(x.request),
    b = x.c.plan(structuredClone(x.request));
  expect(a).toBe(b);
  await a;
  expect(x.ports.planner).toHaveBeenCalledTimes(1);
  const r = await x.c.review(f.draft, [], {
    kind: "manual-intent",
    intent: f.context.intent,
  });
  expect(r.ok).toBe(true);
  expect(x.ports.planner).toHaveBeenCalledTimes(1);
  expect(x.c.getState().planning?.ok).toBe(false);
});
test("cancel leaves idle immediately but outer planner resources block reopen until actual settlement", async () => {
  const x = setup(),
    gate = deferred<any>();
  x.ports.planner.mockImplementation(() => gate.promise);
  const pending = x.c.plan(x.request);
  x.c.cancel();
  expect(x.c.getState().phase).toBe("idle");
  expect(x.c.getResidency().settled).toBe(false);
  expect((await x.c.reopen("other")).ok).toBe(false);
  gate.resolve({
    ok: false,
    request: x.request,
    query: null,
    inputs: [],
    issues: [],
    partial: { intent: null, draft: null, evidence: [] },
    mode: "manual",
  });
  await pending;
  await x.c.whenSettled();
  expect(x.c.getResidency().settled).toBe(true);
  expect(x.c.getState().phase).toBe("idle");
});
test("cancelled worker preparation continues to fence IO after outer promise settles", async () => {
  const x = setup();
  await x.c.plan(x.request);
  x.setPreparing(true);
  x.c.cancel();
  expect(x.c.getResidency().settled).toBe(false);
  expect((await x.c.reopen("other")).ok).toBe(false);
  x.setPreparing(false);
  x.prepared.resolve();
  await x.c.whenSettled();
  expect(x.c.getResidency().settled).toBe(true);
});
test("a candidate must be actually drawn and remain usable before stage", async () => {
  const x = setup();
  await x.preview();
  x.setUsable(false);
  expect((await x.c.use(x.request.operationId)).ok).toBe(false);
  expect(x.store.stage).not.toHaveBeenCalled();
});
test("double use attaches one durable write and does not upgrade quality", async () => {
  const x = setup(),
    built = await x.preview();
  const a = x.c.use(x.request.operationId),
    b = x.c.use(x.request.operationId);
  expect(a).toBe(b);
  expect((await a).ok).toBe(true);
  expect(x.store.stage).toHaveBeenCalledTimes(1);
  expect(x.store.commit).toHaveBeenCalledTimes(1);
  expect(x.c.getState().current?.reviewStatus).toBe("draft");
  expect(x.c.getState().current?.quality).toEqual(built.snapshot.quality);
});
test("stage failure rolls back without commit or replacing current", async () => {
  const x = setup();
  await x.preview();
  vi.mocked(x.store.stage).mockRejectedValue(Error("quota"));
  const out = await x.c.use(x.request.operationId);
  expect(out.ok).toBe(false);
  expect(x.store.commit).not.toHaveBeenCalled();
  expect(x.swap.rollback).toHaveBeenCalled();
  expect(x.c.getState().current).toBeNull();
});
test("commit terminal success wins late cancellation and display error", async () => {
  const x = setup();
  await x.preview();
  const gate = deferred<any>();
  vi.mocked(x.store.commit).mockImplementation(() => gate.promise);
  const p = x.c.use(x.request.operationId);
  await vi.waitFor(() => expect(x.store.commit).toHaveBeenCalled());
  x.c.cancel();
  expect(x.c.getState().phase).toBe("idle");
  expect(x.c.getState().finalization.kind).toBe("commit-pending");
  const ref = vi.mocked(x.store.stage).mock.results[0];
  const stage = await ref.value;
  gate.resolve({ ...stage, duplicate: false });
  const out = await p;
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.value.displayStatus).toBe("recovering");
  expect(x.c.getState().lastSave?.revisionId).toBe(stage.revisionId);
  expect(x.store.discardStage).not.toHaveBeenCalled();
  expect((await x.c.reopen(stage.sceneId)).ok).toBe(true);
  expect(x.ports.display.replace).not.toHaveBeenCalled();
});
test("shared subarray backing counted once and independent clone remains separate", () => {
  const b = new ArrayBuffer(32),
    clone = b.slice(0);
  const out = collectBuffers([
    {
      a: new Uint8Array(b, 0, 4),
      b: new Uint32Array(b),
      clone: new Uint8Array(clone),
    },
  ]);
  expect(out).toHaveLength(2);
  expect(out.reduce((n, b) => n + b.byteLength, 0)).toBe(64);
});
test("browser planner rejects out-of-order phase and mismatched final binding", async () => {
  const r = {
    operationId: "stream",
    prompt: "x",
    baseRevisionId: null,
    manualOverrides: [],
  };
  const fetcher = vi.fn(
    async () =>
      new Response(
        '{"type":"phase","operationId":"stream","baseRevisionId":null,"phase":"planning"}\n',
        { headers: { "content-type": "application/x-ndjson" } },
      ),
  );
  await expect(
    createBrowserPlanner(fetcher as typeof fetch)(
      r,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(/order|phase/i);
});

test("changed request identity and stale base cannot start another inference", async () => {
  const x = setup();
  await x.c.plan(x.request);
  expect((await x.c.plan({ ...x.request, prompt: "changed" })).ok).toBe(false);
  expect(
    (
      await x.c.plan({
        ...x.request,
        operationId: "other",
        baseRevisionId: "stale",
      })
    ).ok,
  ).toBe(false);
  expect(x.ports.planner).toHaveBeenCalledTimes(1);
});
test("no parsing phase is claimed before the real planner observer", async () => {
  const x = setup(),
    gate = deferred<any>(),
    phases: string[] = [];
  x.ports.planner.mockImplementation(() => gate.promise);
  x.c.subscribe((s) => phases.push(s.phase));
  const p = x.c.plan(x.request);
  expect(phases).not.toContain("parsing");
  gate.resolve({
    ok: false,
    request: x.request,
    query: null,
    inputs: [],
    issues: [],
    partial: { intent: null, draft: null, evidence: [] },
    mode: "manual",
  });
  await p;
  expect(phases).not.toContain("parsing");
});
test("live catalog change rejects preview before load/build", async () => {
  const x = setup(),
    r = await x.review();
  x.ports.library = async () => ({ ...f.library, digest: "0".repeat(64) });
  expect((await x.c.preview(r)).ok).toBe(false);
  expect(x.client.build).not.toHaveBeenCalled();
});
test("known transition budget rejects resolver allocation in advance", async () => {
  const x = setup();
  x.ports.externalResidency = () => ({
    buffers: [],
    extraBytes: GENERAL_LIMITS.maxTransitionBytes - 1024,
    settled: true,
  });
  await x.c.plan(x.request);
  expect(
    (
      await x.c.review(f.draft, [], {
        kind: "manual-intent",
        intent: f.context.intent,
      })
    ).ok,
  ).toBe(false);
  expect(x.client.resolve).not.toHaveBeenCalled();
});
test("resolve reservation survives cancelled outer result until actual worker preparation settles", async () => {
  const x = setup(),
    gate = deferred<any>();
  await x.c.plan(x.request);
  vi.mocked(x.client.resolve).mockImplementation(() => {
    x.setPreparing(true);
    return gate.promise;
  });
  const p = x.c.review(f.draft, [], {
    kind: "manual-intent",
    intent: f.context.intent,
  });
  await vi.waitFor(() => expect(x.client.resolve).toHaveBeenCalled());
  expect(x.c.getResidency().extraBytes).toBeGreaterThan(8 * 1024 ** 2);
  x.c.cancel();
  gate.resolve({
    ok: false,
    issues: [{ code: "cancelled", path: "worker", message: "cancelled" }],
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(x.c.getState().phase).toBe("idle");
  expect(x.c.getResidency().extraBytes).toBeGreaterThan(8 * 1024 ** 2);
  expect((await x.c.reopen("other")).ok).toBe(false);
  x.setPreparing(false);
  x.prepared.resolve();
  await p;
  await x.c.whenSettled();
  expect(x.c.getResidency().extraBytes).toBe(0);
});
test("cancel retains view initialization reservation and roots until the actual view fence", async () => {
  const x = setup(),
    initialized = deferred<void>();
  let preparing = false;
  x.view.activity = () => ({ preparing, available: true });
  x.view.whenPreparationSettled = () =>
    preparing ? initialized.promise : Promise.resolve();
  vi.mocked(x.view.prepare).mockImplementation(async (_packet, signal) => {
    preparing = true;
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    return x.swap;
  });
  const r = await x.review(),
    p = x.c.preview(r);
  await vi.waitFor(() => expect(preparing).toBe(true));
  const before = x.c.getResidency();
  expect(before.extraBytes).toBeGreaterThan(0);
  x.c.cancel();
  await Promise.resolve();
  await Promise.resolve();
  expect(x.c.getState().phase).toBe("idle");
  expect(x.c.getResidency().extraBytes).toBe(before.extraBytes);
  expect(x.c.getResidency().buffers.length).toBe(before.buffers.length);
  expect(x.ports.display.replace).not.toHaveBeenCalled();
  preparing = false;
  initialized.resolve();
  await p;
  await x.c.whenSettled();
  expect(x.c.getResidency().buffers).toHaveLength(0);
});
test("postcommit GPU failure preserves exact receipt without a late cancel", async () => {
  const x = setup(),
    built = await x.preview();
  vi.mocked(x.swap.commit).mockImplementation(() => {
    throw Error("GPU lost after database commit");
  });
  const out = await x.c.use(x.request.operationId);
  expect(out.ok).toBe(true);
  if (out.ok) {
    expect(out.value.revisionId).toBe(built.snapshot.revisionId);
    expect(out.value.displayStatus).toBe("recovering");
  }
  expect(x.c.getState().current?.revisionId).toBe(built.snapshot.revisionId);
  expect(x.store.discardStage).not.toHaveBeenCalled();
  x.view.activity = () => ({ preparing: false, available: false });
  vi.mocked(x.swap.commit).mockImplementation(() => {});
  expect((await x.c.reopen(built.snapshot.sceneId)).ok).toBe(true);
  expect(x.ports.display.replace).toHaveBeenCalledTimes(1);
});
test("undo keeps the displayed parent candidate reversible until checkout completes", async () => {
  const x = setup(),
    built = await x.preview();
  await x.c.use(x.request.operationId);
  const child = structuredClone(built.snapshot);
  child.revisionId = "saved-child";
  child.parentRevisionId = built.snapshot.revisionId;
  vi.mocked(x.store.open).mockResolvedValue(child);
  expect((await x.c.reopen(child.sceneId)).ok).toBe(true);
  vi.mocked(x.store.readRevision).mockResolvedValue(built.snapshot);
  vi.mocked(x.swap.commit).mockClear();
  vi.mocked(x.store.checkout).mockRejectedValue(Error("checkout aborted"));
  expect((await x.c.undo()).ok).toBe(false);
  expect(x.swap.commit).not.toHaveBeenCalled();
  expect(x.swap.rollback).toHaveBeenCalled();
  expect(x.c.getState().current?.revisionId).toBe(child.revisionId);
});
test("stored geometry corruption fails reopen and preserves current instead of masquerading as missing dependencies", async () => {
  const x = setup(),
    built = await x.preview();
  await x.c.use(x.request.operationId);
  const corrupted = structuredClone(built.snapshot);
  corrupted.geometryDigest = "0".repeat(64);
  vi.mocked(x.store.open).mockResolvedValue(corrupted);
  expect((await x.c.reopen(corrupted.sceneId)).ok).toBe(false);
  expect(x.c.getState().current?.revisionId).toBe(built.snapshot.revisionId);
});
test("editable import is a visible unsaved copy until use and does not recompile", async () => {
  const x = setup(),
    built = await x.preview();
  await x.c.use(x.request.operationId);
  const archive = await encodeGeneralArchive(
    built.snapshot,
    f.assets,
    "reference",
    {
      signal: new AbortController().signal,
      resources: {
        retainedBytes: collectBuffers([built.snapshot, f.assets]).reduce(
          (n, b) => n + b.byteLength,
          0,
        ),
      },
      library: f.library,
    },
  );
  const out = await x.c.importArchive(archive);
  expect(out.ok).toBe(true);
  const state = x.c.getState();
  expect(state.phase).toBe("previewing");
  expect(state.current?.revisionId).toBe(built.snapshot.revisionId);
  if (state.phase !== "previewing") throw Error("import not a candidate");
  expect(state.candidate.sceneId).not.toBe(built.snapshot.sceneId);
  expect(state.candidate.revisionId).not.toBe(built.snapshot.revisionId);
  expect(x.store.stage).toHaveBeenCalledTimes(1);
  expect(x.client.build).toHaveBeenCalledTimes(1);
  const candidatePatch = {
    ...patchFixture(),
    baseRevisionId: state.candidate.revisionId,
    targetInstanceIds: [built.snapshot.instances[0].instanceId],
    affectedInstanceIds: [built.snapshot.instances[0].instanceId],
    operations: [
      { kind: "remove", instanceId: built.snapshot.instances[0].instanceId },
    ],
  };
  const rollbacks = vi.mocked(x.swap.rollback).mock.calls.length;
  expect((await x.c.proposePatch(candidatePatch)).ok).toBe(false);
  expect(x.c.getState().phase).toBe("previewing");
  expect(x.c.getState().current?.revisionId).toBe(built.snapshot.revisionId);
  expect(x.swap.rollback).toHaveBeenCalledTimes(rollbacks);
  expect(x.client.propose).not.toHaveBeenCalled();
  const result = await x.c.use(state.operation.operationId);
  expect(result.ok).toBe(true);
  expect(vi.mocked(x.store.commit).mock.calls.at(-1)?.[1]).toBeNull();
});

test("nested IO carries exact candidate backing separately from outside residency at the 128 MiB boundary", async () => {
  const x = setup();
  const foreign = new ArrayBuffer(1024);
  x.ports.externalResidency = () => ({
    buffers: [foreign],
    extraBytes: 2048,
    settled: true,
  });
  await x.preview();
  const owned = x.c
    .getResidency()
    .buffers.reduce((n, b) => n + b.byteLength, 0);
  vi.mocked(x.store.stage).mockImplementation(async (snapshot, ctx) => {
    expect(ctx.candidateBytes).toBe(owned);
    expect(ctx.resources.retainedBytes).toBe(owned + 3072);
    checkIO(ctx, GENERAL_LIMITS.maxCandidateCpuBytes - owned);
    expect(() =>
      checkIO(ctx, GENERAL_LIMITS.maxCandidateCpuBytes - owned + 1),
    ).toThrow(/budget/);
    return {
      sceneId: snapshot.sceneId,
      revisionId: snapshot.revisionId,
      operationId: snapshot.operationId,
    };
  });
  expect((await x.c.use(x.request.operationId)).ok).toBe(true);
});
test.each(["parsing", "querying", "planning"] as const)(
  "cancel during actual %s remains idle and rejects late response until settlement",
  async (phase) => {
    const x = setup(),
      gate = deferred<any>();
    x.ports.planner.mockImplementation((_r, _s, observer) => {
      observer(phase);
      return gate.promise;
    });
    const p = x.c.plan(x.request);
    await vi.waitFor(() => expect(x.c.getState().phase).toBe(phase));
    const start = performance.now();
    x.c.cancel();
    expect(performance.now() - start).toBeLessThan(1000);
    expect(x.c.getState().phase).toBe("idle");
    expect((await x.c.reopen("other")).ok).toBe(false);
    gate.resolve({
      ok: false,
      request: x.request,
      query: null,
      inputs: [],
      issues: [],
      partial: { intent: null, draft: null, evidence: [] },
      mode: "manual",
    });
    await p;
    await x.c.whenSettled();
    expect(x.c.getState().phase).toBe("idle");
    expect(x.c.getState().planning).toBeNull();
  },
);
test.each(["load", "build", "display"] as const)(
  "cancel during %s fences the actual outer operation",
  async (stage) => {
    const x = setup(),
      gate = deferred<void>();
    let hold = false,
      entered = false;
    if (stage === "load")
      x.ports.library = async () => ({
        ...f.library,
        resolveMember: async (
          ...args: Parameters<typeof f.library.resolveMember>
        ) => {
          if (hold) {
            entered = true;
            await gate.promise;
          }
          return f.library.resolveMember(...args);
        },
      });
    const r = await x.review();
    if (stage === "build")
      vi.mocked(x.client.build).mockImplementation(async (...args) => {
        entered = true;
        await gate.promise;
        return compileScene(...args);
      });
    if (stage === "display")
      x.ports.display.waitForDisplayed.mockImplementation(async () => {
        entered = true;
        await gate.promise;
      });
    hold = true;
    const p = x.c.preview(r);
    await vi.waitFor(() => expect(entered).toBe(true));
    const start = performance.now();
    x.c.cancel();
    expect(performance.now() - start).toBeLessThan(1000);
    expect(x.c.getState().phase).toBe("idle");
    expect(x.c.getResidency().settled).toBe(false);
    expect((await x.c.reopen("other")).ok).toBe(false);
    gate.resolve();
    expect((await p).ok).toBe(false);
    await x.c.whenSettled();
    expect(x.c.getState().current).toBeNull();
    expect(x.c.getState().phase).toBe("idle");
  },
);
test("broken display is replaced on reopen while ordinary cancel preserves the host", async () => {
  const x = setup(),
    built = await x.preview();
  await x.c.use(x.request.operationId);
  x.view.activity = () => ({ preparing: false, available: false });
  vi.mocked(x.store.open).mockResolvedValue(built.snapshot);
  expect((await x.c.reopen(built.snapshot.sceneId)).ok).toBe(true);
  expect(x.ports.display.replace).toHaveBeenCalledTimes(1);
  expect(x.client.build).toHaveBeenCalledTimes(1);
});
test("reviewed binary proposal mutation cannot reuse the same operation authority", async () => {
  const x = setup(),
    r = await x.review();
  const buffer = collectBuffers([r])[0];
  new Uint8Array(buffer)[0] ^= 1;
  expect((await x.c.preview(r)).ok).toBe(false);
  expect(x.client.build).not.toHaveBeenCalled();
});

test("duplicate in-flight preview attaches to the same build", async () => {
  const x = setup(),
    r = await x.review(),
    gate = deferred<void>();
  x.ports.display.waitForDisplayed.mockImplementation(() => gate.promise);
  const a = x.c.preview(r),
    b = x.c.preview(r);
  expect(a).toBe(b);
  await vi.waitFor(() => expect(x.client.build).toHaveBeenCalledTimes(1));
  gate.resolve();
  expect((await a).ok).toBe(true);
});

test("offline local edit deduplicates proposal, retains exact assets and exports after save", async () => {
  const x = setup(),
    built = await x.preview();
  await x.c.use(x.request.operationId);
  x.ports.library = async () => {
    throw Error("global library offline");
  };
  const i = built.snapshot.instances[0],
    t = structuredClone(i.transform);
  t.position[0] += 0.05;
  const p: any = {
    ...patchFixture(),
    patchId: "local-offline",
    baseRevisionId: built.snapshot.revisionId,
    requestedRegion: [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ],
    effectiveRegion: [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ],
    targetInstanceIds: [i.instanceId],
    affectedInstanceIds: [i.instanceId],
    affectedTileIds: [],
    lockedInstanceIds: [],
    operations: [{ kind: "move", instanceId: i.instanceId, transform: t }],
    review: {
      scopeAccepted: false,
      planDigest: "0".repeat(64),
      catalogDigest: f.library.digest,
      assetBindings: [],
    },
  };
  const a = x.c.proposePatch(p),
    b = x.c.proposePatch(structuredClone(p));
  expect(a).toBe(b);
  const proposal = take<any>(await a);
  const accepted = {
    ...proposal.patch,
    review: { ...proposal.patch.review, scopeAccepted: true },
  };
  const c = x.c.previewPatch(accepted),
    d = x.c.previewPatch(structuredClone(accepted));
  expect(c).toBe(d);
  expect((await c).ok).toBe(true);
  expect((await x.c.use(p.patchId)).ok).toBe(true);
  expect(x.c.getState().current?.revisionId).not.toBe(
    built.snapshot.revisionId,
  );
  const exported = await x.c.exportArchive("reference");
  expect(exported.ok).toBe(true);
  expect(x.store.libraryForRevision).toHaveBeenCalledTimes(3);
  expect(x.ports.planner).toHaveBeenCalledTimes(1);
});

function streamFixture() {
  const request = {
    operationId: "stream-boundary",
    baseRevisionId: "parent-water",
    prompt: "保持原文：水 🌊",
    manualOverrides: [],
  };
  const outcome = {
    ok: false as const,
    request,
    query: null,
    inputs: [],
    mode: "manual" as const,
    partial: { intent: null, draft: null, evidence: [] },
    issues: [{ code: "offline", path: "planner", message: "离线 🌊" }],
  };
  const final = (value: unknown = outcome) =>
    JSON.stringify({
      type: "final",
      operationId: request.operationId,
      baseRevisionId: request.baseRevisionId,
      outcome: value,
    }) + "\n";
  const phase = (value: string) =>
    JSON.stringify({
      type: "phase",
      operationId: request.operationId,
      baseRevisionId: request.baseRevisionId,
      phase: value,
    }) + "\n";
  const parse = (input: Uint8Array, chunkSize = 65536) => {
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === input.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, input.byteLength);
        controller.enqueue(input.subarray(offset, end));
        offset = end;
      },
    });
    const observer = vi.fn();
    const promise = createBrowserPlanner(
      (async () =>
        new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        })) as typeof fetch,
    )(request, new AbortController().signal, observer);
    return { promise, stream, observer };
  };
  return { request, outcome, final, phase, parse };
}

test("browser planner preserves split multibyte UTF-8 and final-only failure has no invented phase", async () => {
  const f = streamFixture(),
    run = f.parse(new TextEncoder().encode(f.final()), 1);
  expect(await run.promise).toEqual(f.outcome);
  expect(run.observer).not.toHaveBeenCalled();
  expect(run.stream.locked).toBe(false);
});

test.each([
  "operation",
  "base",
  "request",
  "duplicate-final",
  "truncated-final",
  "invalid-utf8",
] as const)("browser planner rejects %s stream corruption", async (kind) => {
  const f = streamFixture();
  let wire = f.final();
  if (kind === "operation" || kind === "base") {
    const envelope = JSON.parse(wire);
    envelope[kind === "operation" ? "operationId" : "baseRevisionId"] =
      "wrong-identity";
    wire = JSON.stringify(envelope) + "\n";
  }
  if (kind === "request")
    wire = f.final({
      ...f.outcome,
      request: { ...f.request, prompt: "changed request" },
    });
  if (kind === "duplicate-final") wire += wire;
  if (kind === "truncated-final") wire = wire.slice(0, -1);
  const input =
    kind === "invalid-utf8"
      ? new Uint8Array([0xe6, 0xb0])
      : new TextEncoder().encode(wire);
  const run = f.parse(input);
  await expect(run.promise).rejects.toThrow();
  expect(run.stream.locked).toBe(false);
});

test("browser planner enforces the cumulative UTF-8 byte budget including phases and delimiters", async () => {
  const f = streamFixture(),
    encoder = new TextEncoder(),
    prefix = f.phase("parsing") + f.phase("querying") + f.phase("planning"),
    empty = {
      ...f.outcome,
      issues: [{ code: "budget", path: "planner", message: "" }],
    },
    overhead = encoder.encode(prefix + f.final(empty)).byteLength,
    exact = {
      ...empty,
      issues: [
        {
          ...empty.issues[0],
          message: "a".repeat(GENERAL_LIMITS.maxJsonBytes - overhead),
        },
      ],
    };
  const exactBytes = encoder.encode(prefix + f.final(exact));
  expect(exactBytes.byteLength).toBe(GENERAL_LIMITS.maxJsonBytes);
  const accepted = f.parse(exactBytes);
  expect((await accepted.promise).ok).toBe(false);
  expect(accepted.observer.mock.calls.map(([phase]) => phase)).toEqual([
    "parsing",
    "querying",
    "planning",
  ]);
  exact.issues[0].message += "水";
  const rejected = f.parse(encoder.encode(prefix + f.final(exact)));
  await expect(rejected.promise).rejects.toThrow(/2 MiB/);
  expect(rejected.stream.locked).toBe(false);
});

test("browser planner cancellation cancels and unlocks a genuinely pending stream read", async () => {
  const f = streamFixture(),
    pulled = deferred<void>(),
    cancel = vi.fn(),
    abort = new AbortController(),
    stream = new ReadableStream<Uint8Array>({
      pull() {
        pulled.resolve();
      },
      cancel,
    });
  const pending = createBrowserPlanner(
    (async () =>
      new Response(stream, {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
  )(f.request, abort.signal, vi.fn());
  await pulled.promise;
  const rejected = expect(pending).rejects.toThrow("stop streaming");
  abort.abort(Error("stop streaming"));
  await rejected;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(stream.locked).toBe(false);
});

test("late cancellation after durable checkout reopens on a healthy view without replacing it", async () => {
  const x = setup(),
    built = await x.preview();
  await x.c.use(x.request.operationId);
  const child = structuredClone(built.snapshot);
  child.revisionId = "saved-child";
  child.parentRevisionId = built.snapshot.revisionId;
  vi.mocked(x.store.open).mockResolvedValue(child);
  expect((await x.c.reopen(child.sceneId)).ok).toBe(true);
  vi.mocked(x.store.readRevision).mockResolvedValue(built.snapshot);
  vi.mocked(x.store.checkout).mockImplementation(
    async (sceneId, revisionId, _base, operationId) => {
      x.c.cancel();
      return { sceneId, revisionId, operationId, duplicate: false };
    },
  );
  const result = await x.c.undo();
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.revisionId).toBe(built.snapshot.revisionId);
    expect(result.value.displayStatus).toBe("recovering");
  }
  vi.mocked(x.store.open).mockResolvedValue(built.snapshot);
  expect((await x.c.reopen(built.snapshot.sceneId)).ok).toBe(true);
  expect(x.ports.display.replace).not.toHaveBeenCalled();
});

const catalogMetadata = (library: AssetLibrary) => ({
  digest: library.digest,
  manifests: library.manifests,
  styles: library.styles,
});

function wholeScenePatch(base: any, operation: any, patchId: string) {
  const region = [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
  ];
  return {
    ...patchFixture(),
    patchId,
    baseRevisionId: base.revisionId,
    requestedRegion: region,
    effectiveRegion: region,
    targetInstanceIds: operation.instanceId ? [operation.instanceId] : [],
    affectedInstanceIds: operation.instanceId ? [operation.instanceId] : [],
    affectedTileIds: [],
    lockedInstanceIds: [],
    operations: [operation],
    review: {
      scopeAccepted: false,
      planDigest: "0".repeat(64),
      catalogDigest: base.plan.catalogDigest,
      assetBindings: [],
    },
  } as any;
}

test("a new global plan after a saved local edit preserves parent identity without using rebuild provenance", async () => {
  const x = setup(),
    built = await x.preview();
  take(await x.c.use(x.request.operationId));
  const removal = wholeScenePatch(
    built.snapshot,
    { kind: "remove", instanceId: built.snapshot.instances[0].instanceId },
    "root-remove-before-replan",
  );
  const p = take<any>(await x.c.proposePatch(removal));
  const edited = take<any>(
    await x.c.previewPatch({
      ...p.patch,
      review: { ...p.patch.review, scopeAccepted: true },
    }),
  ).compiled.snapshot;
  take(await x.c.use(removal.patchId));
  expect(
    edited.plan.review.fieldSources.some(
      (a: any) => a.key === "manual-patch-scope",
    ),
  ).toBe(true);
  const prior = await documentDigest(edited);
  const request = {
    operationId: "root-global-after-local",
    baseRevisionId: edited.revisionId,
    prompt: "重新规划平地，放一组石头，不要水",
    manualOverrides: [],
  };
  const m = await makeManualDraft(
    request,
    {
      width: 4,
      depth: 4,
      seed: 43,
      terrain: {
        source: "procedural",
        elevation: 0,
        slopeDegrees: 0,
        slopeAzimuthDegrees: 0,
        noiseAmplitude: 0,
        noiseScale: 2,
        noiseOctaves: 1,
        spacing: 0.2,
      },
      water: { mode: "none" },
      groups: [
        {
          category: "rock",
          count: 1,
          sourceRestriction: "procedural",
          required: true,
        },
      ],
    },
    catalogMetadata(f.library),
  );
  const draft = await confirmProceduralChoices(
    request,
    m.intent,
    m.draft,
    catalogMetadata(f.library),
    new Set(
      proceduralChoices(m.intent, m.draft, catalogMetadata(f.library)).map(
        (c) => c.slotId,
      ),
    ),
  );
  await x.c.plan(request);
  const reviewed = take<any>(
    await x.c.review(draft, draft.review.manualOverrides, {
      kind: "manual-intent",
      intent: m.intent,
    }),
  );
  const candidate = take<any>(await x.c.preview(reviewed)).snapshot;
  expect(candidate.parentRevisionId).toBe(edited.revisionId);
  expect(candidate.sceneId).toBe(edited.sceneId);
  expect(candidate.plan.seed).toBe(43);
  expect(candidate.instances).toHaveLength(1);
  expect(x.c.getState().current?.revisionId).toBe(edited.revisionId);
  expect(await documentDigest(edited)).toBe(prior);
  x.c.cancel();
  expect(x.c.getState().current?.revisionId).toBe(edited.revisionId);
});

async function savedVariantScene() {
  const fixture = await buildFixture({ count: 1, unusedVariant: true });
  const x = setup(fixture),
    built = await x.preview(),
    base = built.snapshot;
  take(await x.c.use(x.request.operationId));
  const cachedIds = new Set(base.assets.map((a: any) => a.assetRef.id));
  const cached = makeAssetLibrary(
    catalogMetadata(fixture.library),
    async (ref, name, signal) => {
      if (!cachedIds.has(ref.id))
        throw Error("Exact member was never cached for this revision");
      return fixture.library.resolveMember(ref, name, signal);
    },
  );
  vi.mocked(x.store.libraryForRevision).mockImplementation(async (revision) =>
    revision === base.revisionId ? cached : fixture.library,
  );
  const local = vi.fn(async () => fixture.library);
  x.ports.library = local;
  const variant = fixture.library.manifests.find((m) =>
    m.id.endsWith("-variant"),
  )!;
  const patch = wholeScenePatch(
    base,
    {
      kind: "replace",
      instanceId: base.instances[0].instanceId,
      assetRef: { id: variant.id, contentVersion: variant.contentVersion },
    },
    "root-unused-variant",
  );
  return { x, fixture, base, patch, local, cached };
}

test("local replacement can acquire an uncached asset from the identical original catalog", async () => {
  const { x, base, patch, local } = await savedVariantScene();
  const prior = await documentDigest(base);
  const proposal = take<any>(await x.c.proposePatch(patch));
  expect(local).toHaveBeenCalledTimes(1);
  const result = take<any>(
    await x.c.previewPatch({
      ...proposal.patch,
      review: { ...proposal.patch.review, scopeAccepted: true },
    }),
  );
  expect(result.compiled.snapshot.instances[0].assetRef).toEqual(
    patch.operations[0].assetRef,
  );
  expect(result.compiled.snapshot.instances[0].instanceId).toBe(
    base.instances[0].instanceId,
  );
  expect(await documentDigest(base)).toBe(prior);
  expect((await x.c.use(patch.patchId)).ok).toBe(true);
  expect((await x.c.exportArchive("embedded")).ok).toBe(false);
  expect(
    take<Uint8Array>(await x.c.exportArchive("reference")).byteLength,
  ).toBeGreaterThan(0);
});

test("uncached asset loading refuses a changed catalog and preserves the current revision", async () => {
  const { x, fixture, base, patch, local } = await savedVariantScene();
  local.mockImplementation(async () => ({
    ...fixture.library,
    digest: "0".repeat(64),
  }));
  const result = await x.c.proposePatch(patch);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.issues.map((i) => i.message).join(" ")).toMatch(
      /catalog.*changed/i,
    );
  expect(local).toHaveBeenCalledTimes(1);
  expect(x.c.getState().current?.revisionId).toBe(base.revisionId);
});

test("a corrupt cached member is never replaced by an online fallback", async () => {
  const { x, fixture, base, local } = await savedVariantScene();
  const corrupt = makeAssetLibrary(
    catalogMetadata(fixture.library),
    async () => {
      throw Error("cached digest corruption");
    },
  );
  vi.mocked(x.store.libraryForRevision).mockImplementation(async () => corrupt);
  const transform = structuredClone(base.instances[0].transform);
  transform.position[0] += 0.01;
  const patch = wholeScenePatch(
    base,
    { kind: "move", instanceId: base.instances[0].instanceId, transform },
    "root-corrupt-cached",
  );
  const result = await x.c.proposePatch(patch);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.issues.map((i) => i.message).join(" ")).toContain(
      "cached digest corruption",
    );
  expect(local).not.toHaveBeenCalled();
  expect(x.c.getState().current?.revisionId).toBe(base.revisionId);
});

test("redisplay uses the retained current render and waits for actual draw without generating or saving", async () => {
  const x = setup();
  await x.preview();
  take(await x.c.use(x.request.operationId));
  const before = x.c.getState(),
    rendererInput = vi.mocked(x.view.prepare).mock.calls[0][0];
  const calls = [
    x.client.build,
    x.client.resolve,
    x.store.stage,
    x.store.commit,
    x.store.libraryForRevision,
  ].map((fn) => vi.mocked(fn).mock.calls.length);
  const draw = deferred<void>();
  vi.mocked(x.ports.display.waitForDisplayed).mockImplementationOnce(
    () => draw.promise,
  );
  const pending = x.c.redisplayCurrent();
  await vi.waitFor(() => expect(x.c.getState().phase).toBe("building"));
  expect(x.c.getResidency().settled).toBe(false);
  expect(vi.mocked(x.swap.commit)).toHaveBeenCalledTimes(1);
  draw.resolve();
  expect((await pending).ok).toBe(true);
  expect(vi.mocked(x.view.prepare).mock.calls.at(-1)![0]).toBe(rendererInput);
  expect(
    [
      x.client.build,
      x.client.resolve,
      x.store.stage,
      x.store.commit,
      x.store.libraryForRevision,
    ].map((fn) => vi.mocked(fn).mock.calls.length),
  ).toEqual(calls);
  expect(x.c.getState().current).toEqual(before.current);
  expect(x.c.getState().lastSave).toEqual(before.lastSave);
  expect(x.c.getResidency().settled).toBe(true);
  expect(vi.mocked(x.swap.commit)).toHaveBeenCalledTimes(2);
});

test("cancelled redisplay holds current and does not commit a late display", async () => {
  const x = setup();
  await x.preview();
  take(await x.c.use(x.request.operationId));
  const before = x.c.getState().current,
    draw = deferred<void>();
  vi.mocked(x.ports.display.waitForDisplayed).mockImplementationOnce(
    () => draw.promise,
  );
  const pending = x.c.redisplayCurrent();
  await vi.waitFor(() =>
    expect(x.ports.display.waitForDisplayed).toHaveBeenCalledTimes(2),
  );
  x.c.cancel();
  draw.resolve();
  expect((await pending).ok).toBe(false);
  expect(x.c.getState().current).toEqual(before);
  expect(x.swap.commit).toHaveBeenCalledTimes(1);
  expect(x.swap.rollback).toHaveBeenCalled();
});

test("the current catalog exposes only immutable metadata from the bound catalog", async () => {
  const { x, fixture } = await savedVariantScene();
  const catalog = x.c.getCurrentCatalog();
  expect(catalog).toEqual(catalogMetadata(fixture.library));
  expect(Object.keys(catalog!).sort()).toEqual([
    "digest",
    "manifests",
    "styles",
  ]);
  expect(Object.isFrozen(catalog)).toBe(true);
  expect(Object.isFrozen(catalog!.manifests[0])).toBe(true);
});
