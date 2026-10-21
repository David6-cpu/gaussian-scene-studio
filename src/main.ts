import "./style.css";
import { createGeneralIntegration } from "./general-scene/integration";
import { mountGeneralScenePanel } from "./general-scene/panel";
import { friendlyMessage } from "./user-message";
import { collectBuffers, type Residency } from "./general-scene/controller";

import { mountEnvironmentPanel } from "./environment/panel";
import { mountPlanner } from "./planner/panel";
import { mountAssetSelection } from "./selection/panel";
import { mountSceneReview } from "./review/panel";
import {
  createPreviewController,
  type PreviewController,
  type StagedPreview,
} from "./review/preview-controller";
import {
  createReviewRecord,
  appendReviewRecord,
  historyKey,
  type ResolvedReview,
  type SceneReviewRecord,
} from "./review/versions";
import { createGaussianView } from "./gaussian/view";
import type {
  BuildResult,
  F0Recipe,
  GaussianView,
  SceneBuildResult,
  SceneRecipe,
  RiverbankRecipe,
} from "./gaussian/types";
import {
  defaultRecipe,
  riversideRecipe,
  parseRecipe,
  isRiverside,
  isRiverProps,
  sceneAssetLabel,
  isRiverbank,
} from "./recipe";
import { makeCameraGuard, applyCameraPreset } from "./camera";
import {
  encodeSceneBundle,
  decodeSceneBundle,
} from "./io/prepared-scene-bundle";
import {
  parseCatalogContext,
  resolvePreparedDefinition,
  type CatalogContext,
} from "./assets/catalog/context";
import { readPreparedGround } from "./io/prepared-ground";
import { downloadBlob } from "./io/download";
import { packBundle, unpackBundle } from "./io/archive";
import { measureRoute } from "./benchmark";

const query = new URLSearchParams(location.search);
const reviewEnabled = query.get("review") === "1";
// Engineering tools (legacy workbench, performance measurement) stay folded
// away unless asked for, so the first screen shows one path.
const advanced = query.has("advanced") || query.get("surface") === "baseline";
const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
<header class="topbar"><div class="brand"><span class="brand-mark">W</span><div><p class="eyebrow">GAUSSIAN SCENE STUDIO</p><h1>高斯自然场景工作室</h1></div></div><div class="phase"><span class="dot"></span> 本机运行 · 预览版</div></header>
<div class="workspace"><aside class="sidebar"><div class="intro"><p class="eyebrow">01 / 描述场景</p><h2>用一句话生成自然场景</h2><p>描述想要的地形、水体、石头和植物，审阅设置后生成可以旋转查看的 3D 场景，并保存在本机。</p></div>
<section id="general-scene-panel" aria-label="生成自然场景"></section>
<section id="scene-review"${reviewEnabled ? "" : " hidden"} aria-label="场景审阅与预览"></section>
<section id="environment-panel" aria-label="导入环境与本机记录"></section>
<details id="advanced-compat"${advanced ? " open" : ""}><summary>高级与旧版本兼容</summary>
<div class="mode-note">Riverside 地表 · 程序低矮细叶草丛与碎石候选（非实拍）</div>
<section id="asset-planner" aria-label="湿地两阶段选材"></section>
<section id="planner" aria-label="场景规划与版本"></section>
<div class="fields">
<label class="wide">场景版本<select id="algorithmVersion"><option value="f0-riverside-grass-v2" selected>Riverside · 低矮细叶草丛与碎石</option><option value="f0-riverside-grass-v1">Riverside · 旧PCG草丛（回退）</option><option value="f0-riverside-reed-v1">Riverside · PCG芦苇与碎石</option><option value="f0-riverside-v1">Riverside · 原石头/植株（回退）</option><option value="f0-v1">原始基线（回退）</option><option value="f0-shore-v2">岸线局部细分（候选）</option></select></label>
<p id="surface-note" class="wide footnote">Riverside 固定4×4展示范围；一块连续地表，不平铺。尺寸为展示比例，非素材实测米制。模糊与边缘拖尾仍在，可切回原始基线。</p>
<label class="wide">随机种子<input id="seed" type="number" value="20261002"></label>
<label>地块宽度<select id="width">${[2, 4, 6, 8, 10].map((n) => `<option ${n === 10 ? "selected" : ""} value="${n}">${n} m</option>`).join("")}</select></label>
<label>地块长度<select id="depth">${[2, 4, 6, 8, 10].map((n) => `<option ${n === 10 ? "selected" : ""} value="${n}">${n} m</option>`).join("")}</select></label>
<label>地形间距<select id="spacing"><option value="0.1">0.1 m · 密</option><option value="0.2" selected>0.2 m · 标准</option><option value="0.4">0.4 m · 疏</option></select></label>
<label>起伏高度 / m<input id="amplitude" type="number" value="0.6" step="0.05" min="0" max="1"></label>
<label><span id="rock-label">石头数量</span><input id="rock" type="number" value="10" min="0" max="20"></label>
<label><span id="reed-label">植株数量</span><input id="reed" type="number" value="10" min="0" max="20"></label>
<label>水位 / m<input id="waterLevel" type="number" value="0" step="0.05" min="-0.5" max="0.5"></label>
<label>噪声层数<input id="octaves" type="number" value="3" min="1" max="5"></label>
</div>
<details><summary>高斯采样参数</summary><div class="fields details-fields"><label>切向尺度<select id="tangentFactor"><option value="0.5">0.5 Δ</option><option value="0.75" selected>0.75 Δ</option><option value="1">1.0 Δ</option></select></label><label>法向厚度<select id="normalFactor"><option value="0.05">0.05 Δ</option><option value="0.1" selected>0.1 Δ</option></select></label><label>透明度<select id="opacity"><option value="0.8">0.80</option><option value="0.95" selected>0.95</option></select></label></div></details>
<div class="toggles"><label><input id="water-enabled" type="checkbox" checked> 静态高斯水面</label><label><input id="lodEnabled" type="checkbox" checked> Gaussian LOD</label></div>
<div class="actions"><button class="primary" id="generate">生成场景 <span aria-hidden="true">↗</span></button><button id="cancel" disabled>取消</button></div>
<div id="status" role="status" data-state="loading">正在准备渲染器…</div><p id="dirty" class="muted"></p>
<div class="file-actions"><button id="save" disabled>保存场景包</button><button id="import">打开场景包</button><button id="clear">清空场景</button><input id="bundle-file" type="file" accept=".zip" hidden></div>
<p class="footnote">场景保存在本机。石头与植株为程序生成的测试代理；水面为静态近似表现。<a href="/diagnostic.html">打开真实资产清晰度对照 ↗</a></p></details></aside>
<section class="viewer"><div class="viewer-top"><div><p class="eyebrow">02 / 探索与观察</p><span id="scene-title">10 × 10 m · 湿地样方</span></div><label class="contrast"><input id="contrast" type="checkbox"> 高对比背景</label></div>
<div class="canvas-wrap"><canvas aria-label="湿地高斯场景"></canvas><div class="canvas-label"><span class="dot"></span><span>GAUSSIAN SCENE</span></div><div class="scene-stats"><div><b id="instance-count">—</b><small>实际实例</small></div><div><b id="active-count">—</b><small>活跃高斯</small></div><div><b id="source-count">—</b><small>共享源高斯</small></div></div><div class="camera-bar"><button data-camera="overlap" class="selected">总览</button><button data-camera="top">俯视</button><button data-camera="eye">眼高</button><button data-camera="low">低角度</button><button data-camera="near">近景</button></div></div>
<div class="viewer-bottom"><span>拖动旋转 · 右键平移 · 滚轮缩放</span><span id="build-time">等待构建</span></div>
<p id="ground-credit" class="footnote" hidden><a href="https://superspl.at/scene/8f52baf1" target="_blank" rel="noopener noreferrer">Riverside © VeryOS</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> · 连续裁片、SH3量化及整体旋转/缩放 · <a href="/assets/riverside-ground-v1/LICENSE.txt">原始许可</a> · <a href="/assets/riverside-ground-v1/SOURCE.json">素材与修改记录</a></p>
<div class="measurement-panel"${advanced ? "" : " hidden"}><div><p class="eyebrow">03 / 验证记录</p><p id="measurement-summary">测量需要 1280×720、DPR=1，保持前台；Esc 可中止。质量和主机内存需另行核验。</p></div><button id="measure" disabled>60 秒性能测量</button><button id="save-measurement" disabled>保存测量</button></div><pre id="measurement-data" hidden></pre><pre id="scene-evidence" hidden></pre>
</section></div>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id),
  number = (id: string) =>
    input(id).value === "" ? NaN : Number(input(id).value);
for (const [value, title] of [
  ["f0-riverbank-grass-v1", "河岸预览 · 低矮草丛"],
  ["f0-riverbank-reed-v1", "河岸预览 · 芦苇"],
]) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = title;
  $("algorithmVersion").append(option);
}
if (reviewEnabled) {
  document.body.classList.add("review-mode");
  document.querySelector(".phase")!.textContent = "本机预览 · 使用后保存";
  document.querySelector(".intro > p:last-child")!.textContent =
    "写下想法，核对摘要，先试看再决定是否使用。";
  document.querySelector(".canvas-label")!.textContent = "河岸场景";
  for (const selector of [
    ".scene-stats",
    ".measurement-panel",
    "#measurement-data",
    "#build-time",
  ]) {
    const element = document.querySelector(selector);
    if (element) $("advanced-compat").append(element);
  }
}
const legacyCredit = $("ground-credit").innerHTML;
const canvas = document.querySelector("canvas")!,
  wrap = document.querySelector(".canvas-wrap")!,
  status = $("status");
let view: GaussianView,
  worker: Worker | null = null,
  cancelWorker: (() => void) | null = null,
  requestId = 0,
  result: SceneBuildResult | null = null,
  lost = false,
  renderFailed = false,
  raf = 0,
  lastStats = 0,
  firstReadyMs = 0,
  measuring = false,
  renderDpr = 1;
let planner: ReturnType<typeof mountPlanner> | undefined;
let assetPlanner: ReturnType<typeof mountAssetSelection> | undefined;
let sceneReview: ReturnType<typeof mountSceneReview> | undefined;
let environmentPanel: ReturnType<typeof mountEnvironmentPanel> | undefined;
let reviewController:
  PreviewController<ResolvedReview, SceneReviewRecord> | undefined;
let previewResult: BuildResult | null = null;
let initialLoadRecipe: F0Recipe | null = null;
let catalogContext: CatalogContext;
let legacyInitializing = true,
  legacyPaused = false,
  legacyFrames = 0,
  legacyTitle = "";
const legacyRoots = new Set<unknown>(),
  legacyDownloads = new Set<Blob>(),
  legacyDrawWaiters = new Set<() => void>();
let lastDrawRequest = -1,
  lastDrawView: GaussianView | undefined;
const legacyJobs = new Set<Promise<unknown>>(),
  retiredViews = new Set<GaussianView>();
const originalInert = new Map<HTMLElement, boolean>(),
  originalHidden = new Map<HTMLElement, HTMLElement["hidden"]>();
function legacyResidency(): Residency {
  const observed = [...(view ? [view] : []), ...retiredViews].map((v) =>
    v.residency(),
  );
  const environment = environmentPanel?.residency();
  if (environment) observed.push(environment);
  return {
    buffers: [
      ...new Set([
        ...collectBuffers([result, previewResult, ...legacyRoots]),
        ...observed.flatMap((r) => [...r.buffers]),
      ]),
    ],
    extraBytes:
      observed.reduce((n, r) => n + r.extraBytes, 0) +
      [...legacyDownloads].reduce((n, b) => n + b.size, 0),
    settled: legacyJobs.size === 0 && observed.every((r) => r.settled),
  };
}
async function legacyQuiescent() {
  while (legacyJobs.size) await Promise.allSettled([...legacyJobs]);
  await Promise.all(
    [...(view ? [view] : []), ...retiredViews].map((v) => v.whenQuiescent()),
  );
  await environmentPanel?.whenQuiescent();
}
function retainLegacy<T>(work: () => Promise<T>): Promise<T> {
  const promise = Promise.resolve().then(work);
  legacyJobs.add(promise);
  void promise.finally(() => legacyJobs.delete(promise)).catch(() => {});
  return promise;
}
function retireLegacy(owner: GaussianView) {
  retiredViews.add(owner);
  owner.dispose();
  void owner
    .whenReleased()
    .then(() => retiredViews.delete(owner))
    .catch((error) => {
      // Keep failed retirement in the ledger; rejection is not release evidence.
      if (general.mode === "legacy")
        state("error", `旧渲染器释放失败：${String(error)}；原数据保留。`);
    });
}
const general = createGeneralIntegration({
  viewerHost: wrap as HTMLElement,
  canSwitch: () => !measuring && !legacyInitializing,
  cancelPending() {
    cancel();
    previewResult = null;
  },
  pause() {
    legacyPaused = true;
    cancelAnimationFrame(raf);
    raf = 0;
    view?.setInteractive(false);
  },
  resume() {
    legacyPaused = false;
    view?.setInteractive(!lost && !renderFailed);
    if (!raf) raf = requestAnimationFrame(tick);
    if (!lost && renderFailed && result) {
      const next = result,
        id = ++requestId;
      void general
        .runLegacyIO(
          "activate",
          () => retainLegacy(() => adopt(next, id, true)),
          128 * 1024 ** 2,
        )
        .catch((e) => {
          if (id === requestId && general.mode === "legacy")
            state("error", `恢复失败：${String(e)}`);
        });
    }
  },
  getCamera: () =>
    view?.getCamera() ?? { position: [6, 5, 6], target: [0, 0, 0] },
  setCamera: (camera) => view?.setCamera(camera.position, camera.target),
  residency: legacyResidency,
  whenQuiescent: legacyQuiescent,
  closeEnvironment: () => environmentPanel?.close(),
  changed(mode) {
    if (mode !== "legacy" && !legacyTitle)
      legacyTitle = $("scene-title").textContent ?? "";
    document.body.classList.toggle("general-mode", mode === "general");
    document.body.classList.toggle("environment-mode", mode === "environment");
    canvas.hidden = mode !== "legacy";
    for (const element of wrap.querySelectorAll<HTMLElement>(
      ".camera-bar,.scene-stats,.canvas-label",
    ))
      element.hidden = mode !== "legacy";
    for (const element of document.querySelectorAll<HTMLElement>(
      ".contrast,.measurement-panel",
    )) {
      if (mode !== "legacy") {
        if (!originalInert.has(element))
          originalInert.set(element, element.inert);
        element.inert = true;
      } else if (originalInert.has(element)) {
        element.inert = originalInert.get(element)!;
        originalInert.delete(element);
      }
    }
    for (const element of document.querySelectorAll<HTMLElement>(
      "#ground-credit,.measurement-panel,#build-time,#measurement-data,#scene-evidence",
    )) {
      if (mode !== "legacy") {
        if (!originalHidden.has(element))
          originalHidden.set(element, element.hidden);
        element.hidden = true;
      } else if (originalHidden.has(element)) {
        element.hidden = originalHidden.get(element)!;
        originalHidden.delete(element);
      }
    }
    if (mode === "general")
      $("scene-title").textContent = "自然场景 · 草稿预览";
    else if (mode === "environment")
      $("scene-title").textContent = "导入环境 · 待画质验收";
    else {
      if (legacyTitle) $("scene-title").textContent = legacyTitle;
      legacyTitle = "";
    }
  },
});
const generalPanel = mountGeneralScenePanel(
  $("general-scene-panel"),
  wrap as HTMLElement,
  general.panelPorts,
);

async function readLocalBytes(
  url: string,
  limit: number,
  signal?: AbortSignal,
) {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) throw Error(`本机素材接口 HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw Error("响应超限");
  if (!response.body) throw Error("响应正文缺失");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("响应超限");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
const createView = () =>
  createGaussianView(canvas, {
    loadPreparedGround: async (ref, signal) => {
      resolvePreparedDefinition(catalogContext, ref);
      return readPreparedGround(
        await readLocalBytes(
          `/api/planner/assets/package/${ref.id}/${ref.contentVersion}`,
          64 * 1024 ** 2,
          signal,
        ),
      );
    },
  });
export const workbench = {
  general,
  observe: () => ({
    mode: general.mode,
    legacyRafActive: raf !== 0 && !legacyPaused,
    legacyFrames,
  }),
  get view() {
    return view;
  },
  get result() {
    return result;
  },
  get requestId() {
    return requestId;
  },
  get lost() {
    return lost;
  },
};
function state(kind: string, message: string) {
  if (general.mode !== "legacy") return;
  status.dataset.state = kind;
  status.textContent = message;
  input("cancel").disabled = kind !== "building";
  input("measure").disabled =
    kind !== "ready" ||
    measuring ||
    result?.recipe.schemaVersion === 2 ||
    isRiverbank(result?.recipe.algorithmVersion);
  input("save").disabled =
    kind === "building" ||
    !result ||
    Boolean(reviewController && reviewController.getState().phase !== "idle");
  input("contrast").disabled = kind === "building";
  for (const b of wrap.querySelectorAll<HTMLButtonElement>("[data-camera]"))
    b.disabled = kind === "building";
  view?.setInteractive(kind !== "building");
}
function publishSceneEvidence() {
  $("scene-evidence").textContent = JSON.stringify({
    recipe: result?.recipe ?? null,
    ...(previewResult ? { previewRecipe: previewResult.recipe } : {}),
    buildReport: result?.report ?? null,
    stats: view.stats(),
    gpu: view.gpuInfo(),
    camera: view.getCamera(),
    viewport: {
      width: canvas.width,
      height: canvas.height,
      deviceDpr: devicePixelRatio,
      renderDpr,
    },
  });
}
function renderFrame(): boolean {
  if (legacyPaused || general.mode !== "legacy") return false;
  try {
    view?.render();
    lastDrawRequest = requestId;
    lastDrawView = view;
    legacyFrames++;
    for (const check of [...legacyDrawWaiters]) check();
    return true;
  } catch (e) {
    cancelWorker?.();
    renderFailed = true;
    sceneReview?.invalidate("渲染中断，预览已取消；上一版数据保留。");
    planner?.sceneFailed(requestId, String(e), true);
    assetPlanner?.sceneFailed(requestId, String(e), true);
    worker?.terminate();
    worker = null;
    requestId++;
    state("error", `渲染停止：${String(e)}。点击生成场景可重建渲染器。`);
    document.dispatchEvent(new CustomEvent("renderer-failed"));
    return false;
  }
}
function waitForDisplayed(id: number): Promise<boolean> {
  const owner = view;
  return new Promise((resolve, reject) => {
    const finish = (visible: boolean, error?: Error) => {
      clearTimeout(timer);
      legacyDrawWaiters.delete(check);
      error ? reject(error) : resolve(visible);
    };
    const check = () => {
      if (
        id !== requestId ||
        view !== owner ||
        lost ||
        renderFailed ||
        general.mode !== "legacy"
      )
        return finish(false);
      if (
        lastDrawRequest === id &&
        lastDrawView === owner &&
        owner.isCurrentSceneDisplayed()
      )
        finish(true);
    };
    const timer = setTimeout(() => finish(false, Error("场景显示超时")), 10000);
    legacyDrawWaiters.add(check);
    check();
  });
}
function readRecipe(): F0Recipe {
  return parseRecipe({
    ...defaultRecipe,
    algorithmVersion: input("algorithmVersion").value,
    seed: number("seed"),
    width: number("width"),
    depth: number("depth"),
    spacing: number("spacing"),
    amplitude: number("amplitude"),
    octaves: number("octaves"),
    tangentFactor: number("tangentFactor"),
    normalFactor: number("normalFactor"),
    opacity: number("opacity"),
    waterLevel: input("water-enabled").checked ? number("waterLevel") : null,
    requested: { rock: number("rock"), reed: number("reed") },
    lodEnabled: input("lodEnabled").checked,
  });
}
function populate(recipe: F0Recipe) {
  for (const key of [
    "algorithmVersion",
    "seed",
    "width",
    "depth",
    "spacing",
    "amplitude",
    "octaves",
    "tangentFactor",
    "normalFactor",
    "opacity",
  ] as const)
    input(key).value = String(recipe[key]);
  input("rock").value = String(recipe.requested.rock);
  input("reed").value = String(recipe.requested.reed);
  $("rock-label").textContent = isRiverProps(recipe.algorithmVersion)
    ? "碎石组数（每组3颗）"
    : "石头数量";
  $("reed-label").textContent = isRiverProps(recipe.algorithmVersion)
    ? "植物丛数"
    : "植株数量";
  input("waterLevel").value = String(recipe.waterLevel ?? 0);
  input("water-enabled").checked = recipe.waterLevel !== null;
  input("lodEnabled").checked = recipe.lodEnabled;
  const scanned = isRiverside(recipe.algorithmVersion);
  for (const key of ["width", "depth", "spacing", "amplitude", "octaves"])
    input(key).disabled = scanned;
  $("surface-note").hidden = !scanned;
}
function cancel() {
  cancelWorker?.();
  sceneReview?.invalidate("已取消，上一版场景保留。");
  planner?.invalidate("构建与待审规划已取消。");
  assetPlanner?.invalidate("构建与待审规划已取消。");
  requestId++;
  view?.cancelPendingScene();
  worker?.terminate();
  worker = null;
  for (const check of [...legacyDrawWaiters]) check();
  state("cancelled", result ? "已取消，保留上一版场景。" : "已取消。");
}
async function ensureRenderer(id: number): Promise<boolean> {
  if (id !== requestId || lost || general.mode !== "legacy") return false;
  if (renderFailed) {
    retireLegacy(view);
    const recovered = await createView();
    if (id !== requestId || lost || general.mode !== "legacy") {
      retireLegacy(recovered);
      return false;
    }
    view = recovered;
    view.setInteractive(true);
    view.setBackground(input("contrast").checked ? 0xd91b78 : 0xe9ecdf);
    renderFailed = false;
    if (result) await recovered.setScene(result.scene);
    // Superseded setScene calls resolve after disposing their temporary data.
    // A newer request may already own this renderer and its pending swap.
    if (
      id !== requestId ||
      lost ||
      view !== recovered ||
      general.mode !== "legacy"
    )
      return false;
    resize();
  }
  return true;
}
async function adopt(next: SceneBuildResult, id: number, imported = false) {
  if (!(await ensureRenderer(id)) || id !== requestId || lost) return;
  const swap = await view.prepareScene(next.scene);
  if (id !== requestId || lost) {
    swap.rollback();
    return;
  }
  try {
    swap.activate();
    view.setLodEnabled(next.recipe.lodEnabled);
    view.setCameraGuard(
      makeCameraGuard(next.heightfield, next.scene, next.recipe.waterLevel),
    );
    applyCameraPreset(
      view,
      next.heightfield,
      "overlap",
      next.recipe.waterLevel,
      next.scene.ground ? 6 : undefined,
    );
    if (!(await waitForDisplayed(id)))
      throw new DOMException("Scene display cancelled", "AbortError");
    swap.commit();
    result = next;
  } catch (e) {
    swap.rollback();
    throw e;
  }
  finishAdopt(next, id, imported);
}
function finishAdopt(next: SceneBuildResult, id: number, imported = false) {
  if (!firstReadyMs) {
    firstReadyMs = performance.now();
    if (next.recipe.schemaVersion === 1) initialLoadRecipe = next.recipe;
  }
  status.dataset.firstReadyMs = String(firstReadyMs);
  status.dataset.seed = String(next.recipe.seed);
  status.dataset.requestId = String(id);
  const missing = next.report.shortfall.rock + next.report.shortfall.reed;
  state(
    "ready",
    `${imported ? "已导入" : "已生成"} · 版本 ${id} · 种子 ${next.recipe.seed}${missing ? ` · 无法放置 ${missing} 个实例` : ""}`,
  );
  let controlsMatch = false;
  try {
    controlsMatch =
      JSON.stringify(readRecipe()) === JSON.stringify(next.recipe);
  } catch {
    /* Invalid pending controls also differ from the displayed recipe. */
  }
  $("dirty").textContent = controlsMatch
    ? ""
    : "参数已修改；点击生成后应用。保存的是当前已显示场景。";
  input("save").disabled = false;
  $("scene-title").textContent =
    next.scene.ground && "kind" in next.scene.ground
      ? `${next.scene.ground.definition.metadata.title} · 4 × 4 展示范围`
      : next.scene.ground
        ? "Riverside · 4 × 4 展示范围 · 试用"
        : `${next.recipe.width} × ${next.recipe.depth} m · 湿地样方`;
  $("ground-credit").hidden = !next.scene.ground;
  if (next.scene.ground && "kind" in next.scene.ground) {
    const d = next.scene.ground.definition,
      a = document.createElement("a");
    a.href = d.metadata.provenance.source;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `${d.metadata.title} © ${d.metadata.provenance.author}`;
    $("ground-credit").replaceChildren(
      a,
      document.createTextNode(
        ` · ${d.metadata.provenance.license} · ${d.mode} · ${d.purpose === "workflow-test" ? "接入流程验证副本，新增合格素材0" : "人工试用候选"} · 许可随自包含场景包保存`,
      ),
    );
    $("measurement-summary").textContent =
      "受控地表路径尚未做旧F0同等性能基准，不给出性能合格判定。";
  } else $("ground-credit").innerHTML = legacyCredit;
  document.querySelector(".mode-note")!.textContent = next.scene.ground
    ? next.recipe.schemaVersion === 2
      ? `${next.scene.ground.id} · 已核对内容版本 · 程序道具`
      : `${sceneAssetLabel(next.recipe.algorithmVersion)} · 配方来源见规划记录`
    : "手工配方 · 合成高斯资产 · 未接入 LLM";
  $("build-time").textContent =
    `${imported ? "保存的构建记录" : "PCG 构建"} ${next.report.stageMs.total.toFixed(1)} ms`;
  publishSceneEvidence();
  document.dispatchEvent(new CustomEvent("scene-ready"));
  if (next.recipe.schemaVersion === 1) planner?.sceneReady(id, next.recipe);
  else planner?.invalidate("当前显示受控地表，原规划关联已清除。", true);
  assetPlanner?.sceneReady(id, next.recipe);
}
function cancelReview() {
  const pending = reviewController?.getState().phase !== "idle";
  reviewController?.cancel();
  if (pending && !lost && !renderFailed) {
    state(result ? "ready" : "empty", "预览已取消，上一版场景保留。");
  }
}
function buildWithWorker(
  recipe: SceneRecipe,
  id: number,
  signal?: AbortSignal,
): Promise<SceneBuildResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (id !== requestId || general.mode !== "legacy") {
      reject(new DOMException("旧构建已取消。", "AbortError"));
      return;
    }
    const current = new Worker(new URL("./build.worker.ts", import.meta.url), {
      type: "module",
    });
    worker = current;
    const clean = () => {
      current.terminate();
      signal?.removeEventListener("abort", abort);
      if (worker === current) {
        worker = null;
        cancelWorker = null;
      }
    };
    const abort = () => {
      clean();
      reject(new DOMException("旧构建已取消。", "AbortError"));
    };
    cancelWorker = abort;
    signal?.addEventListener("abort", abort, { once: true });
    current.onmessage = ({ data }) => {
      clean();
      if (id !== requestId || signal?.aborted || general.mode !== "legacy") {
        reject(new DOMException("旧构建已过期。", "AbortError"));
        return;
      }
      data.ok ? resolve(data.result) : reject(Error(String(data.error)));
    };
    current.onerror = (e) => {
      clean();
      reject(Error(e.message));
    };
    current.postMessage({
      requestId: id,
      recipe,
      ...(recipe.schemaVersion === 2
        ? {
            definition: resolvePreparedDefinition(
              catalogContext,
              recipe.ground,
            ),
          }
        : {}),
    });
  });
}
function buildReview(
  recipe: RiverbankRecipe,
  signal: AbortSignal,
): Promise<BuildResult> {
  signal.throwIfAborted();
  if (!general.enterLegacy()) return Promise.reject(Error("请先结束测量。"));
  cancelWorker?.();
  const id = ++requestId;
  view.cancelPendingScene();
  planner?.invalidate("新的预览已开始，待审规划失效。");
  assetPlanner?.invalidate("新的预览已开始，待审选材失效。");
  state("building", "正在构建临时预览，上一版数据保留…");
  document.dispatchEvent(new CustomEvent("scene-changing"));
  return general.runLegacyIO(
    "activate",
    () =>
      retainLegacy(async () => {
        const next = (await buildWithWorker(recipe, id, signal)) as BuildResult;
        previewResult = next;
        return next;
      }),
    128 * 1024 ** 2,
  );
}
async function stageReviewWork(
  next: BuildResult,
  signal: AbortSignal,
): Promise<StagedPreview> {
  signal.throwIfAborted();
  const id = requestId;
  if (!(await ensureRenderer(id)) || id !== requestId || signal.aborted || lost)
    throw new DOMException("Preview superseded", "AbortError");
  const owner = view,
    previousTitle = $("scene-title").textContent;
  const selectedCamera = wrap.querySelector<HTMLButtonElement>(
    "[data-camera].selected",
  )?.dataset.camera;
  let swap: Awaited<ReturnType<GaussianView["prepareScene"]>> | undefined,
    closed = false;
  const current = () =>
    id === requestId &&
    view === owner &&
    !lost &&
    !renderFailed &&
    !signal.aborted;
  const rollback = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", rollback);
    swap?.rollback();
    if (previewResult === next) previewResult = null;
    if (id === requestId && view === owner) {
      if (!swap) owner.cancelPendingScene();
      $("scene-title").textContent = previousTitle;
      for (const b of wrap.querySelectorAll<HTMLButtonElement>("[data-camera]"))
        b.classList.toggle("selected", b.dataset.camera === selectedCamera);
      if (!lost && !renderFailed)
        state(result ? "ready" : "empty", "预览已取消，上一版场景保留。");
    }
  };
  signal.addEventListener("abort", rollback, { once: true });
  try {
    swap = await owner.prepareScene(next.scene);
    if (!current() || closed) {
      swap.rollback();
      throw new DOMException("Preview cancelled", "AbortError");
    }
    swap.activate();
    previewResult = next;
    owner.setLodEnabled(next.recipe.lodEnabled);
    owner.setCameraGuard(
      makeCameraGuard(next.heightfield, next.scene, next.recipe.waterLevel),
    );
    applyCameraPreset(
      owner,
      next.heightfield,
      "overlap",
      next.recipe.waterLevel,
      6,
    );
    for (const b of wrap.querySelectorAll<HTMLButtonElement>("[data-camera]"))
      b.classList.toggle("selected", b.dataset.camera === "overlap");
    if (!(await waitForDisplayed(id)) || !current())
      throw new DOMException("Preview not displayed", "AbortError");
    state("preview", "预览，尚未使用；旧场景仍是保存目标。");
    $("scene-title").textContent = "河岸预览 · 尚未使用";
    return {
      isUsable: () => !closed && current() && owner.isCurrentSceneDisplayed(),
      rollback,
      commit() {
        if (closed || !current() || !owner.isCurrentSceneDisplayed())
          throw new DOMException("Preview expired", "AbortError");
        swap!.commit();
        closed = true;
        signal.removeEventListener("abort", rollback);
      },
    };
  } catch (e) {
    rollback();
    throw e;
  }
}
function stageReview(
  next: BuildResult,
  signal: AbortSignal,
): Promise<StagedPreview> {
  return general.runLegacyIO(
    "activate",
    () => retainLegacy(() => stageReviewWork(next, signal)),
    128 * 1024 ** 2,
  );
}
function generate(recipe?: SceneRecipe) {
  if (!general.enterLegacy()) return;
  sceneReview?.invalidate("高级操作已开始，待审预览取消。");
  if (lost) {
    state("context-lost", "图形上下文丢失，等待恢复…");
    return;
  }
  cancelWorker?.();
  const id = ++requestId;
  view?.cancelPendingScene();
  document.dispatchEvent(new CustomEvent("scene-changing"));
  try {
    if (!recipe) {
      const problem = invalidLegacyField();
      if (problem) {
        state("error", problem);
        return;
      }
    }
    const selected = recipe ?? readRecipe();
    state("building", `正在构建版本 ${id}…`);
    void general
      .runLegacyIO(
        "activate",
        () =>
          retainLegacy(async () => {
            const next = await buildWithWorker(selected, id);
            await adopt(next, id);
          }),
        128 * 1024 ** 2,
      )
      .catch((e) => {
        if (id !== requestId || general.mode !== "legacy") return;
        planner?.sceneFailed(id, String(e));
        assetPlanner?.sceneFailed(id, String(e));
        state(
          "error",
          friendlyMessage(`生成失败：${String(e)}。上一版仍保留。`),
        );
      });
    return id;
  } catch (e) {
    state(
      "error",
      friendlyMessage(`${String(e)}。请修改后重试；画布保留上一版。`),
    );
  }
}
/** Names the first out-of-range legacy field instead of a raw validator error. */
function invalidLegacyField(): string | null {
  for (const el of document.querySelectorAll<HTMLInputElement>(
    "#advanced-compat .fields input[type=number]",
  )) {
    // Water level is ignored when static water is off.
    if (el.id === "waterLevel" && !input("water-enabled").checked) continue;
    // Empty, out-of-range or (for whole-number fields) fractional values
    // block a build. Decimal fields accept any in-range value, as the recipe
    // does, so their step granularity is not enforced here.
    const v = el.validity,
      wholeNumber = el.step === "" || el.step === "1";
    if (
      el.value !== "" &&
      !v.badInput &&
      !v.rangeOverflow &&
      !v.rangeUnderflow &&
      !(wholeNumber && v.stepMismatch)
    )
      continue;
    const label = el.closest("label")?.textContent?.trim() || el.id;
    const range =
      el.min !== "" && el.max !== "" ? `，范围 ${el.min}–${el.max}` : "";
    el.focus();
    return `请检查“${label}”：需要${wholeNumber ? "整数" : "数值"}${range}。画布保留上一版。`;
  }
  return null;
}
function desiredRenderDpr() {
  // Keep the benchmark reproducible while allowing bounded Retina detail in browsing.
  return measuring ? 1 : Math.min(2, Math.max(1, devicePixelRatio || 1));
}
function resize() {
  const r = wrap.getBoundingClientRect();
  renderDpr = desiredRenderDpr();
  view?.resize(Math.max(1, r.width), Math.max(1, r.height), renderDpr);
}
function tick(time: number) {
  raf = 0;
  if (legacyPaused || general.mode !== "legacy") return;
  // Moving between displays or changing zoom can change DPR without changing layout.
  if (view && desiredRenderDpr() !== renderDpr) resize();
  if (!lost && !renderFailed && !environmentPanel?.active) renderFrame();
  if (view && time - lastStats > 250) {
    const s = view.stats();
    $("instance-count").textContent = String(s.instanceCount);
    $("active-count").textContent = s.activeSplats.toLocaleString();
    $("source-count").textContent = s.uniqueSourceSplats.toLocaleString();
    publishSceneEvidence();
    input("save").disabled =
      status.dataset.state === "building" ||
      !result ||
      Boolean(reviewController && reviewController.getState().phase !== "idle");
    lastStats = time;
  }
  if (!legacyPaused && general.mode === "legacy")
    raf = requestAnimationFrame(tick);
}
$("generate").onclick = () => {
  if (!general.enterLegacy()) return;
  // Supersede in-flight work even if new controls are invalid, without adding an idle version.
  if (status.dataset.state === "building") cancel();
  const problem = invalidLegacyField();
  if (problem) {
    state("error", problem);
    return;
  }
  void planner
    ?.generateManual()
    .catch((e) => state("error", friendlyMessage(String(e))));
};
$("cancel").onclick = cancel;
$("clear").onclick = async () => {
  if (!general.enterLegacy()) return;
  await general.runLegacyIO("activate", async () => {}, 0);
  cancel();
  planner?.invalidate("场景已清空。", true);
  assetPlanner?.invalidate("场景已清空。", true);
  document.dispatchEvent(new CustomEvent("scene-changing"));
  view.clearScene();
  result = null;
  $("ground-credit").hidden = true;
  input("save").disabled = true;
  try {
    if (await waitForDisplayed(requestId)) {
      publishSceneEvidence();
      state("empty", "场景已清空。可以重新生成或打开本地场景包。");
    }
  } catch (e) {
    state("error", String(e));
  }
};
$("measure").onclick = async () => {
  if (
    !result ||
    result.recipe.schemaVersion !== 1 ||
    isRiverbank(result.recipe.algorithmVersion) ||
    lost ||
    measuring ||
    status.dataset.state !== "ready"
  )
    return;
  measuring = true;
  input("measure").disabled = true;
  input("save-measurement").disabled = true;
  document.body.classList.add("benchmark");
  resize();
  const node = $("measurement-data");
  node.textContent = "";
  node.dataset.state = "preparing";
  try {
    await new Promise(requestAnimationFrame);
    const pending = measureRoute(
      view,
      canvas,
      result as BuildResult,
      firstReadyMs,
      initialLoadRecipe!,
    );
    node.dataset.state = "running";
    const report = await pending;
    node.textContent = JSON.stringify(report);
    node.dataset.state = "complete";
    $("measurement-summary").textContent =
      `${report.medianFps.toFixed(1)} FPS · p95 ${report.p95FrameMs.toFixed(1)} ms · ${report.verdict.status}: ${report.verdict.reasons.join("；")}`;
    input("save-measurement").disabled = false;
  } catch (e) {
    node.dataset.state = "error";
    $("measurement-summary").textContent = `测量失败：${String(e)}`;
  } finally {
    measuring = false;
    document.body.classList.remove("benchmark");
    resize();
    input("measure").disabled =
      !result || lost || status.dataset.state !== "ready";
  }
};
$("save-measurement").onclick = () => {
  try {
    downloadBlob(
      new Blob([$("measurement-data").textContent ?? ""], {
        type: "application/json",
      }),
      `wetland-f0-measurement-${Date.now()}.json`,
    );
  } catch (e) {
    state("error", `下载失败：${e}`);
  }
};
$("import").onclick = () => input("bundle-file").click();
$("save").onclick = async () => {
  if (
    !result ||
    status.dataset.state === "building" ||
    (reviewController && reviewController.getState().phase !== "idle")
  )
    return;
  try {
    const saved = result;
    const sourceBytes = collectBuffers([saved]).reduce(
      (n, b) => n + b.byteLength,
      0,
    );
    await general.runLegacyIO(
      "background",
      (reserve) =>
        retainLegacy(async () => {
          const bytes = packBundle(await encodeSceneBundle(saved));
          legacyRoots.add(bytes);
          let copied: Uint8Array<ArrayBuffer> | undefined,
            blob: Blob | undefined;
          try {
            reserve(2 * bytes.byteLength);
            copied = new Uint8Array(bytes);
            legacyRoots.add(copied);
            reserve(copied.byteLength);
            blob = new Blob([copied.buffer], { type: "application/zip" });
            legacyDownloads.add(blob);
            downloadBlob(blob, `wetland-f0-${saved.recipe.seed}.zip`);
            const held = blob;
            setTimeout(() => legacyDownloads.delete(held), 5100);
          } catch (e) {
            if (blob) legacyDownloads.delete(blob);
            throw e;
          } finally {
            legacyRoots.delete(bytes);
            if (copied) legacyRoots.delete(copied);
          }
        }),
      4 * sourceBytes + 16 * 1024 ** 2,
    );
  } catch (e) {
    state("error", `保存失败：${String(e)}`);
  }
};
input("bundle-file").onchange = async () => {
  const file = input("bundle-file").files?.[0];
  if (!file) return;
  if (!general.enterLegacy()) return;
  cancelWorker?.();
  sceneReview?.invalidate("正在打开旧场景包，待审预览已取消。");
  planner?.invalidate("场景包不含规划证据，关联已清除。", true);
  assetPlanner?.invalidate("场景包不含规划证据，待审关联已清除。");
  worker?.terminate();
  worker = null;
  const id = ++requestId;
  view?.cancelPendingScene();
  document.dispatchEvent(new CustomEvent("scene-changing"));
  state("building", "正在校验本地场景包…");
  try {
    if (file.size > 64 * 1024 * 1024) throw new Error("场景包超过64MiB");
    await general.runLegacyIO(
      "activate",
      () =>
        retainLegacy(async () => {
          const bundle = unpackBundle(new Uint8Array(await file.arrayBuffer())),
            next = await decodeSceneBundle(bundle.manifest, bundle.files);
          if (id !== requestId) return;
          await adopt(next, id, true);
          if (id === requestId && next.recipe.schemaVersion === 1)
            populate(next.recipe);
        }),
      6 * file.size + 64 * 1024 ** 2,
    );
  } catch (e) {
    if (id === requestId)
      state("error", `导入失败：${String(e)}。上一版仍保留。`);
  } finally {
    input("bundle-file").value = "";
  }
};
for (const control of document.querySelectorAll<
  HTMLInputElement | HTMLSelectElement
>("#advanced-compat input:not([type=file]),#advanced-compat select"))
  control.addEventListener("input", () => {
    $("dirty").textContent = "参数已修改；点击生成后应用。";
    planner?.recipeEdited();
    assetPlanner?.invalidate("手工参数已修改，待审选材失效。");
    document.dispatchEvent(new CustomEvent("scene-changing"));
  });
input("algorithmVersion").addEventListener("change", () => {
  const version = input("algorithmVersion")
    .value as F0Recipe["algorithmVersion"];
  if (isRiverside(version))
    populate({
      ...riversideRecipe,
      algorithmVersion: version,
      seed: number("seed"),
    });
  else if (input("width").disabled)
    populate({
      ...defaultRecipe,
      algorithmVersion: version,
      seed: number("seed"),
    });
});
$("contrast").onchange = () => {
  view.setBackground(input("contrast").checked ? 0xd91b78 : 0xe9ecdf);
  document.dispatchEvent(new CustomEvent("scene-changing"));
};
for (const button of wrap.querySelectorAll<HTMLButtonElement>("[data-camera]"))
  button.onclick = () => {
    const shown = previewResult ?? result;
    if (!shown) return;
    applyCameraPreset(
      view,
      shown.heightfield,
      button.dataset.camera as "top",
      shown.recipe.waterLevel,
      shown.scene.ground ? 6 : undefined,
    );
    for (const b of wrap.querySelectorAll("[data-camera]"))
      b.classList.toggle("selected", b === button);
  };
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  lost = true;
  cancelWorker?.();
  sceneReview?.invalidate("图形上下文丢失，预览取消；恢复时仅加载已使用场景。");
  view?.cancelPendingScene();
  planner?.invalidate("图形上下文丢失，规划关联已清除。", true);
  assetPlanner?.invalidate("图形上下文丢失，规划待审关联已清除。");
  worker?.terminate();
  worker = null;
  requestId++;
  state("context-lost", "图形上下文丢失，等待恢复后重建。");
  document.dispatchEvent(new CustomEvent("scene-changing"));
});
canvas.addEventListener("webglcontextrestored", () => {
  lost = false;
  renderFailed = true;
  if (general.mode !== "legacy") return;
  const previous = result;
  if (previous) {
    const id = ++requestId;
    state("building", "正在恢复上一版场景…");
    void general
      .runLegacyIO(
        "activate",
        () => retainLegacy(() => adopt(previous, id, true)),
        128 * 1024 ** 2,
      )
      .catch((e) => {
        if (id === requestId && !lost) state("error", `恢复失败：${e}`);
      });
  } else generate(defaultRecipe);
});
window.addEventListener("beforeunload", () => {
  void generalPanel.dispose();
  void general.dispose();
  environmentPanel?.dispose();
  sceneReview?.dispose();
  cancelAnimationFrame(raf);
  cancelWorker?.();
  worker?.terminate();
  view?.dispose();
});
try {
  catalogContext = await general.runLegacyIO(
    "background",
    () =>
      retainLegacy(async () =>
        parseCatalogContext(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              await readLocalBytes("/api/planner/assets/catalog", 1048576),
            ),
          ),
        ),
      ),
    4 * 1024 ** 2,
  );
  planner = mountPlanner($("planner"), {
    catalogContext,
    getRecipe: readRecipe,
    getSurface: () =>
      input("algorithmVersion").value as F0Recipe["algorithmVersion"],
    beforeApply() {
      assetPlanner?.invalidate("原规划开始确认，待审选材已失效。");
    },
    applyRecipe(recipe) {
      populate(recipe);
      return generate(recipe);
    },
  });
  assetPlanner = mountAssetSelection(
    $("asset-planner"),
    {
      beforeApply() {
        planner?.invalidate("选材开始确认，原待审规划已失效。");
      },
      applyRecipe(recipe) {
        if (recipe.schemaVersion === 1) populate(recipe);
        return generate(recipe);
      },
    },
    catalogContext,
  );
  view = await general.runLegacyIO(
    "background",
    () => retainLegacy(createView),
    8 * 1024 ** 2,
  );
  view.setInteractive(general.mode === "legacy");
  view.setBackground(0xe9ecdf);
  new ResizeObserver(resize).observe(wrap);
  resize();
  if (!legacyPaused) raf = requestAnimationFrame(tick);
  populate(
    query.get("surface") === "baseline"
      ? defaultRecipe
      : reviewEnabled && !catalogContext.prepared
        ? {
            ...riversideRecipe,
            algorithmVersion: "f0-riverbank-grass-v1",
            seed: 42,
            waterLevel: 0,
            requested: { rock: 0, reed: 4 },
          }
        : { ...riversideRecipe, algorithmVersion: "f0-riverside-grass-v2" },
  );
  legacyInitializing = false;
  if (general.mode === "legacy") generate();
  if (reviewEnabled) {
    reviewController = createPreviewController({
      build: buildReview,
      stage: stageReview,
      record: createReviewRecord,
      publish(next, record) {
        previewResult = null;
        result = next;
        populate(next.recipe);
        finishAdopt(next, requestId);
        planner?.invalidate("当前场景来自新审阅流程。", true);
        assetPlanner?.invalidate("当前场景来自新审阅流程。", true);
        document.dispatchEvent(
          new CustomEvent("review-used", { detail: record }),
        );
      },
      persist: (record) =>
        appendReviewRecord(localStorage, record, catalogContext, (job) => {
          if (!navigator.locks)
            return Promise.reject(
              Error("浏览器不支持安全的并发保存，请下载记录。"),
            );
          return navigator.locks.request(
            historyKey(record),
            { mode: "exclusive" },
            job,
          );
        }),
    });
    sceneReview = mountSceneReview(
      $("scene-review"),
      {
        preview: reviewController.preview,
        use: reviewController.use,
        cancel: cancelReview,
        getCommitted: () => result,
      },
      catalogContext,
    );
  }
  environmentPanel = mountEnvironmentPanel(
    $("environment-panel"),
    wrap as HTMLElement,
    {
      runIO: (kind, work, reservation) =>
        general.runLegacyIO(kind, work, reservation, "environment"),
      enter() {
        if (general.mode !== "environment")
          throw Error("环境尚未取得模式使用权。");
        view?.setInteractive(false);
      },
      leave() {
        general.environmentClosed();
      },
    },
  );
} catch (e) {
  const text = String(e);
  state(
    "error",
    /本机素材接口 HTTP 404/.test(text)
      ? "无法启动：没有找到本机素材接口。请用“启动湿地项目”或 npm run dev 打开项目，不要直接打开构建后的静态文件。"
      : friendlyMessage(`无法启动目录或WebGL：${text}`),
  );
} finally {
  // Failure also releases entry to general scenes; its own renderer is independent.
  legacyInitializing = false;
}
