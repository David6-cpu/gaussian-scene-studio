// Install observer before dynamically importing the renderer or creating any Spark object.
import { sparkProbe } from "./support/spark-observer";
import { utils, SparkRenderer } from "@sparkjsdev/spark";
import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import { encodeRangeSafeRgb } from "../src/gaussian/sh3-range";
import { SH3_KEYS } from "../src/io/sh3-variant";
import type {
  SplatSource,
  LoadedAsset,
} from "../src/general-scene/asset-loader";
import type { CatalogView } from "../src/general-scene/asset-library";
import type {
  RenderPacket,
  GeneralSwap,
  GeneralView,
} from "../src/general-scene/render/types";
import type { CameraState, Transform } from "../src/general-scene/core";
import { worldPoint, sourcePlacement } from "../src/general-scene/render/types";
import {
  SPARK_BUDGET_VERSION,
  sparkRendererBudget,
  sparkSceneCapacity,
} from "../src/gaussian/spark-budget";
import {
  makeReviewPacket,
  reviewViews,
  drawReviewDebug,
} from "../src/general-scene/asset-review";
import {
  sampleSurfaces,
  SURFACE_RENDER_CONFIG,
  surfaceHalf,
  type SurfaceBuffers,
} from "../src/general-scene/surface";
import {
  buildTerrain,
  sampleTerrainWorld,
  terrainNodeWorld,
} from "../src/general-scene/terrain";
import {
  solveWater,
  sampleWaterDomain,
  WATER_ALGORITHM_VERSION,
  type WaterSolution,
} from "../src/general-scene/water";
import { profileBoundaryWitness } from "../src/general-scene/water-profile";
import {
  terrainPlanFixture,
  stateFixture,
  waterFixture,
  manifestFixture,
} from "../src/general-scene/test-fixtures";
import { parsePlanDraft } from "../src/general-scene/contracts";
import {
  parseSurfaceStyle,
  type SurfaceStyle,
} from "../src/general-scene/asset-manifest";
import { styleContentVersion } from "../src/general-scene/asset-library";
import {
  documentDigest,
  cpuBufferDigest,
} from "../src/general-scene/canonical";
import { makeRiverProps } from "../src/assets/river-props";
const { createGeneralView } = await import("../src/general-scene/render/view");
const { makeAssetLibrary } = await import("../src/general-scene/asset-library");
const { loadAsset } = await import("../src/general-scene/asset-loader");
const canvas = document.querySelector<HTMLCanvasElement>("#general")!,
  debug = document.querySelector<HTMLCanvasElement>("#debug")!,
  toggle = document.querySelector<HTMLInputElement>("#toggle-debug")!;
// Independent browser observation: this hook runs after Spark's actual WebGL draw.
let observedSpark: SparkRenderer | undefined,
  drawnIds: string[] = [],
  transactionDrawSerial = 0;
const afterSpark = SparkRenderer.prototype.onAfterRender;
SparkRenderer.prototype.onAfterRender = function (...args) {
  afterSpark.apply(this, args);
  observedSpark = this;
  drawnIds = this.display.mapping.map((m) => m.node.uuid);
  transactionDrawSerial++;
};
let delayedSwap: GeneralSwap | undefined,
  delayedEmpty = false,
  oldDisplayIds: string[] = [];
let view = await createGeneralView(canvas);
const transactionRetiringViews = new Set<GeneralView>();
const transactionFrameObservers = new Set<(view: GeneralView) => void>();
let transactionRenderPaused = false;
let running = true,
  raf = 0,
  asset: LoadedAsset | undefined,
  abort: AbortController | undefined,
  serial = 0;
// T8 inspection-only state. Does not alter the real catalog or admission metadata.
let surfaceRecord:
  | {
      name: string;
      solution: WaterSolution;
      sampled: SurfaceBuffers;
      style: SurfaceStyle;
      packet: RenderPacket;
      views: { name: string; camera: CameraState }[];
      bindings: unknown;
      overlay: { position: readonly [number, number, number]; kind: string }[];
    }
  | undefined;
let surfaceOrbitStep: ((now: number) => void) | undefined;
function drawSurfaceDebug() {
  const ctx = debug.getContext("2d")!,
    dpr = Math.min(devicePixelRatio || 1, 2),
    w = debug.clientWidth,
    h = debug.clientHeight;
  debug.width = Math.round(w * dpr);
  debug.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!surfaceRecord || !toggle.checked) return;
  const cam = new PerspectiveCamera(50, w / h, 0.01, 150),
    state = view.getCamera();
  cam.position.fromArray(state.position);
  cam.lookAt(new Vector3(...state.target));
  cam.updateMatrixWorld();
  for (const item of surfaceRecord.overlay) {
    const q = new Vector3(...item.position).project(cam);
    if (q.z < -1 || q.z > 1) continue;
    ctx.fillStyle =
      item.kind === "shore"
        ? "#ff55dd"
        : item.kind === "tile"
          ? "#ffffff"
          : item.kind === "wet"
            ? "#22ddff"
            : "#efc54b";
    ctx.fillRect(
      ((q.x + 1) * w) / 2 - 1,
      ((1 - q.y) * h) / 2 - 1,
      item.kind === "shore" ? 3 : 2,
      item.kind === "shore" ? 3 : 2,
    );
  }
}

function loop(now = performance.now()) {
  if (!running) return;
  surfaceOrbitStep?.(now);
  if (!transactionRenderPaused) {
    view.render();
    for (const observer of transactionFrameObservers) observer(view);
  }
  for (const retired of transactionRetiringViews)
    if (retired.stats().ownedBytes === 0)
      transactionRetiringViews.delete(retired);
  if (surfaceRecord) drawSurfaceDebug();
  else if (asset)
    drawReviewDebug(debug, asset.manifest, view.getCamera(), toggle.checked);
  raf = requestAnimationFrame(loop);
}
loop();
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
async function settle() {
  for (let i = 0; i < 5; i++) await frame();
}
async function install(packet: RenderPacket) {
  const swap = await view.prepare(packet, new AbortController().signal);
  swap.activate();
  const start = performance.now();
  while (!swap.isUsable()) {
    if (performance.now() - start > 10000) {
      swap.rollback();
      throw Error("Visible frame timed out");
    }
    await frame();
  }
  swap.commit();
  await settle();
}
const floatSource = (): SplatSource => ({
  kind: "float14",
  count: 1,
  data: new Float32Array([
    1, 0, 0, 0.18, 0.18, 0.18, 0, 0, 0, 1, 0.6, 0.35, 0.1, 1,
  ]),
});
const identity: Transform = {
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: 1,
};
const shared: RenderPacket = {
  sources: new Map([["shared", floatSource()]]),
  instances: [-1, 1].map((x, i) => ({
    id: String(i),
    sourceKey: "shared",
    coarseSourceKey: null,
    anchor: [1, 0, 0],
    transform: { ...identity, position: [x, 0, 0] },
  })),
};
function shSource(): SplatSource {
  const arrays = Object.fromEntries(
    SH3_KEYS.map((k) => [k, new Uint32Array(2048 * 4)]),
  ) as Extract<SplatSource, { kind: "ext-sh3" }>["arrays"];
  utils.encodeExtSplat(
    [arrays.ext0, arrays.ext1],
    0,
    1,
    0,
    0,
    0.2,
    0.2,
    0.2,
    0,
    0,
    0,
    1,
    1,
    0.45,
    0.45,
    0.45,
  );
  arrays.sh1[1] = encodeRangeSafeRgb(0.65, -0.35, 0.1);
  arrays.sh3a[3] = encodeRangeSafeRgb(0.2, 0.1, -0.1);
  return { kind: "ext-sh3", count: 1, capacity: 2048, arrays };
}
let buildFaultSession: any = null;
let storageFixture: any = null;
let storageGenerationCalls = 0;
let patchHarness: ((action: string, options?: any) => Promise<any>) | null =
  null;
let transactionHarness:
  ((action: string, options?: any) => Promise<any>) | null = null;
const api = {
  async transaction(action: string, options: any = {}) {
    if (!transactionHarness) {
      const { createTransactionHarness } =
        await import("./support/general-transaction-fixture");
      transactionHarness = createTransactionHarness({
        current: () => view,
        views: () => [view, ...transactionRetiringViews],
        async replace(signal) {
          signal.throwIfAborted();
          const old = view;
          transactionRetiringViews.add(old);
          await old.dispose();
          signal.throwIfAborted();
          const replacement = await createGeneralView(canvas);
          if (signal.aborted) {
            transactionRetiringViews.add(replacement);
            await replacement.dispose();
            signal.throwIfAborted();
          }
          view = replacement;
          return replacement;
        },
        observeFrame(listener) {
          transactionFrameObservers.add(listener);
          return () => transactionFrameObservers.delete(listener);
        },
        pause(value) {
          transactionRenderPaused = value;
        },
        drawnIds: () => drawnIds,
        drawSerial: () => transactionDrawSerial,
      });
    }
    return transactionHarness(action, options);
  },
  async patch(action: string, options: any = {}) {
    if (!patchHarness) {
      const { createPatchHarness } =
        await import("./support/general-patch-fixture");
      patchHarness = createPatchHarness(view, frame, settle);
    }
    return patchHarness(action, options);
  },
  async storage(action: string, options: any = {}) {
    const { createSceneStore } = await import("../src/general-scene/storage");
    const {
      buildOwnedBytes,
      compileScene,
      resolvePlan,
      storedResultsToRenderPacket,
    } = await import("../src/general-scene/compile");
    const { documentDigest } = await import("../src/general-scene/canonical");
    const { parseSnapshot } = await import("../src/general-scene/contracts");
    const store = createSceneStore(),
      signal = new AbortController().signal;
    const ctx = (held = 0) => ({
      signal,
      resources: { retainedBytes: view.stats().ownedBytes + held },
    });
    const database = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const q = indexedDB.open("gaussian-general-scenes", 1);
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
    const inspect = async () => {
      const db = await database();
      try {
        return await new Promise<any>((resolve, reject) => {
          const names = [
              "scenes",
              "revisions",
              "blobs",
              "manifests",
              "operations",
            ],
            tx = db.transaction(names, "readonly"),
            out: any = {};
          for (const name of names) {
            const q = tx.objectStore(name).getAll();
            q.onsuccess = () =>
              (out[name] = q.result.map((r: any) =>
                name === "blobs"
                  ? { hash: r.hash, size: r.size }
                  : name === "revisions"
                    ? {
                        revisionId: r.revisionId,
                        status: r.status,
                        digest: r.descriptorDigest,
                      }
                    : name === "manifests"
                      ? { digest: r.digest }
                      : r,
              ));
          }
          tx.oncomplete = () => resolve(out);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };
    const candidate = async (slope = 2) => {
      storageGenerationCalls++;
      const { buildFixture } = await import("./support/general-build-fixture"),
        f = await buildFixture({ river: true, slope, unusedVariant: true });
      const r = await resolvePlan(
        f.draft,
        f.state,
        f.library,
        signal,
        ctx(buildOwnedBytes({ packages: f.packages, assets: f.assets }))
          .resources,
      );
      if (!r.ok) throw Error(JSON.stringify(r.issues));
      const built = await compileScene(
        r.value,
        f.state,
        f.assets.filter((a) => !a.manifest.id.endsWith("-variant")),
        { ...f.context, resources: ctx(buildOwnedBytes(f.packages)).resources },
      );
      if (!built.ok) throw Error(JSON.stringify(built.issues));
      return { f, snapshot: built.value.snapshot };
    };
    const makeRevision = async (
      id: string,
      parent: string | null,
      sceneId = "storage-scene",
      variant = false,
    ) => {
      if (!storageFixture || variant)
        storageFixture = await candidate(variant ? 4 : 2);
      const s = parseSnapshot({
        ...storageFixture.snapshot,
        sceneId,
        revisionId: id,
        operationId: "operation-" + id,
        parentRevisionId: parent,
      });
      return {
        s,
        context: {
          ...ctx(buildOwnedBytes({ fixture: storageFixture, s })),
          library: storageFixture.f.library,
        },
      };
    };
    const summary = async (s: any) => ({
      revisionId: s.revisionId,
      sceneId: s.sceneId,
      digest: await documentDigest(s),
      state: await documentDigest(s.state),
      terrain: await documentDigest(s.terrain),
      instances: await documentDigest(s.instances),
      owners: await documentDigest(s.surfaces.map((x: any) => x.tiles)),
      geometryDigest: s.geometryDigest,
    });
    if (action === "seed") {
      const { s, context } = await makeRevision("storage-old", null);
      await store.commit(await store.stage(s, context), null, signal);
      return summary(s);
    }
    if (action === "stage") {
      const { s, context } = await makeRevision("storage-new", "storage-old");
      return store.stage(s, context);
    }
    if (action === "commit" || action === "duplicate")
      return store.commit(
        {
          sceneId: "storage-scene",
          revisionId: "storage-new",
          operationId: "operation-storage-new",
        },
        "storage-old",
        signal,
      );
    if (action === "open")
      return summary(await store.open("storage-scene", ctx()));
    if (action === "inspect") return inspect();
    if (action === "stale") {
      const { s, context } = await makeRevision("storage-stale", "storage-old"),
        stage = await store.stage(s, context);
      let error = "";
      try {
        await store.commit(stage, "storage-old", signal);
      } catch (e) {
        error = String(e);
      }
      await store.discardStage(stage);
      return {
        error,
        current: await summary(await store.open("storage-scene", ctx())),
      };
    }
    if (action === "checkout")
      return store.checkout(
        "storage-scene",
        "storage-old",
        "storage-new",
        "storage-undo",
        signal,
      );
    if (action === "reopen") {
      storageFixture = null;
      const snapshot = await store.open("storage-scene", ctx());
      if (snapshot.capability !== "editable")
        throw Error("Expected editable stored fixture");
      const library = await store.libraryForRevision(
        snapshot.revisionId,
        ctx(buildOwnedBytes(snapshot)),
      );
      if (!library) throw Error("Missing saved catalog");
      const assets = [];
      for (const a of snapshot.assets)
        assets.push(await loadAsset(a.assetRef, library, signal));
      const reopened = await storedResultsToRenderPacket(
        snapshot,
        assets,
        signal,
        ctx().resources,
      );
      if (!reopened.ok) throw Error(JSON.stringify(reopened.issues));
      await install(reopened.value.render);
      let missing = "";
      const unrelated = library.manifests.find(
        (m) => !snapshot.assets.some((a) => a.assetRef.id === m.id),
      );
      if (unrelated)
        try {
          await library.resolveMember(
            unrelated,
            unrelated.files[0].path,
            signal,
          );
        } catch (e) {
          missing = String(e);
        }
      return {
        ...(await summary(snapshot)),
        support: reopened.value.surfaceSupport,
        stats: view.stats(),
        drawn: drawnIds.length,
        generationCalls: storageGenerationCalls,
        unrelatedUnavailable: !!missing,
        catalogDigest: library.digest,
      };
    }
    if (action === "fault") {
      const current = await store.open("storage-scene", ctx()),
        id = "storage-fault-" + options.kind,
        { s, context } = await makeRevision(id, current.revisionId),
        abort = new AbortController();
      const originalAdd = IDBObjectStore.prototype.add,
        originalPut = IDBObjectStore.prototype.put;
      let injected = false,
        error = "",
        receipt: any = null;
      if (options.kind === "quota")
        IDBObjectStore.prototype.add = function (...args: any[]) {
          if (this.name === "revisions" && !injected) {
            injected = true;
            throw new DOMException(
              "Injected quota at native staging write",
              "QuotaExceededError",
            );
          }
          return (originalAdd as any).apply(this, args);
        };
      let stage: any;
      try {
        stage = await store.stage(s, context);
        if (options.kind !== "quota")
          IDBObjectStore.prototype.put = function (...args: any[]) {
            if (this.name === options.store && !injected) {
              injected = true;
              if (options.kind === "after-complete")
                this.transaction.addEventListener(
                  "complete",
                  () => abort.abort(),
                  { once: true },
                );
              else {
                const q = (originalPut as any).apply(this, args);
                abort.abort();
                return q;
              }
            }
            return (originalPut as any).apply(this, args);
          };
        receipt = await store.commit(stage, current.revisionId, abort.signal);
      } catch (e) {
        error = String(e);
      } finally {
        IDBObjectStore.prototype.add = originalAdd;
        IDBObjectStore.prototype.put = originalPut;
      }
      return {
        injected,
        error,
        receipt,
        current: await summary(await store.open("storage-scene", ctx())),
        records: await inspect(),
      };
    }
    if (action === "limits") {
      for (let i = 1; i < 20; i++) {
        const { s, context } = await makeRevision(
          "limit-" + i,
          null,
          "limit-scene-" + i,
        );
        await store.commit(await store.stage(s, context), null, signal);
      }
      const { s, context } = await makeRevision(
          "limit-over",
          null,
          "limit-scene-over",
        ),
        stage = await store.stage(s, context);
      let error = "";
      try {
        await store.commit(stage, null, signal);
      } catch (e) {
        error = String(e);
      }
      await store.discardStage(stage);
      return { error, list: await store.list(), records: await inspect() };
    }
    if (action === "fill") {
      const db = await database(),
        unit = new Uint8Array(1024 ** 2),
        parts: BlobPart[] = [];
      let remaining = options.size;
      while (remaining >= unit.length) {
        parts.push(unit);
        remaining -= unit.length;
      }
      if (remaining) parts.push(unit.slice(0, remaining));
      const data = new Blob(parts);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("blobs", "readwrite");
        tx.objectStore("blobs").add({
          hash: options.hash,
          size: data.size,
          data,
          token: crypto.randomUUID(),
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      return data.size;
    }
    if (action === "blob-limit") {
      const same = await makeRevision("same-at-limit", "storage-old"),
        stage = await store.stage(same.s, same.context);
      await store.discardStage(stage);
      const changed = await makeRevision(
        "changed-over-limit",
        "storage-old",
        "storage-scene",
        true,
      );
      let error = "";
      try {
        await store.stage(changed.s, changed.context);
      } catch (e) {
        error = String(e);
      }
      return {
        error,
        current: await summary(await store.open("storage-scene", ctx())),
        records: await inspect(),
      };
    }
    if (action === "corrupt-revision") {
      const db = await database();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("revisions", "readwrite"),
          store = tx.objectStore("revisions"),
          q = store.get(options.revisionId);
        q.onsuccess = () => {
          if (options.remove) store.delete(options.revisionId);
          else store.put({ ...q.result, descriptorDigest: "0".repeat(64) });
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      return true;
    }
    if (action === "conflict") {
      const original = await store.open("storage-scene", ctx()),
        library = await store.libraryForRevision(
          original.revisionId,
          ctx(buildOwnedBytes(original)),
        );
      const changed = parseSnapshot({
        ...original,
        camera: { position: [3, 4, 5], target: [0, 0, 0] },
      });
      let error = "";
      try {
        await store.stage(changed, {
          ...ctx(buildOwnedBytes({ original, changed })),
          library,
        });
      } catch (e) {
        error = String(e);
      }
      return {
        error,
        current: await summary(await store.open("storage-scene", ctx())),
      };
    }
    if (action === "missing-stage") {
      let error = "";
      try {
        await store.readRevision("storage-new", ctx());
      } catch (e) {
        error = String(e);
      }
      return { error, list: await store.list() };
    }
    if (action === "corrupt-blob") {
      const db = await database();
      const revision = await new Promise<any>((resolve, reject) => {
        const q = db
          .transaction("revisions")
          .objectStore("revisions")
          .get("storage-old");
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
      const d = JSON.parse(await revision.descriptor.text()),
        hash = d.document.buffers[0].hash;
      const record = await new Promise<any>((resolve, reject) => {
        const q = db.transaction("blobs").objectStore("blobs").get(hash);
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
      const bytes = new Uint8Array(await record.data.arrayBuffer());
      bytes[0] ^= 1;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("blobs", "readwrite");
        tx.objectStore("blobs").put({ ...record, data: new Blob([bytes]) });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      let error = "";
      try {
        await store.open("storage-scene", ctx());
      } catch (e) {
        error = String(e);
      }
      return error;
    }
    if (action === "budget") {
      const original = Blob.prototype.arrayBuffer;
      let reads = 0;
      Blob.prototype.arrayBuffer = function () {
        reads++;
        return original.call(this);
      };
      const errors: string[] = [];
      try {
        for (const operation of [
          () =>
            store.open("storage-scene", {
              signal,
              resources: { retainedBytes: 240 * 1024 ** 2 },
            }),
          () =>
            store.readRevision("storage-old", {
              signal,
              resources: { retainedBytes: 240 * 1024 ** 2 },
            }),
          () =>
            store.libraryForRevision("storage-old", {
              signal,
              resources: { retainedBytes: 240 * 1024 ** 2 },
            }),
        ])
          try {
            await operation();
          } catch (e) {
            errors.push(String(e));
          }
      } finally {
        Blob.prototype.arrayBuffer = original;
      }
      return { errors, reads };
    }
    throw Error("Unknown storage harness action");
  },
  async buildCase(name: "flat" | "slope" | "river") {
    const { buildFixture } = await import("./support/general-build-fixture");
    const { createBuildClient } =
      await import("../src/general-scene/worker-client");
    const { storedResultsToRenderPacket, buildOwnedBytes } =
      await import("../src/general-scene/compile");
    const { sourceOwnedBytes } =
      await import("../src/general-scene/render/source-bank");
    const f = await buildFixture({
        categories: ["rock", "grass", "reed"],
        slope: name === "slope" ? 8 : 0,
        river: name === "river",
      }),
      client = createBuildClient(),
      start = performance.now(),
      ledger: Record<string, number> = {};
    try {
      ledger.beforeResolve =
        view.stats().ownedBytes +
        buildOwnedBytes({ packages: f.packages, assets: f.assets });
      const r = await client.resolve(f.draft, f.state, f.library, {
        ...f.context,
        resources: { retainedBytes: ledger.beforeResolve },
      });
      if (!r.ok) return { ok: false, stage: "resolve", issues: r.issues };
      ledger.beforeBuild =
        view.stats().ownedBytes + buildOwnedBytes(f.packages);
      const resolvedMs = performance.now() - start,
        b = await client.build(r.value, f.state, f.assets, {
          ...f.context,
          resources: { retainedBytes: ledger.beforeBuild },
        });
      if (!b.ok) return { ok: false, stage: "build", issues: b.issues };
      const out = b.value;
      ledger.beforeReopen =
        view.stats().ownedBytes +
        buildOwnedBytes({
          packages: f.packages,
          assets: f.assets,
          resolved: r.value,
          out,
        }) -
        buildOwnedBytes({ input: out.snapshot, assets: f.assets });
      const reopened = await storedResultsToRenderPacket(
        out.snapshot,
        f.assets,
        f.context.signal,
        { retainedBytes: ledger.beforeReopen },
      );
      if (!reopened.ok)
        return { ok: false, stage: "reopen-render", issues: reopened.issues };
      const counts = out.render.instances.map((i) =>
        Math.max(
          out.render.sources.get(i.sourceKey)!.count,
          i.coarseSourceKey
            ? out.render.sources.get(i.coarseSourceKey)!.count
            : 0,
        ),
      );
      ledger.beforePrepare =
        view.stats().ownedBytes +
        buildOwnedBytes({
          packages: f.packages,
          assets: f.assets,
          resolved: r.value,
          out,
          reopened: reopened.value,
        });
      ledger.prepareReservation =
        sparkRendererBudget(sparkSceneCapacity(counts)).reservedBytes +
        [...out.render.sources.values()].reduce(
          (n, s) => n + sourceOwnedBytes(s),
          0,
        );
      ledger.preparePeak = ledger.beforePrepare + ledger.prepareReservation;
      if (ledger.preparePeak > 256 * 1024 ** 2)
        throw Error("Actual retained + display preparation budget exceeded");
      await install(out.render);
      return {
        ok: true,
        fixture: "constructed-only; no real asset/style admission",
        count: out.snapshot.instances.length,
        geometryDigest: out.snapshot.geometryDigest,
        sourceDigest: await documentDigest([...out.render.sources]),
        usage: out.snapshot.validation.usage,
        ledger,
        actualSourceBytes: out.snapshot.validation.actualSourceBytes,
        buildMs: out.snapshot.validation.buildMs,
        resolvedMs,
        totalMs: performance.now() - start,
        stats: view.stats(),
        surfaceSupport: out.surfaceSupport,
        reopenedSupport: reopened.value.surfaceSupport,
        waterTileOwners:
          out.snapshot.surfaces
            .find((s) => s.role === "water")
            ?.tiles.map((t) => ({
              tileId: t.tileId,
              count: t.outputIndices.length,
            })) ?? [],
        semanticMode: out.report.semanticMode,
        visual: out.report.visual.status,
      };
    } finally {
      client.dispose();
    }
  },
  async buildProperty(input: unknown) {
    const { bindBuildProperty } =
        await import("./support/general-build-fixture"),
      { createBuildClient } =
        await import("../src/general-scene/worker-client"),
      { buildOwnedBytes } = await import("../src/general-scene/compile");
    let f;
    try {
      f = await bindBuildProperty(input);
    } catch (e) {
      return { ok: false, stage: "contract", message: String(e) };
    }
    const client = createBuildClient(),
      start = performance.now();
    try {
      const r = await client.resolve(f.draft, f.state, f.library, {
        ...f.context,
        resources: {
          retainedBytes:
            view.stats().ownedBytes +
            buildOwnedBytes({ packages: f.packages, assets: f.assets }),
        },
      });
      if (!r.ok)
        return {
          ok: false,
          stage: "preflight",
          issues: r.issues,
          bindings: f.bindings,
          totalMs: performance.now() - start,
        };
      const resolveMs = performance.now() - start,
        b = await client.build(r.value, f.state, f.assets, {
          ...f.context,
          resources: {
            retainedBytes:
              view.stats().ownedBytes + buildOwnedBytes(f.packages),
          },
        });
      if (!b.ok)
        return {
          ok: false,
          stage: "compile",
          issues: b.issues,
          bindings: f.bindings,
          totalMs: performance.now() - start,
        };
      return {
        ok: true,
        bindings: f.bindings,
        geometryDigest: b.value.snapshot.geometryDigest,
        requested: b.value.snapshot.validation.requested,
        count: b.value.snapshot.instances.length,
        shortfall: b.value.snapshot.validation.shortfall,
        usage: b.value.snapshot.validation.usage,
        actualSourceBytes: b.value.snapshot.validation.actualSourceBytes,
        resolveMs,
        buildMs: b.value.snapshot.validation.buildMs,
        totalMs: performance.now() - start,
        visual: b.value.report.visual.status,
        water: r.value.geometry.report,
      };
    } finally {
      client.dispose();
    }
  },

  async workerFault(mode: "cancel" | "timeout") {
    const { buildFixture } = await import("./support/general-build-fixture"),
      { createBuildClient } =
        await import("../src/general-scene/worker-client"),
      { buildOwnedBytes } = await import("../src/general-scene/compile");
    const f = await buildFixture(),
      client = createBuildClient(),
      Original = window.Worker,
      observed = { created: 0, posted: 0, terminated: 0 };
    class ObservedWorker extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        observed.created++;
      }
      override postMessage(
        value: any,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        observed.posted++;
        if (Array.isArray(transfer)) super.postMessage(value, transfer);
        else super.postMessage(value, transfer);
        if (mode === "cancel")
          queueMicrotask(() => client.cancel(f.context.operationId));
      }
      override terminate() {
        observed.terminated++;
        super.terminate();
      }
    }
    window.Worker = ObservedWorker;
    buildFaultSession = { f, client, observed, Original };
    const start = performance.now();
    try {
      const result = await client.resolve(f.draft, f.state, f.library, {
        ...f.context,
        resources: {
          retainedBytes:
            view.stats().ownedBytes +
            buildOwnedBytes({ packages: f.packages, assets: f.assets }),
        },
      });
      return {
        result,
        elapsedMs: performance.now() - start,
        observed: { ...observed },
        callerSourceBytes: buildOwnedBytes(f.assets),
      };
    } finally {
      window.Worker = Original;
    }
  },
  async workerFaultRetry() {
    const { f, client, observed } = buildFaultSession,
      { buildOwnedBytes } = await import("../src/general-scene/compile");
    try {
      const r = await client.resolve(f.draft, f.state, f.library, {
        ...f.context,
        operationId: "retry-operation",
        resources: {
          retainedBytes:
            view.stats().ownedBytes +
            buildOwnedBytes({ packages: f.packages, assets: f.assets }),
        },
      });
      if (!r.ok) return r;
      const b = await client.build(r.value, f.state, f.assets, {
        ...f.context,
        operationId: "retry-operation",
        resources: {
          retainedBytes: view.stats().ownedBytes + buildOwnedBytes(f.packages),
        },
      });
      return {
        ok: b.ok,
        issues: b.ok ? [] : b.issues,
        retired: { ...observed },
        count: b.ok ? b.value.snapshot.instances.length : 0,
      };
    } finally {
      client.dispose();
      buildFaultSession = null;
    }
  },
  ready: false,
  async surfaceCase(name: string) {
    if (!["flat", "slope", "river"].includes(name))
      throw Error("Unknown surface inspection case");
    const size = name === "river" ? 8 : name === "slope" ? 6 : 4;
    const input = terrainPlanFixture({
      width: size,
      depth: size,
      terrain: { slopeDegrees: name === "slope" ? 5 : 0 },
    });
    if (name === "river")
      input.water = {
        ...waterFixture(),
        controlPoints: [
          [0.500625, 0],
          [0.500625, 0.2],
          [0.530625, 0.4],
          [0.470625, 0.6],
          [0.500625, 0.8],
          [0.500625, 1],
        ],
        level: 0,
        levelSource: "user",
      };
    const plan = parsePlanDraft(input),
      field = buildTerrain(plan, stateFixture(), null);
    if (!field.ok) throw Error(JSON.stringify(field));
    const solved = solveWater(plan, field.value);
    if (!solved.ok) throw Error(JSON.stringify(solved));
    const solution = solved.value,
      m = manifestFixture("patch");
    const pending = parseSurfaceStyle({
      id: "general-surface-inspection-v1",
      contentVersion: "pending",
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
      quality: {
        ...m.quality,
        operations: [],
        report: "docs/validation/general-asset-admission.md",
        limitations: ["Constructed surface style; human review pending."],
      },
      provenance: {
        ...m.provenance,
        author: "Project procedural surface inspection",
        source: "src/general-scene/surface.ts",
        changes: "Version 1 Gaussian surface inspection; not admitted.",
      },
    });
    const style = parseSurfaceStyle({
        ...pending,
        contentVersion: await styleContentVersion(pending),
      }),
      result = sampleSurfaces(solution, style, 250000 - 4096);
    if (!result.ok) throw Error(JSON.stringify(result));
    const sampled = result.value,
      sources = new Map<string, SplatSource>(),
      instances: RenderPacket["instances"] = [];
    for (const [id, source] of [
      ...sampled.terrain.entries(),
      ...(sampled.water ? [["water", sampled.water] as const] : []),
    ]) {
      if (source.kind !== "float14") throw Error("Expected generated float14");
      const key = `surface/${id}/${await cpuBufferDigest(source.data)}`;
      sources.set(key, source);
      instances.push({
        id,
        sourceKey: key,
        anchor: [0, 0, 0],
        transform: identity,
        coarseSourceKey: null,
      });
    }
    const rock = makeRiverProps(20261010, "low-grass")[0].lods.full,
      rockSource: SplatSource = { kind: "float14", ...rock },
      rockKey = `candidate-rock/${await cpuBufferDigest(rock.data)}`,
      contact = sampleTerrainWorld(solution.field, -1, 0);
    if (!contact.ok) throw Error(JSON.stringify(contact));
    sources.set(rockKey, rockSource);
    instances.push({
      id: "candidate-rock",
      sourceKey: rockKey,
      anchor: [0, 0, 0],
      transform: { ...identity, position: [-1, contact.value.height, 0] },
      coarseSourceKey: null,
    });
    const packet = { sources, instances },
      r = size / 2;
    const views: { name: string; camera: CameraState }[] = [
      {
        name: "overhead",
        camera: { position: [0, size * 1.4, 0.001], target: [0, 0, 0] },
      },
      {
        name: "oblique",
        camera: {
          position: [size * 0.85, size * 0.7, size * 0.85],
          target: [0, 0, 0],
        },
      },
      {
        name: "near-ground",
        camera: { position: [0, 0.35, r + 1.8], target: [0, 0.02, 0] },
      },
      {
        name: "contact",
        camera: {
          position: [-1.75, contact.value.height + 0.55, 1],
          target: [-1, contact.value.height + 0.08, 0],
        },
      },
      {
        name: "shoreline",
        camera: { position: [1.2, 0.75, 1.4], target: [0.3, 0, 0.05] },
      },
      {
        name: "rear-side",
        camera: {
          position: [-size * 0.8, size * 0.35, -size * 0.8],
          target: [0, 0, 0],
        },
      },
    ];
    const overlay: NonNullable<typeof surfaceRecord>["overlay"] = [];
    for (let i = 0; i < solution.field.heights.length; i += 2) {
      const p = terrainNodeWorld(solution.field, i),
        d = sampleWaterDomain(solution, p[0], p[2]);
      if (!d.ok) throw Error(JSON.stringify(d));
      overlay.push({ position: p, kind: d.value.wet === true ? "wet" : "dry" });
    }
    const g = solution.domain.geometry;
    if (g) {
      const segments = g.mode === "river" ? g.cubics.length : g.polygon.length;
      for (let segment = 0; segment < segments; segment++)
        for (const side of g.mode === "river"
          ? ([-1, 1] as const)
          : ([1] as const))
          for (let i = 0; i <= 64; i++) {
            const w = profileBoundaryWitness(g, segment, i / 64, side),
              p = sampleTerrainWorld(solution.field, ...w.point);
            if (p.ok)
              overlay.push({
                position: [w.point[0], p.value.height, w.point[1]],
                kind: "shore",
              });
          }
    }
    for (const tile of solution.field.tiles)
      for (const x of [tile.bounds.min[0], tile.bounds.max[0]])
        for (let i = 0; i <= 10; i++) {
          const z =
              tile.bounds.min[1] +
              (i * (tile.bounds.max[1] - tile.bounds.min[1])) / 10,
            q = sampleTerrainWorld(solution.field, x, z);
          if (q.ok)
            overlay.push({ position: [x, q.value.height, z], kind: "tile" });
        }
    surfaceRecord = {
      name,
      solution,
      sampled,
      style,
      packet,
      views,
      overlay,
      bindings: {
        input: plan,
        inputDigest: await documentDigest(plan),
        solutionDigest: await documentDigest(solution),
        overlayDigest: await documentDigest(overlay),
        waterAlgorithm: WATER_ALGORITHM_VERSION,
        styleDigest: await documentDigest(style),
        object: {
          id: "river-props-rock-seed20261010",
          kind: "procedural-candidate-inspection",
          sourceDigest: await cpuBufferDigest(rock.data),
          humanReview: null,
        },
        scope:
          "Additional constructed surface inspection, not frozen fixture/T9 layout acceptance",
      },
    };
    asset = undefined;
    toggle.checked = false;
    await install(packet);
    view.setCamera(views[1].camera);
    await settle();
    return api.surfaceState();
  },
  surfaceDisplayError(cameraBounds: [number, number, number]) {
    if (!surfaceRecord) throw Error("No surface scene");
    let maxSecondPackError = 0,
      maxDisplayedCenterError = 0;
    const halfUlp = (x: number) =>
      Math.max(2 ** -24, 2 ** (Math.floor(Math.log2(Math.abs(x))) - 10));
    const floatUlp = (x: number) =>
      Math.max(2 ** -149, 2 ** (Math.floor(Math.log2(Math.abs(x))) - 23));
    for (const instance of surfaceRecord.packet.instances) {
      const source = surfaceRecord.packet.sources.get(instance.sourceKey)!;
      if (source.kind !== "float14")
        throw Error("Inspection requires float14 sources");
      for (let i = 0; i < source.count; i++) {
        const raw = Array.from(source.data.subarray(i * 14, i * 14 + 3)) as [
          number,
          number,
          number,
        ];
        const packed = raw.map(surfaceHalf) as [number, number, number];
        const world = worldPoint(packed, instance.anchor, instance.transform);
        const bounds = world.map((v, k) => Math.abs(v) + cameraBounds[k]);
        // Source + shader Float32 world/subtraction arithmetic + second half packing.
        // These inspection transforms are translation/identity rotation, scale=1.
        if (
          instance.transform.scale !== 1 ||
          instance.transform.quaternion.some((v, k) => v !== [0, 0, 0, 1][k])
        )
          throw Error("Unbounded inspection transform arithmetic");
        const arithmetic = Math.hypot(...bounds.map((b) => 4 * floatUlp(b)));
        const second =
          Math.hypot(...bounds.map((b) => halfUlp(b + 4 * floatUlp(b)))) +
          arithmetic;
        maxSecondPackError = Math.max(maxSecondPackError, second);
        maxDisplayedCenterError = Math.max(
          maxDisplayedCenterError,
          second + Math.hypot(...packed.map((v, k) => v - raw[k])),
        );
      }
    }
    return {
      cameraAbsoluteBounds: cameraBounds,
      maxSecondPackError,
      maxDisplayedCenterError,
      errorScope:
        "Center position only in this bounded camera domain; covariance blur, perspective and sorting separate",
    };
  },
  async surfaceState() {
    if (!surfaceRecord) throw Error("No surface scene");
    const { sampled, packet, style, views, bindings, name } = surfaceRecord;
    const sources = await Promise.all(
      [...packet.sources].map(async ([key, s]) => ({
        key,
        count: s.count,
        digest:
          s.kind === "float14" ? await cpuBufferDigest(s.data) : "unsupported",
      })),
    );
    const actualConfig = Object.fromEntries(
      Object.keys(SURFACE_RENDER_CONFIG).map((k) => [
        k,
        (observedSpark as unknown as Record<string, unknown>)[k],
      ]),
    );
    if (JSON.stringify(actualConfig) !== JSON.stringify(SURFACE_RENDER_CONFIG))
      throw Error("Actual renderer differs from surface support configuration");
    return {
      name,
      pointCount: sampled.pointCount,
      ownedBytes: sampled.ownedBytes,
      sampling: sampled.sampling,
      sourceDigest: await documentDigest(sources),
      sources,
      style,
      bindings,
      views,
      stats: view.stats(),
      drawnNodes: drawnIds.length,
      actualConfig,
      camera: view.getCamera(),
      displayError: api.surfaceDisplayError(
        view.getCamera().position.map(Math.abs) as [number, number, number],
      ),
      overlayCount: surfaceRecord.overlay.length,
    };
  },
  async surfaceOrbit() {
    if (!surfaceRecord || surfaceOrbitStep)
      throw Error("Surface orbit unavailable");
    if (!MediaRecorder.isTypeSupported("video/webm;codecs=vp8"))
      throw Error("VP8 MediaRecorder unavailable");
    toggle.checked = false;
    const stream = canvas.captureStream(30),
      recorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp8",
        videoBitsPerSecond: 5000000,
      }),
      chunks: Blob[] = [],
      trace: { elapsedMs: number; camera: CameraState; drawnNodes: number }[] =
        [];
    const captureStart = performance.now();
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>(
      (resolve) => (recorder.onstop = () => resolve()),
    );
    recorder.start(1000);
    const r = surfaceRecord.solution.field.domain.width * 0.82;
    await new Promise<void>((resolve) => {
      let start = 0,
        last = -100;
      surfaceOrbitStep = (now) => {
        if (!start) start = now;
        const elapsed = now - start,
          t = Math.min(1, elapsed / 31000),
          angle = t * Math.PI * 2;
        const camera: CameraState = {
          position: [r * Math.cos(angle), r * 0.7, r * Math.sin(angle)],
          target: [0, 0, 0],
        };
        view.setCamera(camera);
        if (elapsed - last >= 100) {
          trace.push({
            elapsedMs: elapsed,
            camera,
            drawnNodes: drawnIds.length,
          });
          last = elapsed;
        }
        if (elapsed >= 31000) {
          surfaceOrbitStep = undefined;
          resolve();
        }
      };
    });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: "video/webm" }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `surface-${surfaceRecord.name}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return {
      elapsedMs: performance.now() - captureStart,
      animationMs: trace.at(-1)!.elapsedMs,
      trace,
      bytes: blob.size,
      mimeType: recorder.mimeType,
      route: {
        radius: r,
        height: r * 0.7,
        target: [0, 0, 0],
        durationMs: 31000,
      },
      ...api.surfaceDisplayError([r, r * 0.7, r]),
      sourceDigest: (await api.surfaceState()).sourceDigest,
    };
  },
  get view() {
    return view;
  },
  probe: sparkProbe,
  lastError: "",
  resourceDisposalDone: false,
  resourceState() {
    return {
      version: SPARK_BUDGET_VERSION,
      fixture: { countPerNode: 1, sharedSource: true, maxNodes: 121 },
      budgetFor121: sparkRendererBudget(sparkSceneCapacity(Array(121).fill(1))),
      stats: view.stats(),
      observed: sparkProbe.resources(),
      camera: view.getCamera(),
    };
  },
  beginResourceDisposal() {
    running = false;
    cancelAnimationFrame(raf);
    observedSpark!.readPause = 200;
    view.setCamera({ position: [1, 1, 5], target: [0, 0, 0] });
    view.render();
    void view.dispose().then(() => {
      api.resourceDisposalDone = true;
    });
  },
  async beginDelayedDisplay(empty: boolean) {
    await settle();
    running = false;
    cancelAnimationFrame(raf);
    delayedEmpty = empty;
    oldDisplayIds = observedSpark!.display.mapping.map((m) => m.node.uuid);
    observedSpark!.readPause = 120;
    observedSpark!.minSortIntervalMs = 0;
    const key = `visible-${++serial}`;
    delayedSwap = await view.prepare(
      empty
        ? { sources: new Map(), instances: [] }
        : {
            sources: new Map([[key, floatSource()]]),
            instances: [
              {
                ...shared.instances[0],
                id: key,
                sourceKey: key,
                transform: identity,
              },
            ],
          },
      new AbortController().signal,
    );
    delayedSwap.activate();
    view.render();
  },
  delayedState() {
    const displayIds = observedSpark!.display.mapping.map((m) => m.node.uuid);
    const sorted =
      displayIds.length === (delayedEmpty ? 0 : 1) &&
      displayIds.every((id) => !oldDisplayIds.includes(id));
    return {
      sorted,
      usable: delayedSwap!.isUsable(),
      wasDrawn:
        sorted && JSON.stringify(displayIds) === JSON.stringify(drawnIds),
      live: sparkProbe.snapshot().live,
      displayIds,
      drawnIds,
    };
  },
  commitDelayed() {
    try {
      delayedSwap!.commit();
      return true;
    } catch {
      return false;
    }
  },
  drawDelayed() {
    view.render();
  },
  async nodeGrid(count: number) {
    await install({
      ...shared,
      instances: Array.from({ length: count }, (_, i) => ({
        ...shared.instances[0],
        id: String(i),
        transform: {
          ...identity,
          position: [((i % 11) - 5) * 0.25, (Math.floor(i / 11) - 5) * 0.25, 0],
          scale: 0.25,
        },
      })),
    });
  },
  async removeFirst() {
    await install({ ...shared, instances: shared.instances.slice(1) });
  },
  async directional(angle: number, changed: boolean) {
    const n: Transform = {
      position: [0.6, -0.3, 0.2],
      quaternion: [0, Math.sin(0.2), 0, Math.cos(0.2)],
      scale: 1.2,
    };
    const canonical = new Vector3(1, 0, 0)
      .multiplyScalar(n.scale)
      .applyQuaternion(new Quaternion(...n.quaternion))
      .add(new Vector3(...n.position))
      .toArray() as [number, number, number];
    const p: Transform = {
      ...identity,
      quaternion: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
    };
    const composed = sourcePlacement(canonical, n, p);
    await install({
      sources: new Map([["directional", shSource()]]),
      instances: [
        {
          id: "sh3",
          sourceKey: "directional",
          coarseSourceKey: null,
          ...composed,
        },
      ],
    });
    const q = new Quaternion(...composed.transform.quaternion),
      pos = new Vector3(0, 0, changed ? -4 : 4)
        .applyQuaternion(q)
        .toArray() as [number, number, number];
    view.setCamera({ position: pos, target: [0, 0, 0] });
    await settle();
  },
  beginCandidate(kind: "packed" | "ext" | "mesh", mode: "pause" | "fail") {
    api.lastError = "";
    abort = new AbortController();
    sparkProbe[mode === "pause" ? "pauseInitialization" : "failInitialization"](
      kind,
    );
    const source = kind === "ext" ? shSource() : floatSource();
    const key = `candidate-${++serial}`;
    void view
      .prepare(
        {
          sources: new Map([[key, source]]),
          instances: [{ ...shared.instances[0], sourceKey: key }],
        },
        abort.signal,
      )
      .then(
        (s) => s.rollback(),
        (e) => {
          api.lastError = `${e.name}: ${e.message}`;
        },
      );
  },
  cancel() {
    abort?.abort();
  },
  async rollbackCycle() {
    const before = view.getCamera(),
      swap = await view.prepare(
        { ...shared, instances: [shared.instances[0]] },
        new AbortController().signal,
      );
    swap.activate();
    view.setCamera({ position: [4, 3, 2], target: [0, 0, 0] });
    await settle();
    swap.rollback();
    if (JSON.stringify(view.getCamera()) !== JSON.stringify(before))
      throw Error("Camera rollback failed");
    await install(shared);
  },
  async release() {
    running = false;
    cancelAnimationFrame(raf);
    await view.dispose();
  },
  async inspect(catalog: CatalogView, id: string, lod: "full" | "coarse") {
    const library = makeAssetLibrary(catalog, async (ref, name, signal) => {
      const r = await fetch(
        `/__general-review/member?id=${encodeURIComponent(ref.id)}&version=${encodeURIComponent(ref.contentVersion)}&name=${encodeURIComponent(name)}`,
        { signal },
      );
      if (!r.ok) throw Error(`Member read failed ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    asset = await loadAsset(
      {
        id,
        contentVersion: catalog.manifests.find((m) => m.id === id)!
          .contentVersion,
      },
      library,
      new AbortController().signal,
    );
    const packet = makeReviewPacket(asset, lod);
    await install(packet);
    return {
      manifest: asset.manifest,
      views: reviewViews(asset.manifest),
      instance: packet.instances[0],
      source: {
        kind: packet.sources.values().next().value!.kind,
        count: packet.sources.values().next().value!.count,
      },
      stats: view.stats(),
    };
  },
  async camera(camera: CameraState, showDebug = false) {
    toggle.checked = showDebug;
    view.setCamera(camera);
    await settle();
  },
  diagnostics() {
    const gl = canvas.getContext("webgl2")!,
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      gpu: ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      vendor: ext
        ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),
      dpr: devicePixelRatio,
      viewport: [innerWidth, innerHeight],
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      userAgent: navigator.userAgent,
      probe: sparkProbe.snapshot(),
    };
  },
};
(window as any).general = api;
await install(shared);
api.ready = true;
