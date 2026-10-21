/** Native browser transaction evidence with isolated constructed assets. No asset admission. */
import { buildFixture } from "./general-build-fixture";
import {
  createCatalogView,
  makeAssetLibrary,
  styleContentVersion,
} from "../../src/general-scene/asset-library";
import { assetContentVersion } from "../../src/general-scene/asset-package";
import { sha256 } from "../../src/io/hash";
import { sparkProbe } from "./spark-observer";
import { createSceneController } from "../../src/general-scene/controller";
import { createBuildClient } from "../../src/general-scene/worker-client";
import {
  createSceneStore,
  type StageRef,
} from "../../src/general-scene/storage";
import { documentDigest } from "../../src/general-scene/canonical";
import {
  parseIntent,
  parsePlanDraft,
  parsePatch,
  type SceneSnapshot,
} from "../../src/general-scene/contracts";
import type {
  GeneralView,
  GeneralSwap,
} from "../../src/general-scene/render/types";
import type {
  PlanningRequest,
  PlanningOutcome,
} from "../../src/general-scene/planner";
import type { Result } from "../../src/general-scene/core";

type Host = {
  current(): GeneralView;
  views(): readonly GeneralView[];
  replace(signal: AbortSignal): Promise<GeneralView>;
  observeFrame(listener: (view: GeneralView) => void): () => void;
  pause(value: boolean): void;
  drawnIds(): readonly string[];
  drawSerial(): number;
};
const take = <T>(r: Result<T>): T => {
  if (!r.ok) throw Error(JSON.stringify(r.issues));
  return r.value;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function until(predicate: () => boolean, description: string) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 15000)
      throw Error("Timed out: " + description);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function backingBuffers(root: unknown) {
  const seen = new Set<object>(),
    buffers = new Set<ArrayBuffer>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof ArrayBuffer) buffers.add(v);
    else if (ArrayBuffer.isView(v)) {
      if (!(v.buffer instanceof ArrayBuffer))
        throw Error("Unexpected shared fixture buffer");
      buffers.add(v.buffer);
    } else if (v instanceof Map) v.forEach(visit);
    else Object.values(v).forEach(visit);
  };
  visit(root);
  return [...buffers];
}
async function inspectDatabase() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("gaussian-general-scenes", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<any>((resolve, reject) => {
      const names = ["scenes", "revisions", "operations"],
        tx = db.transaction(names, "readonly"),
        out: any = {};
      for (const name of names) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () =>
          (out[name] = request.result.map((r: any) =>
            name === "revisions"
              ? {
                  sceneId: r.sceneId,
                  revisionId: r.revisionId,
                  operationId: r.operationId,
                  parentRevisionId: r.parentRevisionId,
                  status: r.status,
                  descriptorDigest: r.descriptorDigest,
                }
              : r,
          ));
      }
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Explicit permission covers only these constructed test bytes, never real assets. */
async function exportableFixture() {
  const f = await buildFixture();
  const replacements = new Map<string, string>();
  const manifests: any[] = structuredClone([...f.library.manifests]);
  const styles: any[] = structuredClone([...f.library.styles]);
  for (const m of [...manifests, ...styles]) {
    const old = m.contentVersion;
    m.provenance.license.id = "constructed-transaction-export";
    m.provenance.license.summary =
      "Permission for isolated constructed test bytes only.";
    m.provenance.license.redistributable = true;
    m.provenance.license.redistributionBasis =
      "Constructed test bytes only; no real asset rights.";
    if ("kind" in m) {
      const bytes = new TextEncoder().encode(
        "Redistribution of these constructed test bytes is permitted. No real asset rights.\n",
      );
      const pack = f.packages.find((p) => p.manifest.id === m.id)!;
      pack.members.set("license.txt", bytes);
      const file = m.files.find((x: any) => x.path === "license.txt");
      file.bytes = bytes.length;
      file.sha256 = await sha256(bytes);
      m.resources.cpuSourceBytes = m.files.reduce(
        (n: number, x: any) => n + x.bytes,
        0,
      );
      m.quality.humanReview.files = m.files.map((x: any) => ({
        path: x.path,
        sha256: x.sha256,
      }));
      m.contentVersion = await assetContentVersion(m);
      pack.manifest = m;
    } else m.contentVersion = await styleContentVersion(m);
    m.quality.humanReview.asset.contentVersion = m.contentVersion;
    if (!("kind" in m))
      m.quality.humanReview.files[0].sha256 = m.contentVersion.slice(7);
    replacements.set(old, m.contentVersion);
    replacements.set(old.slice(7), m.contentVersion.slice(7));
  }
  const catalog = await createCatalogView(manifests, styles);
  replacements.set(f.library.digest, catalog.digest);
  const replace = (v: any): any =>
    typeof v === "string"
      ? (replacements.get(v) ?? v)
      : Array.isArray(v)
        ? v.map(replace)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, replace(x)]),
            )
          : v;
  f.draft = parsePlanDraft(replace(f.draft));
  f.library = makeAssetLibrary(catalog, async (ref, name, signal) => {
    signal.throwIfAborted();
    const b = f.packages
      .find(
        (p) =>
          p.manifest.id === ref.id &&
          p.manifest.contentVersion === ref.contentVersion,
      )
      ?.members.get(name);
    if (!b) throw Error("Missing exact constructed member");
    return new Uint8Array(b);
  });
  f.assets = [];
  return f;
}

async function diagnosticUrl(url: string) {
  return url.startsWith("data:")
    ? `data:[length=${url.length},sha256=${await sha256(new TextEncoder().encode(url))}]`
    : url;
}

export function createTransactionHarness(host: Host) {
  const store = createSceneStore(),
    client = createBuildClient();
  let fixture: Awaited<ReturnType<typeof buildFixture>> | null = null;
  const workerEvents: {
    kind: string;
    url: string;
    message?: string;
    filename?: string;
  }[] = [];
  let offlineLibrary = false;
  let plannerGate: ReturnType<typeof deferred> | null = null;
  let importedCandidate: SceneSnapshot | null = null;
  let sequence = 0,
    operationId = "",
    pending: Promise<unknown> | null = null;
  let stageGate: ReturnType<typeof deferred> | null = null,
    heldStage: StageRef | null = null;
  let displayWait: { view: GeneralView; swap: GeneralSwap } | null = null;
  const counts = {
    planner: 0,
    liveLibrary: 0,
    resolve: 0,
    build: 0,
    propose: 0,
    stage: 0,
    commit: 0,
    replace: 0,
  };
  const phases: string[] = [];
  for (const method of ["resolve", "build", "propose"] as const) {
    const original = client[method].bind(client);
    (client as any)[method] = (...args: any[]) => {
      counts[method]++;
      return (original as any)(...args);
    };
  }
  const originalStage = store.stage.bind(store),
    originalCommit = store.commit.bind(store);
  store.stage = async (...args) => {
    counts.stage++;
    const stage = await originalStage(...args);
    if (stageGate) {
      heldStage = stage;
      await stageGate.promise;
    }
    return stage;
  };
  store.commit = (...args) => {
    counts.commit++;
    return originalCommit(...args);
  };
  const planner = async (
    request: PlanningRequest,
  ): Promise<PlanningOutcome> => {
    counts.planner++;
    if (plannerGate) await plannerGate.promise;
    return {
      ok: false,
      request,
      query: null,
      inputs: [],
      mode: "manual",
      partial: { intent: null, draft: null, evidence: [] },
      issues: [
        {
          code: "constructed-manual",
          path: "planner",
          message: "Constructed manual browser fixture; model not called.",
        },
      ],
    };
  };
  const controller = createSceneController({
    planner,
    buildClient: client,
    store,
    library: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      counts.liveLibrary++;
      if (offlineLibrary) throw Error("Live catalog deliberately offline");
      if (!fixture) throw Error("A reopened scene must use its stored library");
      return fixture.library;
    },
    externalResidency: () => ({
      buffers: backingBuffers(fixture),
      extraBytes: 0,
      settled: true,
    }),
    display: {
      current: host.current,
      views: host.views,
      replace: async (signal: AbortSignal) => {
        counts.replace++;
        return host.replace(signal);
      },
      showLegacy: async () => {
        throw Error("No legacy fixture in transaction harness");
      },
      waitForDisplayed(
        view: GeneralView,
        swap: GeneralSwap,
        signal: AbortSignal,
      ) {
        displayWait = { view, swap };
        return new Promise<void>((resolve, reject) => {
          let unsubscribe = () => {};
          const finish = (error?: unknown) => {
            clearTimeout(timeout);
            unsubscribe();
            signal.removeEventListener("abort", aborted);
            if (displayWait?.swap === swap) displayWait = null;
            if (error) reject(error);
            else resolve();
          };
          const aborted = () =>
            finish(
              signal.reason ?? new DOMException("Cancelled", "AbortError"),
            );
          const timeout = setTimeout(
            () => finish(Error("Actual display timed out")),
            15000,
          );
          unsubscribe = host.observeFrame((rendered) => {
            if (signal.aborted) return aborted();
            if (view !== host.current())
              return finish(Error("Display replaced"));
            if (rendered === view && swap.isUsable()) finish();
          });
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        });
      },
    },
  });
  controller.subscribe((state: any) => phases.push(state.phase));
  const residency = () => {
    const r = controller.getResidency();
    return {
      bufferCount: r.buffers.length,
      bufferBytes: r.buffers.reduce(
        (n: number, b: ArrayBuffer) => n + b.byteLength,
        0,
      ),
      extraBytes: r.extraBytes,
      settled: r.settled,
    };
  };
  const io = () => {
    const r = residency();
    return {
      signal: new AbortController().signal,
      resources: {
        retainedBytes:
          r.bufferBytes +
          r.extraBytes +
          backingBuffers(fixture).reduce((n, b) => n + b.byteLength, 0),
      },
    };
  };
  const summary = async (snapshot: SceneSnapshot) => ({
    sceneId: snapshot.sceneId,
    revisionId: snapshot.revisionId,
    operationId: snapshot.operationId,
    parentRevisionId: snapshot.parentRevisionId,
    digest: await documentDigest(snapshot),
    geometryDigest: snapshot.geometryDigest,
    catalogDigest: snapshot.plan?.catalogDigest ?? null,
    stateDigest: await documentDigest(snapshot.state),
    assets: snapshot.assets.map((a) => a.assetRef),
    instances: snapshot.instances.map((i) => ({
      instanceId: i.instanceId,
      assetRef: i.assetRef,
      transform: i.transform,
    })),
    camera: host.current().getCamera(),
    storedCamera: snapshot.camera,
    stats: host.current().stats(),
    drawnNodes: host.drawnIds().length,
    drawnIds: [...host.drawnIds()],
    drawSerial: host.drawSerial(),
    activity: host.current().activity(),
    counts: { ...counts },
    probe: sparkProbe.snapshot(),
    residency: residency(),
  });
  const current = async () => {
    const id = controller.getState().current?.sceneId;
    return id ? summary(await store.open(id, io())) : null;
  };
  const evidence = async () => ({
    current: await current(),
    camera: host.current().getCamera(),
    stats: host.current().stats(),
    drawnNodes: host.drawnIds().length,
    drawnIds: [...host.drawnIds()],
    drawSerial: host.drawSerial(),
    activity: host.current().activity(),
    records: await store.list().then(inspectDatabase),
    counts: { ...counts },
    state: controller.getState(),
    residency: residency(),
    probe: sparkProbe.snapshot(),
    phases: [...phases],
    workerEvents: await Promise.all(
      workerEvents.map(async (event) => ({
        ...event,
        url: await diagnosticUrl(event.url),
        ...(event.filename
          ? { filename: await diagnosticUrl(event.filename) }
          : {}),
      })),
    ),
  });
  const review = async () => {
    fixture ??= await exportableFixture();
    // Loaded fixture arrays are not inputs: the controller owns actual loadAsset calls.
    fixture.assets = [];
    const base = controller.getState().current?.revisionId ?? null;
    operationId = `transaction-operation-${++sequence}`;
    const intent = parseIntent({
      ...fixture.intent,
      requestId: operationId,
      operation: base ? "patch" : "create",
      baseRevisionId: base,
    });
    const request: PlanningRequest = {
      operationId,
      prompt: intent.raw,
      baseRevisionId: base,
      manualOverrides: [],
    };
    const requirementDigest = await documentDigest(request);
    const draft = structuredClone(fixture.draft);
    draft.planId = `transaction-plan-${sequence}`;
    draft.intentDigest = await documentDigest(intent);
    if (base && draft.terrain.source === "procedural")
      draft.terrain.slopeDegrees = 2;
    for (const atom of draft.review.manualOverrides)
      if (
        atom.value &&
        typeof atom.value === "object" &&
        !Array.isArray(atom.value)
      )
        atom.value = { ...atom.value, requirementDigest };
    for (const accepted of draft.review.acceptedSubstitutions)
      accepted.planId = draft.planId;
    await controller.plan(request);
    return take(
      await controller.review(parsePlanDraft(draft), [], {
        kind: "manual-intent",
        intent,
      }),
    );
  };
  const preview = async () => {
    const resolved = await review();
    return take(await controller.preview(resolved));
  };
  const waitSettled = async () => {
    if (pending) await pending;
    await controller.whenSettled();
    await until(
      () => !host.current().activity().preparing,
      "view preparation settlement",
    );
  };
  const nextActualDraw = (expectedIds?: readonly string[]) => {
    const before = host.drawSerial(),
      expected = expectedIds ? [...expectedIds].sort() : null;
    return new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => {
        unsubscribe();
        reject(Error("Expected actual draw timed out"));
      }, 15000);
      unsubscribe = host.observeFrame((rendered) => {
        if (rendered !== host.current() || host.drawSerial() <= before) return;
        if (
          expected &&
          JSON.stringify([...host.drawnIds()].sort()) !==
            JSON.stringify(expected)
        )
          return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  };
  const movePatch = async (s: SceneSnapshot) => {
    if (s.capability !== "editable")
      throw Error("Expected editable constructed fixture");
    const instance = s.instances[0],
      transform = {
        ...structuredClone(instance.transform),
        position: [
          instance.transform.position[0] +
            (instance.transform.position[0] >= 0 ? -0.05 : 0.05),
          instance.transform.position[1],
          instance.transform.position[2],
        ],
      };
    const R = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ];
    return parsePatch({
      documentType: "general-scene-patch",
      schemaVersion: 1,
      patchId: `transaction-patch-${++sequence}`,
      baseRevisionId: s.revisionId,
      raw: "Constructed explicit local move",
      requestedRegion: R,
      effectiveRegion: R,
      targetInstanceIds: [instance.instanceId],
      lockedInstanceIds: s.state.lockedInstanceIds,
      affectedInstanceIds: [instance.instanceId],
      affectedTileIds: [],
      operations: [
        { kind: "move", instanceId: instance.instanceId, transform },
      ],
      review: {
        scopeAccepted: false,
        planDigest: await documentDigest(s.plan),
        catalogDigest: s.plan.catalogDigest,
        assetBindings: [],
      },
    });
  };
  return async function transaction(action: string, options: any = {}) {
    if (action === "worker-lifetime") {
      const before = await evidence();
      const nativeCreate = URL.createObjectURL,
        NativeWorker = window.Worker;
      const created: { url: string; size: number; type: string }[] = [];
      const events: { kind: string; url: string; message?: string }[] = [];
      const workerUrls = new Set<string>();
      let cancelScheduled = false;
      let cancelState: ReturnType<typeof controller.getState> | null = null;
      let cancelMs: number | null = null;
      let completed = false,
        failure: string | null = null;
      URL.createObjectURL = function (blob: Blob | MediaSource) {
        const url = nativeCreate.call(this, blob);
        created.push({
          url,
          size: blob instanceof Blob ? blob.size : 0,
          type: blob instanceof Blob ? blob.type : "media",
        });
        return url;
      };
      window.Worker = class extends NativeWorker {
        readonly observedUrl: string;
        constructor(url: string | URL, workerOptions?: WorkerOptions) {
          super(url, workerOptions);
          this.observedUrl = String(url);
          workerUrls.add(this.observedUrl);
          events.push({ kind: "created", url: this.observedUrl });
          this.addEventListener("error", (event) =>
            events.push({
              kind: "error",
              url: this.observedUrl,
              message: event.message,
            }),
          );
          if (options.earlyCancel && !cancelScheduled) {
            cancelScheduled = true;
            queueMicrotask(() => {
              events.push({ kind: "cancel-requested", url: this.observedUrl });
              const start = performance.now();
              controller.cancel();
              cancelMs = performance.now() - start;
              cancelState = controller.getState();
            });
          }
        }
        postMessage(message: unknown, transfer: Transferable[]): void;
        postMessage(
          message: unknown,
          options?: StructuredSerializeOptions,
        ): void;
        postMessage(
          message: unknown,
          options?: Transferable[] | StructuredSerializeOptions,
        ): void {
          events.push({ kind: "posted", url: this.observedUrl });
          if (Array.isArray(options)) super.postMessage(message, options);
          else super.postMessage(message, options);
        }
        terminate() {
          events.push({ kind: "terminated", url: this.observedUrl });
          return super.terminate();
        }
      };
      let afterWorker,
        probes: {
          url: string;
          readable: boolean;
          status?: number;
          bytes?: number;
          error?: string;
        }[] = [];
      try {
        try {
          await preview();
          completed = true;
        } catch (error) {
          failure = String(error);
        }
        await waitSettled();
        await nextActualDraw(options.earlyCancel ? before.drawnIds : undefined);
        afterWorker = await evidence();
        // Query the real original Blob URLs after settlement. Worker-side revocation
        // is invisible to a main-thread revoke spy; a successful fetch is a leak.
        for (const entry of created.filter((entry) =>
          workerUrls.has(entry.url),
        )) {
          try {
            const response = await fetch(entry.url);
            probes.push({
              url: entry.url,
              readable: response.ok,
              status: response.status,
              bytes: (await response.arrayBuffer()).byteLength,
            });
          } catch (error) {
            probes.push({
              url: entry.url,
              readable: false,
              error: String(error),
            });
          }
        }
        if (!options.earlyCancel) {
          controller.cancel();
          await waitSettled();
          await nextActualDraw(before.drawnIds);
        }
      } finally {
        URL.createObjectURL = nativeCreate;
        window.Worker = NativeWorker;
      }
      return {
        before,
        completed,
        failure,
        cancelMs,
        cancelState,
        afterWorker,
        created,
        workerUrls: await Promise.all([...workerUrls].map(diagnosticUrl)),
        events: await Promise.all(
          events.map(async (event) => ({
            ...event,
            url: await diagnosticUrl(event.url),
          })),
        ),
        probes,
        ...(await evidence()),
      };
    }
    if (action === "double-plan") {
      const request: PlanningRequest = {
        operationId: "duplicate-plan",
        prompt: "Constructed duplicate planning request",
        baseRevisionId: null,
        manualOverrides: [],
      };
      plannerGate = deferred();
      const a = controller.plan(request),
        b = controller.plan(structuredClone(request));
      await until(() => counts.planner > 0, "constructed planner entry");
      const during = { counts: { ...counts }, state: controller.getState() };
      plannerGate.resolve();
      plannerGate = null;
      const results = await Promise.all([a, b]);
      await waitSettled();
      return { samePromise: a === b, results, during, ...(await evidence()) };
    }
    if (action === "export") {
      const bytes = take(
        await controller.exportArchive(options.mode ?? "embedded"),
      );
      await waitSettled();
      return {
        bytes: [...bytes],
        sha256: await sha256(bytes),
        ...(await evidence()),
      };
    }
    if (action === "import") {
      const imported = take(
        await controller.importArchive(new Uint8Array(options.bytes)),
      );
      importedCandidate = imported.snapshot;
      const state = controller.getState();
      if (state.phase !== "previewing")
        throw Error("Import did not become visible candidate");
      operationId = state.operation.operationId;
      return {
        candidate: await summary(imported.snapshot),
        historyNotice: imported.historyNotice,
        ...(await evidence()),
      };
    }
    if (action === "attempt-import-edit") {
      if (!importedCandidate) throw Error("No imported candidate");
      const result = await controller.proposePatch(
        await movePatch(importedCandidate),
      );
      await waitSettled();
      await nextActualDraw();
      return { result, ...(await evidence()) };
    }
    if (action === "offline-library") {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          const address = String(url);
          workerEvents.push({ kind: "created", url: address });
          this.addEventListener("error", (event) =>
            workerEvents.push({
              kind: "error",
              url: address,
              message: event.message,
              filename: event.filename,
            }),
          );
        }
      };
      offlineLibrary = true;
      return evidence();
    }
    if (action === "patch") {
      const id = controller.getState().current?.sceneId;
      if (!id) throw Error("No saved current scene");
      const base = await store.open(id, io()),
        patch = await movePatch(base);
      const proposal = take(await controller.proposePatch(patch));
      const accepted = parsePatch({
        ...proposal.patch,
        review: { ...proposal.patch.review, scopeAccepted: true },
      });
      const built = take(await controller.previewPatch(accepted));
      operationId = patch.patchId;
      return {
        proposal,
        candidate: await summary(built.compiled.snapshot),
        ...(await evidence()),
      };
    }
    if (action === "undo-abort") {
      const before = await evidence(),
        originalPut = IDBObjectStore.prototype.put;
      let injected = false,
        attemptedPointer: string | null = null;
      IDBObjectStore.prototype.put = function (...args: any[]) {
        const q = (originalPut as any).apply(this, args);
        if (!injected && this.name === "scenes") {
          injected = true;
          attemptedPointer = args[0]?.currentRevisionId;
          this.transaction.abort();
        }
        return q;
      };
      let result;
      try {
        result = await controller.undo();
      } finally {
        IDBObjectStore.prototype.put = originalPut;
      }
      await waitSettled();
      await nextActualDraw(before.drawnIds);
      return {
        before,
        result,
        injected,
        attemptedPointer,
        ...(await evidence()),
      };
    }
    if (action === "seed") {
      host.current().setCamera({ position: [4, 3, 5], target: [0, 0, 0] });
      await preview();
      take(await controller.use(operationId));
      await waitSettled();
      return current();
    }
    if (action === "camera") {
      host.current().setCamera(options.camera);
      await nextActualDraw();
      return evidence();
    }
    if (action === "preview") {
      const built: any = await preview();
      return {
        ...(await summary(built.snapshot)),
        renderSourceCount: built.render.sources.size,
      };
    }
    if (action === "reopen") {
      const snapshot = take<SceneSnapshot>(
        await controller.reopen(options.sceneId),
      );
      await waitSettled();
      return summary(snapshot);
    }
    if (action === "stage-hold") {
      stageGate = deferred();
      pending = controller.use(operationId);
      await until(() => heldStage !== null, "real native staging complete");
      return { stage: heldStage, ...(await evidence()) };
    }
    if (action === "fault") {
      const afterComplete = [
        "after-complete",
        "after-complete-gpu",
        "after-complete-cancel",
      ].includes(options.kind);
      if (!afterComplete)
        host
          .current()
          .setCamera({ position: [6, 5, 4], target: [0.2, 0.1, 0] });
      const originalAdd = IDBObjectStore.prototype.add,
        originalPut = IDBObjectStore.prototype.put,
        originalTransaction = IDBDatabase.prototype.transaction;
      let injected = false,
        nativeComplete = false;
      let gpuDisposal: Promise<void> | null = null;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = originalTransaction.apply(this, args);
        if (
          afterComplete &&
          !injected &&
          tx.mode === "readwrite" &&
          ["scenes", "revisions", "operations"].every((name) =>
            tx.objectStoreNames.contains(name),
          )
        ) {
          injected = true;
          // Register before returning the real transaction to storage, hence before
          // storage installs oncomplete. A later listener may lose to its microtasks.
          tx.addEventListener(
            "complete",
            () => {
              nativeComplete = true;
              if (options.kind !== "after-complete-gpu") controller.cancel();
              if (options.kind !== "after-complete-cancel")
                gpuDisposal = host.current().dispose();
            },
            { once: true },
          );
        }
        return tx;
      };
      IDBObjectStore.prototype.add = function (...args: any[]) {
        if (
          options.kind === "quota" &&
          this.name === "revisions" &&
          !injected
        ) {
          injected = true;
          throw new DOMException(
            "Injected quota at native staging",
            "QuotaExceededError",
          );
        }
        return (originalAdd as any).apply(this, args);
      };
      IDBObjectStore.prototype.put = function (...args: any[]) {
        if (
          !injected &&
          options.kind === "abort-commit" &&
          this.name === "revisions" &&
          args[0]?.status === "committed"
        ) {
          injected = true;
          const request = (originalPut as any).apply(this, args);
          controller.cancel();
          return request;
        }
        return (originalPut as any).apply(this, args);
      };
      let result;
      try {
        result = await controller.use(operationId);
      } finally {
        IDBObjectStore.prototype.add = originalAdd;
        IDBObjectStore.prototype.put = originalPut;
        IDBDatabase.prototype.transaction = originalTransaction;
      }
      if (gpuDisposal) await gpuDisposal;
      await waitSettled();
      const observed = await evidence();
      return {
        kind: options.kind,
        injected,
        nativeComplete,
        result,
        ...observed,
      };
    }
    if (action === "use") return controller.use(operationId);
    if (action === "attempt-reopen") return controller.reopen(options.sceneId);
    if (action === "release-stage") {
      stageGate?.resolve();
      stageGate = null;
      await waitSettled();
      return evidence();
    }
    if (action === "double-use") {
      const results = await Promise.all([
        controller.use(operationId),
        controller.use(operationId),
      ]);
      await waitSettled();
      return { results, ...(await evidence()) };
    }
    if (action === "preview-undrawn") {
      const resolved = await review();
      host.pause(true);
      pending = controller.preview(resolved);
      await until(
        () => displayWait !== null,
        "candidate activated without render",
      );
      host.current().setCamera({ position: [6, 5, 4], target: [0.2, 0.1, 0] });
      return {
        waitingForDisplay: true,
        usable: displayWait!.swap.isUsable(),
        state: controller.getState(),
      };
    }
    if (action === "preview-late-initialization") {
      const resolved = await review();
      sparkProbe.pauseInitialization("packed");
      pending = controller.preview(resolved);
      await until(
        () => sparkProbe.snapshot().initializationHeld,
        "actual PackedSplats initialization",
      );
      return {
        initializationHeld: sparkProbe.snapshot().initializationHeld,
        residency: residency(),
      };
    }
    if (action === "cancel") {
      const start = performance.now();
      controller.cancel();
      const immediate = controller.getState(),
        cancelMs = performance.now() - start;
      host.pause(false);
      return { immediate, cancelMs, residency: residency() };
    }
    if (action === "release-initialization") sparkProbe.resumeInitialization();
    if (action === "settle" || action === "release-initialization") {
      await waitSettled();
      await nextActualDraw(options.drawnIds);
      return evidence();
    }
    if (action === "inspect") return evidence();
    throw Error("Unknown transaction action: " + action);
  };
}
