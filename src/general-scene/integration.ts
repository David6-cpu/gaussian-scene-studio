import { downloadBlob } from "../io/download";
import { PerspectiveCamera } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  createSceneController,
  createBrowserPlanner,
  collectBuffers,
  type Residency,
  type SceneDisplayHost,
} from "./controller";
import { createBuildClient } from "./worker-client";
import { createSceneStore } from "./storage";
import {
  makeAssetLibrary,
  verifyCatalogView,
  type CatalogView,
} from "./asset-library";
import { createGeneralView } from "./render/view";
import type { GeneralView } from "./render/types";
import {
  sparkSceneCapacity,
  sparkRendererBudget,
} from "../gaussian/spark-budget";
import { createGaussianView } from "../gaussian/view";
import type { GaussianView } from "../gaussian/types";
import { readLegacySceneForDisplay } from "./migration";
import { GENERAL_LIMITS as L, type Result, type CameraState } from "./core";
import type { PlanningRequest, PlanningOutcome } from "./planner";
import type {
  GeneralPanelPorts,
  GeneralWorkbenchController,
  GeneralSceneMetadata,
  LegacyPorts,
  WorkbenchMode,
} from "./integration-types";
export type {
  GeneralPanelPorts,
  GeneralSceneMetadata,
  GeneralWorkbenchController,
} from "./integration-types";
const deferBackground = Symbol("background-mode-changed-before-work");
const aborted = () =>
  new DOMException("操作已取消或模式已切换。", "AbortError");
const failure = (e: unknown) => ({
  ok: false as const,
  issues: [
    {
      code:
        e instanceof DOMException && e.name === "AbortError"
          ? "cancelled"
          : "integration",
      path: "workbench",
      message: e instanceof Error ? e.message : String(e),
    },
  ],
});
/** One allocation owner. A queued background intent owns no resources. */
export function createAllocationGate() {
  type Kind = "general" | "legacy" | "background";
  type Job = {
    kind: Kind;
    valid: () => boolean;
    work: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };
  const queue: Job[] = [];
  let running: Kind | null = null,
    general = false,
    closed = false;
  function pump() {
    if (running || closed) return;
    const index = queue.findIndex((j) => j.kind !== "background" || !general);
    if (index < 0) return;
    const j = queue.splice(index, 1)[0];
    running = j.kind;
    void (async () => {
      let value: unknown,
        error: unknown,
        failed = false;
      try {
        if (!j.valid()) throw aborted();
        value = await j.work();
      } catch (e) {
        failed = true;
        error = e;
      }
      running = null;
      if (failed) j.reject(error);
      else j.resolve(value);
      pump();
    })();
  }
  return {
    setGeneral(value: boolean) {
      general = value;
      pump();
    },
    activity: () => ({ running, queued: queue.length }),
    run<T>(
      kind: Kind,
      work: () => Promise<T>,
      valid: () => boolean = () => true,
    ): Promise<T> {
      if (closed) return Promise.reject(aborted());
      return new Promise<T>((resolve, reject) => {
        queue.push({
          kind,
          work,
          valid,
          resolve: (v) => resolve(v as T),
          reject,
        });
        pump();
      });
    },
    dispose() {
      closed = true;
      for (const j of queue.splice(0)) j.reject(aborted());
    },
  };
}
export function manualPlanningOutcome(
  request: PlanningRequest,
): PlanningOutcome {
  return {
    ok: false,
    request,
    query: null,
    inputs: [],
    mode: "manual",
    partial: { intent: null, draft: null, evidence: [] },
    issues: [
      {
        code: "manual-entry",
        path: "request",
        message: "手工设置，未验证原句完整覆盖。",
      },
    ],
  };
}
const sum = (buffers: readonly ArrayBuffer[]) =>
  buffers.reduce((n, b) => n + b.byteLength, 0);
const combine = (...values: Residency[]): Residency => ({
  buffers: [...new Set(values.flatMap((v) => [...v.buffers]))],
  extraBytes: values.reduce((n, v) => n + v.extraBytes, 0),
  settled: values.every((v) => v.settled),
});
const empty = (): Residency => ({ buffers: [], extraBytes: 0, settled: true });
/** Browser integration. main supplies old state through closures, never global lookups. */
export function createGeneralIntegration(legacy: LegacyPorts) {
  const gate = createAllocationGate(),
    store = createSceneStore(),
    buildClient = createBuildClient();
  let mode: WorkbenchMode = "legacy",
    generation = 0,
    disposed = false,
    view: GeneralView | null = null,
    readonlyView: GaussianView | null = null,
    readonlyResult: unknown = null,
    raf = 0,
    frames = 0,
    lastDrawGeneration: number | null = null,
    preparingView: Promise<GeneralView> | null = null,
    savedLegacyCamera: CameraState | null = null,
    savedGeneralCamera: { revisionId: string; camera: CameraState } | null =
      null;
  let legacyReservation = 0;
  let releaseFailure: Error | null = null;
  const retiring = new Set<GeneralView>(),
    retiringLegacy = new Set<GaussianView>(),
    retirement = new Set<Promise<unknown>>(),
    roots = new Set<unknown>(),
    downloads = new Map<Blob, number>();
  function startDownload(blob: Blob, name: string) {
    downloads.set(blob, (downloads.get(blob) ?? 0) + 1);
    const release = () => {
      const count = downloads.get(blob) ?? 0;
      if (count <= 1) downloads.delete(blob);
      else downloads.set(blob, count - 1);
    };
    try {
      downloadBlob(blob, name);
    } catch (error) {
      release();
      throw error;
    }
    // downloadBlob registers its revoke first; keep this owner until after that timer.
    setTimeout(release, 5100);
  }
  const modeListeners = new Set<(mode: WorkbenchMode) => void>();
  const manual = new Set<string>(),
    methodRequests = new Map<
      string,
      { identity: unknown; promise: Promise<any> }
    >();
  const container = document.createElement("div");
  container.id = "general-scene-view";
  container.className = "general-scene-view";
  container.hidden = true;
  const canvas = document.createElement("canvas");
  canvas.id = "general-scene-canvas";
  canvas.setAttribute("aria-label", "自然场景高斯预览");
  const oldCanvas = document.createElement("canvas");
  oldCanvas.id = "general-readonly-canvas";
  oldCanvas.hidden = true;
  oldCanvas.setAttribute("aria-label", "原格式只读高斯预览");
  const label = document.createElement("p");
  label.className = "general-view-label";
  label.textContent = "新场景预览 · 保存草稿不代表画质已验收";
  container.append(canvas, oldCanvas, label);
  legacy.viewerHost.append(container);
  const orbitCamera = new PerspectiveCamera(50, 16 / 9, 0.01, 150),
    controls = new OrbitControls(orbitCamera, canvas);
  controls.enableDamping = false;
  controls.enabled = false;
  let synchronized = "",
    fallbackCamera: CameraState = { position: [6, 5, 6], target: [0, 0, 0] };
  type Waiter = {
    valid: () => boolean;
    ready: () => boolean;
    resolve: () => void;
    reject: (e: unknown) => void;
  };
  const waiters = new Set<Waiter>();
  const remember = (p: Promise<unknown>) => {
    retirement.add(p);
    void p.then(
      () => retirement.delete(p),
      (error) => {
        releaseFailure ??= new Error(
          `显示资源释放失败，已停止新分配；请重新加载页面：${String(error)}`,
        );
        retirement.delete(p);
      },
    );
  };
  function requireReleased() {
    if (releaseFailure) throw releaseFailure;
  }
  function retireGeneral(old: GeneralView) {
    retiring.add(old);
    const done = (async () => {
      await old.dispose();
      await old.whenPreparationSettled();
      if (old.stats().ownedBytes !== 0) throw Error("渲染器仍持有资源。");
      retiring.delete(old);
    })();
    remember(done);
    return done;
  }
  function retireReadonly(old: GaussianView) {
    retiringLegacy.add(old);
    const done = (async () => {
      old.dispose();
      await old.whenReleased();
      retiringLegacy.delete(old);
    })();
    remember(done);
    return done;
  }
  function releaseView() {
    if (view) {
      const old = view;
      view = null;
      retireGeneral(old);
    }
    if (readonlyView) {
      const old = readonlyView;
      readonlyView = null;
      readonlyResult = null;
      retireReadonly(old);
    }
    for (const w of waiters) {
      w.reject(aborted());
    }
    waiters.clear();
  }
  function ownResidency(): Residency {
    const old = [
      ...(readonlyView ? [readonlyView] : []),
      ...retiringLegacy,
    ].map((v) => v.residency());
    return combine(
      {
        buffers: collectBuffers([...roots, readonlyResult]),
        extraBytes: [...downloads.keys()].reduce((n, b) => n + b.size, 0),
        settled: !preparingView && !releaseFailure,
      },
      ...old,
    );
  }
  function external(): Residency {
    const r = combine(legacy.residency(), ownResidency());
    return {
      ...r,
      extraBytes: r.extraBytes + legacyReservation,
      settled:
        r.settled &&
        gate.activity().running !== "legacy" &&
        gate.activity().running !== "background",
    };
  }
  function total() {
    return combine(raw.getResidency(), external());
  }
  function checkBytes(increment: number) {
    const r = total();
    if (
      !Number.isSafeInteger(increment) ||
      increment < 0 ||
      sum(r.buffers) + r.extraBytes + increment > L.maxTransitionBytes
    )
      throw Error("当前与候选资源超过256 MiB预算；原场景和已保存记录保留。");
  }
  function tick() {
    raf = 0;
    if (disposed || mode !== "general") return;
    try {
      if (readonlyView) {
        readonlyView.render();
        frames++;
        lastDrawGeneration = generation;
      } else if (view) {
        const actual = view.getCamera(),
          key = JSON.stringify(actual);
        if (key !== synchronized) {
          orbitCamera.position.fromArray(actual.position);
          controls.target.fromArray(actual.target);
          orbitCamera.lookAt(controls.target);
        }
        controls.update();
        const next: CameraState = {
          position: orbitCamera.position.toArray() as [number, number, number],
          target: controls.target.toArray() as [number, number, number],
        };
        view.setCamera(next);
        synchronized = JSON.stringify(next);
        view.render();
        frames++;
        lastDrawGeneration = generation;
      }
      for (const w of [...waiters]) {
        if (!w.valid()) {
          waiters.delete(w);
          w.reject(aborted());
        } else if (w.ready()) {
          waiters.delete(w);
          w.resolve();
        }
      }
    } catch (e) {
      label.textContent = `显示中断：${e instanceof Error ? e.message : String(e)}；已保存记录保留，可重新打开。`;
      raw.cancel();
      releaseView();
    }
    if (mode === "general" && !disposed) raf = requestAnimationFrame(tick);
  }
  function waitForFrame(
    ready: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const owner = generation;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        waiters.delete(w);
        error ? reject(error) : resolve();
      };
      const stop = () => finish(aborted());
      const w: Waiter = {
        valid: () =>
          !disposed &&
          mode === "general" &&
          owner === generation &&
          !signal.aborted,
        ready,
        resolve: () => finish(),
        reject: finish,
      };
      timer = setTimeout(() => finish(Error("实际场景显示超时。")), 10000);
      waiters.add(w);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  }
  async function ensureView(signal: AbortSignal) {
    signal.throwIfAborted();
    if (mode !== "general") throw aborted();
    requireReleased();
    if (view?.activity().available) return view;
    const owner = generation;
    if (view) {
      releaseView();
      await Promise.allSettled([...retirement]);
      requireReleased();
      if (
        disposed ||
        mode !== "general" ||
        owner !== generation ||
        signal.aborted
      )
        throw aborted();
    }
    if (!preparingView) {
      checkBytes(8 * 1024 ** 2);
      preparingView = createGeneralView(canvas)
        .then(async (next) => {
          if (
            disposed ||
            mode !== "general" ||
            owner !== generation ||
            signal.aborted
          ) {
            await retireGeneral(next);
            throw aborted();
          }
          view = next;
          next.setCamera(fallbackCamera);
          synchronized = "";
          return next;
        })
        .finally(() => {
          preparingView = null;
        });
    }
    return preparingView;
  }
  const absent: GeneralView = {
    prepare: async () => {
      throw Error("请先进入自然场景预览。");
    },
    activity: () => ({ preparing: false, available: false }),
    whenPreparationSettled: async () => {},
    getCamera: () => fallbackCamera,
    setCamera: (c) => {
      fallbackCamera = c;
    },
    stats: () => ({
      sourceCount: 0,
      instanceCount: 0,
      activeSplats: 0,
      ownedBytes: 0,
    }),
    render() {},
    dispose: async () => {},
  };
  const display: SceneDisplayHost = {
    current: () => view ?? absent,
    views: () => [...(view ? [view] : []), ...retiring],
    waitForDisplayed: (v, swap, signal) =>
      waitForFrame(() => view === v && swap.isUsable(), signal),
    replace: async (signal) => {
      releaseView();
      await Promise.allSettled([...retirement]);
      requireReleased();
      return ensureView(signal);
    },
    async showLegacy(snapshot, signal) {
      const owner = generation,
        held = total();
      const decoded = await readLegacySceneForDisplay(
        snapshot.original,
        snapshot.originVersion,
        {
          signal,
          resources: { retainedBytes: sum(held.buffers) + held.extraBytes },
          candidateBytes: snapshot.original.bytes.byteLength,
        },
      );
      roots.add(decoded);
      const owns = () =>
        !disposed &&
        mode === "general" &&
        generation === owner &&
        !signal.aborted;
      try {
        signal.throwIfAborted();
        if (!owns()) throw aborted();
        if (readonlyView) {
          const old = readonlyView;
          readonlyView = null;
          readonlyResult = null;
          await retireReadonly(old);
        }
        if (!owns()) throw aborted();
        const scene = decoded.scene,
          counts = [
            scene.terrain.count,
            scene.water?.count ?? 0,
            scene.ground?.count ?? 0,
            ...scene.instances.map((i) => {
              const a = scene.assets.find((a) => a.id === i.assetId)!;
              return Math.max(a.lods.full.count, a.lods.coarse.count);
            }),
          ].filter((n) => n > 0);
        const sourceBytes = sum(collectBuffers([scene]));
        checkBytes(
          3 * sourceBytes +
            sparkRendererBudget(sparkSceneCapacity(counts)).reservedBytes,
        );
        const next = await createGaussianView(oldCanvas);
        if (!owns()) {
          await retireReadonly(next);
          throw aborted();
        }
        readonlyView = next;
        readonlyResult = decoded;
        canvas.hidden = true;
        oldCanvas.hidden = false;
        controls.enabled = false;
        let swap: Awaited<ReturnType<GaussianView["prepareScene"]>> | undefined;
        try {
          swap = await next.prepareScene(decoded.scene);
          if (!owns() || readonlyView !== next) throw aborted();
          swap.activate();
          next.setCamera(snapshot.camera.position, snapshot.camera.target);
          next.setInteractive(true);
          await waitForFrame(
            () => readonlyView === next && next.isCurrentSceneDisplayed(),
            signal,
          );
          swap.commit();
        } catch (e) {
          swap?.rollback();
          if (readonlyView === next) {
            readonlyView = null;
            readonlyResult = null;
            retireReadonly(next);
          }
          throw e;
        }
      } finally {
        roots.delete(decoded);
      }
    },
  };
  const networkPlanner = createBrowserPlanner();
  const raw = createSceneController({
    planner: (request, signal, phase) =>
      manual.has(request.operationId)
        ? Promise.resolve(manualPlanningOutcome(request))
        : networkPlanner(request, signal, phase),
    buildClient,
    store,
    library: readLibrary,
    display,
    externalResidency: external,
  });
  async function boundedFetch(url: string, limit: number, signal: AbortSignal) {
    const response = await fetch(url, { signal, redirect: "error" });
    if (!response.ok) throw Error(`本机素材读取失败 HTTP ${response.status}`);
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > limit)
    )
      throw Error("素材响应声明超过限额。");
    const reader = response.body?.getReader();
    if (!reader) throw Error("素材响应正文缺失。");
    const chunks: Uint8Array[] = [];
    roots.add(chunks);
    let length = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) throw Error("素材响应超过限额。");
        if (!(value.buffer instanceof ArrayBuffer))
          throw Error("素材响应使用不支持的共享缓冲区。");
        // Response length concerns the view; residency concerns its full backing.
        if (!total().buffers.includes(value.buffer))
          checkBytes(value.buffer.byteLength);
        chunks.push(value);
      }
      if (declared !== null && length !== Number(declared))
        throw Error("素材响应长度不符。");
      checkBytes(length);
      const out = new Uint8Array(length);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    } finally {
      roots.delete(chunks);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function readLibrary(signal: AbortSignal) {
    const bytes = await boundedFetch(
      "/api/planner/general/catalog",
      L.maxJsonBytes,
      signal,
    );
    roots.add(bytes);
    try {
      const catalog = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as CatalogView;
      await verifyCatalogView(catalog);
      return makeAssetLibrary(catalog, async (ref, name, abort) => {
        const file = catalog.manifests
          .find(
            (m) => m.id === ref.id && m.contentVersion === ref.contentVersion,
          )
          ?.files.find((f) => f.path === name);
        if (!file) throw Error("素材成员不在原目录中。");
        return boundedFetch(
          `/api/planner/general/assets/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.contentVersion)}/${encodeURIComponent(name)}`,
          file.bytes,
          abort,
        );
      });
    } finally {
      roots.delete(bytes);
    }
  }
  function switchMode(next: WorkbenchMode) {
    if (disposed) return false;
    if (mode === next) return true;
    if (!legacy.canSwitch()) return false;
    const previous = mode;
    mode = next;
    generation++;
    if (previous === "general") {
      const state = raw.getState();
      savedGeneralCamera =
        state.current && (state.phase === "idle" || state.phase === "committed")
          ? {
              revisionId: state.current.revisionId,
              camera:
                readonlyView?.getCamera() ??
                view?.getCamera() ??
                fallbackCamera,
            }
          : null;
      raw.cancel();
      cancelAnimationFrame(raf);
      raf = 0;
      controls.enabled = false;
      container.hidden = true;
      releaseView();
    }
    if (previous === "environment") legacy.closeEnvironment();
    if (next === "general") {
      legacy.cancelPending();
      savedLegacyCamera = legacy.getCamera();
      legacy.pause();
      container.hidden = false;
      canvas.hidden = false;
      oldCanvas.hidden = true;
      controls.enabled = true;
      raf = requestAnimationFrame(tick);
    } else if (next === "environment") {
      legacy.cancelPending();
      legacy.pause();
    } else {
      if (savedLegacyCamera) {
        legacy.setCamera(savedLegacyCamera);
        savedLegacyCamera = null;
      }
      legacy.resume();
    }
    legacy.changed(next);
    for (const listener of modeListeners) {
      try {
        listener(next);
      } catch {
        /* Observers do not control ownership. */
      }
    }
    // Observers release review roots before any queued IO may acquire the lease.
    gate.setGeneral(next === "general");
    if (next === "general" && raw.getState().current) {
      label.textContent = "正在恢复当前场景…";
      void controller.redisplayCurrent();
    }
    return true;
  }
  function enterMode() {
    return switchMode("general");
  }
  function leaveMode() {
    if (mode === "general") switchMode("legacy");
  }
  async function allocate<T>(
    work: () => Promise<T>,
    needsDisplay = false,
    requireMode = true,
  ): Promise<T> {
    if (requireMode && mode !== "general")
      throw Error("请先进入生成自然场景。");
    const owner = generation;
    return gate.run(
      "general",
      async () => {
        await legacy.whenQuiescent();
        await raw.whenSettled();
        await Promise.allSettled([...retirement]);
        await readonlyView?.whenQuiescent();
        requireReleased();
        if (requireMode && (mode !== "general" || owner !== generation))
          throw aborted();
        if (needsDisplay) {
          await ensureView(new AbortController().signal);
          canvas.hidden = false;
          oldCanvas.hidden = true;
          controls.enabled = true;
          if (readonlyView) {
            const old = readonlyView;
            readonlyView = null;
            readonlyResult = null;
            await retireReadonly(old);
            requireReleased();
            if (disposed || mode !== "general" || owner !== generation)
              throw aborted();
          }
        }
        try {
          return await work();
        } finally {
          await raw.whenSettled();
        }
      },
      () =>
        !disposed &&
        (!requireMode || (mode === "general" && generation === owner)),
    );
  }
  function once<T>(
    key: string,
    identity: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const prior = methodRequests.get(key);
    if (prior) {
      if (prior.identity !== identity)
        return Promise.reject(Error("同一操作标识不能用于不同请求。"));
      return prior.promise;
    }
    const promise = work();
    methodRequests.set(key, { identity, promise });
    void promise
      .finally(() => {
        if (methodRequests.get(key)?.promise === promise)
          methodRequests.delete(key);
      })
      .catch(() => {});
    return promise;
  }
  const resultWork = <T>(work: () => Promise<Result<T>>, display = false) =>
    allocate(work, display).catch(failure);
  const plan = (
    request: PlanningRequest,
    isManual = false,
  ): Promise<PlanningOutcome> =>
    once(
      `plan:${request.operationId}`,
      JSON.stringify({ request, isManual }),
      () =>
        allocate(async () => {
          if (isManual) manual.add(request.operationId);
          try {
            return await raw.plan(request);
          } finally {
            manual.delete(request.operationId);
          }
        }).catch((e) => ({
          ...manualPlanningOutcome(request),
          issues: failure(e).issues,
        })),
    );
  const controller: GeneralWorkbenchController = {
    plan: (request) => plan(request),
    planManual: (request) => plan(request, true),
    review: (...a) => resultWork(() => raw.review(...a)),
    preview: (input) =>
      once("preview", input, () => resultWork(() => raw.preview(input), true)),
    proposePatch: (p) =>
      once("proposePatch", JSON.stringify(p), () =>
        resultWork(() => raw.proposePatch(p)),
      ),
    previewPatch: (p) =>
      once("previewPatch", JSON.stringify(p), () =>
        resultWork(() => raw.previewPatch(p), true),
      ),
    use: (id) => once(`use:${id}`, id, () => resultWork(() => raw.use(id))),
    reopen: (id) => resultWork(() => raw.reopen(id), true),
    importArchive: (input) => resultWork(() => raw.importArchive(input), true),
    importFile: (file) =>
      resultWork(async () => {
        if (file.size > L.maxCompressedPackageBytes)
          throw Error("归档超过64 MiB，原文件保留。");
        checkBytes(file.size);
        const bytes = new Uint8Array(await file.arrayBuffer());
        roots.add(bytes);
        try {
          return await raw.importArchive(bytes);
        } finally {
          roots.delete(bytes);
        }
      }, true),
    exportArchive: (mode) => resultWork(() => raw.exportArchive(mode)),
    downloadArchive: (mode) =>
      resultWork(async () => {
        const result = await raw.exportArchive(mode);
        if (!result.ok) return result;
        const bytes = result.value;
        roots.add(bytes);
        let copy: Uint8Array<ArrayBuffer> | undefined, blob: Blob | undefined;
        try {
          checkBytes(2 * bytes.byteLength);
          copy = new Uint8Array(bytes);
          roots.add(copy);
          checkBytes(copy.byteLength);
          blob = new Blob([copy.buffer], { type: "application/zip" });
          startDownload(
            blob,
            `general-scene-${raw.getState().current?.sceneId ?? "draft"}.zip`,
          );
          return { ok: true, value: undefined };
        } finally {
          roots.delete(bytes);
          if (copy) roots.delete(copy);
        }
      }),
    downloadOriginal: (file) =>
      allocate(
        async () => {
          checkBytes(downloads.has(file) ? 0 : file.size);
          startDownload(file, file.name);
          return { ok: true as const, value: undefined };
        },
        false,
        false,
      ).catch(failure),
    undo: () => resultWork(() => raw.undo(), true),
    cancel() {
      generation++;
      raw.cancel();
    },
    getCurrentCatalog: raw.getCurrentCatalog,
    redisplayCurrent: () => {
      const owner = generation;
      return once(
        `redisplay:${owner}`,
        raw.getState().current?.revisionId,
        async () => {
          const result = await resultWork(() => raw.redisplayCurrent(), true);
          if (!disposed && mode === "general" && generation === owner) {
            if (result.ok) {
              if (
                savedGeneralCamera?.revisionId ===
                raw.getState().current?.revisionId
              ) {
                const camera = savedGeneralCamera!.camera;
                if (readonlyView)
                  readonlyView.setCamera(camera.position, camera.target);
                else view?.setCamera(camera);
              }
              label.textContent = "自然场景预览 · 画质尚未验收";
            } else {
              label.textContent = `显示恢复失败：${result.issues.map((issue) => issue.message).join("；")}；原场景数据保留，可重新打开。`;
            }
          }
          return result;
        },
      );
    },
    getState: raw.getState,
    getResidency: raw.getResidency,
    whenSettled: raw.whenSettled,
    subscribe: raw.subscribe,
    listScenes: () => allocate(() => store.list(), false, false),
    catalog: (signal) =>
      allocate(
        async () => {
          const l = await readLibrary(signal);
          return { digest: l.digest, manifests: l.manifests, styles: l.styles };
        },
        false,
        false,
      ),
    metadata: () =>
      allocate(async () => {
        const current = raw.getState().current,
          owner = generation;
        if (!current) return null;
        const retained = total(),
          abort = new AbortController();
        const snapshot = await store.readRevision(current.revisionId, {
          signal: abort.signal,
          resources: {
            retainedBytes: sum(retained.buffers) + retained.extraBytes,
          },
        });
        roots.add(snapshot);
        try {
          if (
            disposed ||
            mode !== "general" ||
            owner !== generation ||
            raw.getState().current?.revisionId !== current.revisionId
          )
            throw aborted();
          const {
            sceneId,
            revisionId,
            parentRevisionId,
            capability,
            intent,
            plan,
            state,
            instances,
            assets,
            surfaceStyle,
            quality,
            reviewStatus,
            camera,
            patch,
            geometryDigest,
            validation,
          } = snapshot;
          return {
            sceneId,
            revisionId,
            parentRevisionId,
            capability,
            intent,
            plan,
            state,
            instances,
            assets,
            surfaceStyle,
            quality,
            reviewStatus,
            camera,
            patch,
            geometryDigest,
            validation,
            access: current.access,
            issues: current.issues,
          } as GeneralSceneMetadata;
        } finally {
          roots.delete(snapshot);
        }
      }),
  };
  return {
    panelPorts: {
      controller,
      enterMode,
      leaveMode,
      subscribeMode(listener) {
        modeListeners.add(listener);
        try {
          listener(mode);
        } catch {
          /* Observers do not control ownership. */
        }
        return () => modeListeners.delete(listener);
      },
    } satisfies GeneralPanelPorts,
    get mode() {
      return mode;
    },
    enterLegacy: () => switchMode("legacy"),
    diagnostics: () => ({
      mode,
      generation,
      lease: gate.activity(),
      rafActive: raf !== 0,
      frames,
      lastDrawGeneration,
      releaseFailure: releaseFailure?.message ?? null,
      view: view?.stats() ?? null,
      readonlyView: readonlyView?.residency() ?? null,
      residency: total(),
    }),
    async runLegacyIO<T>(
      kind: "activate" | "background",
      work: (reserve: (additionalBytes: number) => void) => Promise<T>,
      reservationBytes?: number,
      target: "legacy" | "environment" = "legacy",
    ): Promise<T> {
      if (kind === "activate" && !switchMode(target))
        throw Error("请先结束当前测量。");
      const owner = generation;
      while (true) {
        try {
          return await gate.run(
            kind === "activate" ? "legacy" : "background",
            async () => {
              await raw.whenSettled();
              await Promise.allSettled([...retirement]);
              requireReleased();
              if (
                disposed ||
                (kind === "activate" &&
                  (owner !== generation || mode !== target))
              )
                throw aborted();
              // A mode switch during cleanup must queue an unstarted background intent again.
              // Rejecting this attempt releases its lease before the outer loop requeues it.
              if (kind === "background" && mode === "general")
                throw deferBackground;
              const held = raw.getResidency();
              if (
                reservationBytes === undefined &&
                sum(held.buffers) + held.extraBytes > 0
              )
                throw Error(
                  "旧操作缺少可核验内存预留，暂不分配；已保存数据保留。",
                );
              const reserve = (additionalBytes: number) => {
                const r = total(),
                  bytes = sum(r.buffers) + r.extraBytes - legacyReservation;
                if (
                  !Number.isSafeInteger(additionalBytes) ||
                  additionalBytes < 0 ||
                  bytes + additionalBytes > L.maxTransitionBytes
                )
                  throw Error(
                    "旧操作资源预留超过256 MiB预算；原场景和已保存记录保留。",
                  );
                legacyReservation = additionalBytes;
              };
              try {
                if (reservationBytes !== undefined) reserve(reservationBytes);
                return await work(reserve);
              } finally {
                legacyReservation = 0;
              }
            },
            () =>
              !disposed &&
              (kind === "background" ||
                (owner === generation && mode === target)),
          );
        } catch (error) {
          if (error !== deferBackground) throw error;
        }
      }
    },
    environmentClosed() {
      if (mode === "environment") switchMode("legacy");
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      raw.cancel();
      gate.dispose();
      cancelAnimationFrame(raf);
      raf = 0;
      releaseView();
      controls.dispose();
      await raw.whenSettled();
      await Promise.allSettled([...retirement]);
      buildClient.dispose();
      container.remove();
    },
  };
}
