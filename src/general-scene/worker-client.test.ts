import { test, expect, vi, afterEach } from "vitest";
import { buildFixture } from "../../tests/support/general-build-fixture";
import { createBuildClient } from "./worker-client";
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  messages: any[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(value: any, transfer: Transferable[]) {
    this.messages.push(structuredClone(value, { transfer }));
  }
  terminate() {
    this.terminated = true;
  }
  reply(value: any) {
    this.onmessage?.({ data: value } as MessageEvent);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWorker.all = [];
});
test("cancellation terminates actual owned worker and caller buffers remain attached", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const f = await buildFixture();
  const client = createBuildClient();
  const pending = client.resolve(f.draft, f.state, f.library, f.context);
  await vi.waitFor(() => expect(FakeWorker.all[0]?.messages.length).toBe(1));
  const worker = FakeWorker.all[0],
    message = worker.messages[0];
  expect(message.operationId).toBe(f.context.operationId);
  expect(message.baseRevisionId).toBe(null);
  expect(message.payload.inputs.catalog.digest).toBe(f.library.digest);
  expect(message.payload.inputs.catalog).not.toHaveProperty("resolveMember");
  client.cancel(f.context.operationId);
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues[0].code).toBe("cancelled");
  expect(worker.terminated).toBe(true);
  expect(
    f.assets[0].full.kind === "float14" && f.assets[0].full.data.byteLength,
  ).toBeGreaterThan(0);
  client.dispose();
});
test("wrong operation or base and a late retired generation cannot publish", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const f = await buildFixture(),
    client = createBuildClient();
  let resolved = false;
  const p = client.resolve(f.draft, f.state, f.library, f.context).then((r) => {
    resolved = true;
    return r;
  });
  await vi.waitFor(() => expect(FakeWorker.all[0]?.messages.length).toBe(1));
  const w = FakeWorker.all[0],
    m = w.messages[0];
  w.reply({
    ...m,
    kind: "result",
    result: { ok: true, value: "wrong" },
    operationId: "other",
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  w.reply({
    ...m,
    kind: "result",
    result: { ok: true, value: "wrong" },
    baseRevisionId: "newer",
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  client.cancel(f.context.operationId);
  await p;
  w.reply({ ...m, kind: "result", result: { ok: true, value: "late" } });
  expect(w.terminated).toBe(true);
  client.dispose();
});
test("10-second hard timeout terminates and recreates the worker for the next request", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const f = await buildFixture();
  vi.useFakeTimers();
  const client = createBuildClient();
  const p = client.resolve(f.draft, f.state, f.library, f.context);
  await vi.waitFor(() => expect(FakeWorker.all[0]?.messages.length).toBe(1));
  await vi.advanceTimersByTimeAsync(10000);
  const r = await p;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues[0].code).toBe("timeout");
  expect(FakeWorker.all[0].terminated).toBe(true);
  vi.useRealTimers();
  const next = client.resolve(f.draft, f.state, f.library, {
    ...f.context,
    operationId: "next",
  });
  await vi.waitFor(() => expect(FakeWorker.all.length).toBe(2));
  client.cancel("next");
  await next;
  client.dispose();
});

test("captured original signal and IDs cannot cancel or rebind a later transaction", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const f = await buildFixture(),
    client = createBuildClient(),
    firstAbort = new AbortController();
  const ctx = { ...f.context, signal: firstAbort.signal };
  const first = client.resolve(f.draft, f.state, f.library, ctx);
  ctx.operationId = "changed";
  ctx.baseRevisionId = "changed-base";
  ctx.signal = new AbortController().signal;
  ctx.resources = { retainedBytes: 256 * 1024 ** 2 };
  await vi.waitFor(() => expect(FakeWorker.all[0]?.messages.length).toBe(1));
  expect(FakeWorker.all[0].messages[0].operationId).toBe(f.context.operationId);
  expect(FakeWorker.all[0].messages[0].baseRevisionId).toBe(null);
  client.cancel(f.context.operationId);
  await first;
  const second = client.resolve(f.draft, f.state, f.library, {
    ...f.context,
    operationId: "second",
  });
  await vi.waitFor(() => expect(FakeWorker.all[1]?.messages.length).toBe(1));
  firstAbort.abort();
  await Promise.resolve();
  expect(FakeWorker.all[1].terminated).toBe(false);
  client.cancel("second");
  await second;
  client.dispose();
});
test("cancelled preparation stays reserved until its actual asynchronous cleanup settles", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const f = await buildFixture(),
    client = createBuildClient();
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const library = {
    ...f.library,
    resolveMember: async (
      ...args: Parameters<typeof f.library.resolveMember>
    ) => {
      calls++;
      if (calls === 2) await gate;
      return f.library.resolveMember(...args);
    },
  };
  const first = client.resolve(f.draft, f.state, library, f.context);
  await vi.waitFor(() => expect(calls).toBe(2));
  client.cancel(f.context.operationId);
  await first;
  const next = await client.resolve(f.draft, f.state, f.library, {
    ...f.context,
    operationId: "while-cleaning",
  });
  expect(next.ok).toBe(false);
  if (!next.ok) expect(next.issues[0].code).toBe("cleanup-pending");
  expect(FakeWorker.all).toHaveLength(0);
  expect(client.activity()).toEqual({ busy: true, preparing: true });
  const settled = client.whenPreparationSettled();
  let finishedCleanup = false;
  void settled.then(() => {
    finishedCleanup = true;
  });
  await Promise.resolve();
  expect(finishedCleanup).toBe(false);
  release();
  await settled;
  expect(client.activity()).toEqual({ busy: false, preparing: false });
  const last = client.resolve(f.draft, f.state, f.library, {
    ...f.context,
    operationId: "after-cleanup",
  });
  await vi.waitFor(() => expect(FakeWorker.all[0]?.messages.length).toBe(1));
  client.cancel("after-cleanup");
  await last;
  client.dispose();
});

test("worker patch resolve accounts retained source and decode at exact transition boundary", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const { resolvePreparedPlan } = await import("./compile");
  const { assertAssetLayout } = await import("./asset-package");
  const assetLoader = await import("./asset-loader");
  const f = await buildFixture({ patch: true });
  const raw = f.packages.reduce(
      (n, p) => n + assertAssetLayout(p.manifest).sourceBytes,
      0,
    ),
    patch = f.packages.find((p) => p.manifest.kind === "patch")!,
    decoded = assertAssetLayout(patch.manifest).decodedBytes,
    maximum = Math.max(
      ...f.packages.flatMap((p) => p.manifest.files.map((x) => x.bytes)),
    ),
    peak = 2 * raw + decoded + 8 * 1024 ** 2 + 3 * maximum + 10201 * 64;
  const loader = vi.spyOn(assetLoader, "loadAsset");
  try {
    for (const extra of [0, 1]) {
      loader.mockClear();
      const client = createBuildClient();
      const pending = client.resolve(f.draft, f.state, f.library, {
        ...f.context,
        resources: { retainedBytes: 256 * 1024 ** 2 - raw - peak + extra },
      });
      await vi.waitFor(() =>
        expect(FakeWorker.all[extra]?.messages.length).toBe(1),
      );
      const worker = FakeWorker.all[extra],
        message = worker.messages[0],
        p = message.payload;
      expect(p.resources.retainedBytes + peak).toBe(256 * 1024 ** 2 + extra);
      const result = await resolvePreparedPlan(
        p.draft,
        p.state,
        p.inputs,
        f.context.signal,
        p.resources,
      );
      worker.reply({ ...message, kind: "result", result });
      const out = await pending;
      expect(out.ok).toBe(extra === 0);
      if (!out.ok)
        expect(out.issues).toContainEqual(
          expect.objectContaining({ code: "budget" }),
        );
      expect(loader).toHaveBeenCalledTimes(extra === 0 ? 1 : 0);
      expect(
        f.assets[0].full.kind === "float14" && f.assets[0].full.data.byteLength,
      ).toBeGreaterThan(0);
      client.dispose();
    }
  } finally {
    loader.mockRestore();
  }
});

async function proposalInput() {
  const { resolvePlan, compileScene } = await import("./compile");
  const { patchFixture } = await import("./test-fixtures");
  const f = await buildFixture({ count: 2 });
  const resolved = await resolvePlan(
    f.draft,
    f.state,
    f.library,
    f.context.signal,
    f.context.resources,
  );
  if (!resolved.ok) throw Error(JSON.stringify(resolved));
  const out = await compileScene(resolved.value, f.state, f.assets, f.context);
  if (!out.ok) throw Error(JSON.stringify(out));
  const base = out.value.snapshot,
    patch = patchFixture();
  patch.baseRevisionId = base.revisionId;
  patch.targetInstanceIds = patch.affectedInstanceIds = [
    base.instances[0].instanceId,
  ];
  patch.operations = [
    { kind: "remove", instanceId: base.instances[0].instanceId },
  ];
  patch.requestedRegion = patch.effectiveRegion = [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
  ];
  patch.review.scopeAccepted = false;
  return {
    f,
    base,
    patch,
    ctx: {
      ...f.context,
      baseRevisionId: base.revisionId,
      revisionId: "proposal-next",
      operationId: "proposal-op",
    },
  };
}
test("proposal uses the existing worker with owned base, exact source and captured revision identity", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const c = await proposalInput(),
    client = createBuildClient();
  const original = c.base.terrain.heights[0];
  const promise = client.propose(c.base, c.patch, c.f.library, c.ctx);
  c.ctx.revisionId = "mutated";
  c.patch.raw = "mutated caller";
  c.base.terrain.heights[0] = 0.4;
  await vi.waitFor(() => expect(FakeWorker.all[0]?.messages.length).toBe(1));
  const w = FakeWorker.all[0],
    m = w.messages[0];
  expect(m.kind).toBe("propose");
  expect(m.payload.context.revisionId).toBe("proposal-next");
  expect(m.payload.base.terrain.heights[0]).toBe(original);
  expect(m.payload.patch.raw).not.toBe("mutated caller");
  expect(m.payload.inputs.sourceEvidence.members.length).toBeGreaterThan(0);
  expect(m.payload.context).not.toHaveProperty("baseSnapshot");
  client.cancel(c.ctx.operationId);
  expect(await promise).toMatchObject({
    ok: false,
    issues: [{ code: "cancelled" }],
  });
  expect(w.terminated).toBe(true);
  expect(c.base.terrain.heights.byteLength).toBeGreaterThan(0);
  client.dispose();
});
test("same in-flight proposal attaches once while changed operations conflict", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const c = await proposalInput(),
    client = createBuildClient();
  const first = client.propose(c.base, c.patch, c.f.library, c.ctx);
  const duplicate = client.propose(c.base, c.patch, c.f.library, c.ctx);
  const conflict = client.propose(
    c.base,
    { ...c.patch, raw: "different" },
    c.f.library,
    c.ctx,
  );
  expect(first).toBe(duplicate);
  expect(await conflict).toMatchObject({
    ok: false,
    issues: [{ code: "operation-conflict" }],
  });
  await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
  client.cancel(c.ctx.operationId);
  await first;
  client.dispose();
});
test("proposal rejects a falsely accepted worker result and preserves caller data", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const c = await proposalInput(),
    client = createBuildClient();
  const promise = client.propose(c.base, c.patch, c.f.library, c.ctx);
  await vi.waitFor(() => expect(FakeWorker.all[0]?.messages.length).toBe(1));
  const w = FakeWorker.all[0],
    m = w.messages[0];
  w.reply({
    ...m,
    kind: "result",
    result: {
      ok: true,
      value: {
        patch: {
          ...c.patch,
          review: { ...c.patch.review, scopeAccepted: true },
        },
        plan: c.base.plan,
        state: c.base.state,
      },
    },
  });
  expect(await promise).toMatchObject({
    ok: false,
    issues: [{ code: "worker-protocol" }],
  });
  client.dispose();
});

test("dispose keeps actual preparation residency visible until its resolver settles", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const f = await buildFixture(),
    client = createBuildClient();
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const library = {
    ...f.library,
    resolveMember: async (
      ...args: Parameters<typeof f.library.resolveMember>
    ) => {
      calls++;
      if (calls === 2) await gate;
      return f.library.resolveMember(...args);
    },
  };
  const operation = client.resolve(f.draft, f.state, library, f.context);
  await vi.waitFor(() => expect(calls).toBe(2));
  const settled = client.whenPreparationSettled();
  let cleaned = false;
  void settled.then(() => {
    cleaned = true;
  });
  client.dispose();
  expect(await operation).toMatchObject({
    ok: false,
    issues: [{ code: "disposed" }],
  });
  expect(client.activity()).toEqual({ busy: true, preparing: true });
  expect(cleaned).toBe(false);
  expect(FakeWorker.all).toHaveLength(0);
  release();
  await settled;
  expect(client.activity()).toEqual({ busy: false, preparing: false });
  expect(cleaned).toBe(true);
  expect(
    await client.resolve(f.draft, f.state, f.library, f.context),
  ).toMatchObject({ ok: false, issues: [{ code: "disposed" }] });
});
