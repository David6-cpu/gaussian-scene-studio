// Install observer before dynamically importing the renderer or creating any Spark object.
import { sparkProbe } from "./support/spark-observer";
import { utils, SparkRenderer } from "@sparkjsdev/spark";
import { Quaternion, Vector3 } from "three";
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
} from "../src/general-scene/render/types";
import type { CameraState, Transform } from "../src/general-scene/core";
import { sourcePlacement } from "../src/general-scene/render/types";
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
const { createGeneralView } = await import("../src/general-scene/render/view");
const { makeAssetLibrary } = await import("../src/general-scene/asset-library");
const { loadAsset } = await import("../src/general-scene/asset-loader");
const canvas = document.querySelector<HTMLCanvasElement>("#general")!,
  debug = document.querySelector<HTMLCanvasElement>("#debug")!,
  toggle = document.querySelector<HTMLInputElement>("#toggle-debug")!;
// Independent browser observation: this hook runs after Spark's actual WebGL draw.
let observedSpark: SparkRenderer | undefined,
  drawnIds: string[] = [];
const afterSpark = SparkRenderer.prototype.onAfterRender;
SparkRenderer.prototype.onAfterRender = function (...args) {
  afterSpark.apply(this, args);
  observedSpark = this;
  drawnIds = this.display.mapping.map((m) => m.node.uuid);
};
let delayedSwap: GeneralSwap | undefined,
  delayedEmpty = false,
  oldDisplayIds: string[] = [];
const view = await createGeneralView(canvas);
let running = true,
  raf = 0,
  asset: LoadedAsset | undefined,
  abort: AbortController | undefined,
  serial = 0;
function loop() {
  if (!running) return;
  view.render();
  if (asset)
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
const api = {
  ready: false,
  view,
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
