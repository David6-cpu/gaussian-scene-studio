import "./style.css";
import { mountPlanner } from "./planner/panel";
import { mountAssetSelection } from "./selection/panel";
import { createGaussianView } from "./gaussian/view";
import type { BuildResult, F0Recipe, GaussianView } from "./gaussian/types";
import {
  defaultRecipe,
  riversideRecipe,
  parseRecipe,
  isRiverside,
  isRiverProps,
  sceneAssetLabel,
} from "./recipe";
import { makeCameraGuard, applyCameraPreset } from "./camera";
import { encodeBundle, decodeBundle } from "./io/bundle";
import { packBundle, unpackBundle } from "./io/archive";
import { measureRoute } from "./benchmark";

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
<header class="topbar"><div class="brand"><span class="brand-mark">W</span><div><p class="eyebrow">WETLAND / FIELD LAB</p><h1>湿地生成实验室</h1></div></div><div class="phase"><span class="dot"></span> F0 · 统一高斯验证</div></header>
<div class="workspace"><aside class="sidebar"><div class="intro"><p class="eyebrow">01 / 构建场景</p><h2>一块可以探索的湿地</h2><p>调整地形与资产，观察高斯场景的形态、覆盖和细节。</p></div>
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
<p class="footnote">场景保存在本机。石头与植株为程序生成的测试代理；水面为静态近似表现。<a href="/diagnostic.html">打开真实资产清晰度对照 ↗</a></p></aside>
<section class="viewer"><div class="viewer-top"><div><p class="eyebrow">02 / 探索与观察</p><span id="scene-title">10 × 10 m · 湿地样方</span></div><label class="contrast"><input id="contrast" type="checkbox"> 高对比背景</label></div>
<div class="canvas-wrap"><canvas aria-label="湿地高斯场景"></canvas><div class="canvas-label"><span class="dot"></span><span>GAUSSIAN SCENE</span></div><div class="scene-stats"><div><b id="instance-count">—</b><small>实际实例</small></div><div><b id="active-count">—</b><small>活跃高斯</small></div><div><b id="source-count">—</b><small>共享源高斯</small></div></div><div class="camera-bar"><button data-camera="overlap" class="selected">总览</button><button data-camera="top">俯视</button><button data-camera="eye">眼高</button><button data-camera="low">低角度</button><button data-camera="near">近景</button></div></div>
<div class="viewer-bottom"><span>拖动旋转 · 右键平移 · 滚轮缩放</span><span id="build-time">等待构建</span></div>
<p id="ground-credit" class="footnote" hidden><a href="https://superspl.at/scene/8f52baf1" target="_blank" rel="noopener noreferrer">Riverside © VeryOS</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> · 连续裁片、SH3量化及整体旋转/缩放 · <a href="/assets/riverside-ground-v1/LICENSE.txt">原始许可</a> · <a href="/assets/riverside-ground-v1/SOURCE.json">素材与修改记录</a></p>
<div class="measurement-panel"><div><p class="eyebrow">03 / 验证记录</p><p id="measurement-summary">测量需要 1280×720、DPR=1，保持前台；Esc 可中止。质量和主机内存需另行核验。</p></div><button id="measure" disabled>60 秒性能测量</button><button id="save-measurement" disabled>保存测量</button></div><pre id="measurement-data" hidden></pre><pre id="scene-evidence" hidden></pre>
</section></div>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id),
  number = (id: string) =>
    input(id).value === "" ? NaN : Number(input(id).value);
const canvas = document.querySelector("canvas")!,
  wrap = document.querySelector(".canvas-wrap")!,
  status = $("status");
let view: GaussianView,
  worker: Worker | null = null,
  requestId = 0,
  result: BuildResult | null = null,
  lost = false,
  renderFailed = false,
  raf = 0,
  lastStats = 0,
  firstReadyMs = 0,
  measuring = false,
  renderDpr = 1;
let planner: ReturnType<typeof mountPlanner> | undefined;
let assetPlanner: ReturnType<typeof mountAssetSelection> | undefined;
let initialLoadRecipe: F0Recipe | null = null;
export const workbench = {
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
  status.dataset.state = kind;
  status.textContent = message;
  input("cancel").disabled = kind !== "building";
  input("measure").disabled = kind !== "ready" || measuring;
}
function publishSceneEvidence() {
  $("scene-evidence").textContent = JSON.stringify({
    recipe: result?.recipe ?? null,
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
  try {
    view?.render();
    return true;
  } catch (e) {
    renderFailed = true;
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
async function waitForDisplayed(id: number) {
  const deadline = performance.now() + 10000;
  do {
    if (id !== requestId || lost || renderFailed) return false;
    if (!renderFrame()) return false;
    if (view.isCurrentSceneDisplayed()) {
      // The accumulator has adopted this exact scene; submit its first frame.
      if (!renderFrame()) return false;
      await new Promise(requestAnimationFrame);
      return id === requestId && !lost && !renderFailed;
    }
    if (performance.now() > deadline) throw new Error("场景显示超时");
    await new Promise(requestAnimationFrame);
  } while (true);
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
  planner?.invalidate("构建与待审规划已取消。");
  assetPlanner?.invalidate("构建与待审规划已取消。");
  requestId++;
  view?.cancelPendingScene();
  worker?.terminate();
  worker = null;
  state("cancelled", result ? "已取消，保留上一版场景。" : "已取消。");
}
async function adopt(next: BuildResult, id: number, imported = false) {
  if (id !== requestId || lost) return;
  if (renderFailed) {
    view.dispose();
    const recovered = await createGaussianView(canvas);
    if (id !== requestId || lost) {
      recovered.dispose();
      return;
    }
    view = recovered;
    view.setInteractive(true);
    view.setBackground(input("contrast").checked ? 0xd91b78 : 0xe9ecdf);
    renderFailed = false;
    resize();
  }
  await view.setScene(next.scene);
  if (id !== requestId || lost) return;
  result = next;
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
  if (!(await waitForDisplayed(id))) return;
  if (!firstReadyMs) {
    firstReadyMs = performance.now();
    initialLoadRecipe = next.recipe;
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
  $("scene-title").textContent = next.scene.ground
    ? "Riverside · 4 × 4 展示范围 · 试用"
    : `${next.recipe.width} × ${next.recipe.depth} m · 湿地样方`;
  $("ground-credit").hidden = !next.scene.ground;
  document.querySelector(".mode-note")!.textContent = next.scene.ground
    ? `${sceneAssetLabel(next.recipe.algorithmVersion)} · 配方来源见规划记录`
    : "手工配方 · 合成高斯资产 · 未接入 LLM";
  $("build-time").textContent =
    `${imported ? "保存的构建记录" : "PCG 构建"} ${next.report.stageMs.total.toFixed(1)} ms`;
  publishSceneEvidence();
  document.dispatchEvent(new CustomEvent("scene-ready"));
  planner?.sceneReady(id, next.recipe);
  assetPlanner?.sceneReady(id, next.recipe);
}
function generate(recipe?: F0Recipe) {
  if (lost) {
    state("context-lost", "图形上下文丢失，等待恢复…");
    return;
  }
  worker?.terminate();
  worker = null;
  const id = ++requestId;
  view?.cancelPendingScene();
  document.dispatchEvent(new CustomEvent("scene-changing"));
  try {
    const selected = recipe ?? readRecipe();
    state("building", `正在构建版本 ${id}…`);
    const current = new Worker(new URL("./build.worker.ts", import.meta.url), {
      type: "module",
    });
    worker = current;
    current.onmessage = async ({ data }) => {
      current.terminate();
      if (worker === current) worker = null;
      if (data.requestId !== requestId) return;
      if (!data.ok) {
        planner?.sceneFailed(id, String(data.error));
        assetPlanner?.sceneFailed(id, String(data.error));
        state("error", `生成失败：${data.error}。上一版仍保留。`);
        return;
      }
      try {
        await adopt(data.result, id);
      } catch (e) {
        if (id === requestId) {
          planner?.sceneFailed(id, String(e), true);
          assetPlanner?.sceneFailed(id, String(e), true);
          state("error", `渲染失败：${String(e)}`);
        }
      }
    };
    current.onerror = (e) => {
      current.terminate();
      if (id === requestId) {
        worker = null;
        planner?.sceneFailed(id, e.message);
        assetPlanner?.sceneFailed(id, e.message);
        state("error", `构建失败：${e.message}`);
      }
    };
    current.postMessage({ requestId: id, recipe: selected });
    return id;
  } catch (e) {
    state("error", `${String(e)}。请修改后重试；画布保留上一版。`);
  }
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
  // Moving between displays or changing zoom can change DPR without changing layout.
  if (view && desiredRenderDpr() !== renderDpr) resize();
  if (!lost && !renderFailed) renderFrame();
  if (view && time - lastStats > 250) {
    const s = view.stats();
    $("instance-count").textContent = String(s.instanceCount);
    $("active-count").textContent = s.activeSplats.toLocaleString();
    $("source-count").textContent = s.uniqueSourceSplats.toLocaleString();
    publishSceneEvidence();
    lastStats = time;
  }
  raf = requestAnimationFrame(tick);
}
$("generate").onclick = () => {
  // Supersede in-flight work even if new controls are invalid, without adding an idle version.
  if (status.dataset.state === "building") cancel();
  void planner?.generateManual().catch((e) => state("error", String(e)));
};
$("cancel").onclick = cancel;
$("clear").onclick = async () => {
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
  if (!result || lost || measuring || status.dataset.state !== "ready") return;
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
      result,
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
  const url = URL.createObjectURL(
      new Blob([$("measurement-data").textContent ?? ""], {
        type: "application/json",
      }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = `wetland-f0-measurement-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
$("import").onclick = () => input("bundle-file").click();
$("save").onclick = async () => {
  if (!result) return;
  try {
    const bytes = packBundle(await encodeBundle(result)),
      url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes).buffer], { type: "application/zip" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = `wetland-f0-${result.recipe.seed}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    state("error", `保存失败：${String(e)}`);
  }
};
input("bundle-file").onchange = async () => {
  const file = input("bundle-file").files?.[0];
  if (!file) return;
  planner?.invalidate("场景包不含规划证据，关联已清除。", true);
  assetPlanner?.invalidate("场景包不含规划证据，关联已清除。", true);
  worker?.terminate();
  worker = null;
  const id = ++requestId;
  view?.cancelPendingScene();
  document.dispatchEvent(new CustomEvent("scene-changing"));
  state("building", "正在校验本地场景包…");
  try {
    if (file.size > 64 * 1024 * 1024) throw new Error("场景包超过64MiB");
    const bundle = unpackBundle(new Uint8Array(await file.arrayBuffer())),
      next = await decodeBundle(bundle.manifest, bundle.files);
    if (id !== requestId) return;
    populate(next.recipe);
    await adopt(next, id, true);
  } catch (e) {
    if (id === requestId)
      state("error", `导入失败：${String(e)}。上一版仍保留。`);
  } finally {
    input("bundle-file").value = "";
  }
};
for (const control of document.querySelectorAll<
  HTMLInputElement | HTMLSelectElement
>(".sidebar input:not([type=file]),.sidebar select"))
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
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-camera]",
))
  button.onclick = () => {
    if (!result) return;
    applyCameraPreset(
      view,
      result.heightfield,
      button.dataset.camera as "top",
      result.recipe.waterLevel,
      result.scene.ground ? 6 : undefined,
    );
    for (const b of document.querySelectorAll("[data-camera]"))
      b.classList.toggle("selected", b === button);
  };
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  lost = true;
  planner?.invalidate("图形上下文丢失，规划关联已清除。", true);
  assetPlanner?.invalidate("图形上下文丢失，规划关联已清除。", true);
  worker?.terminate();
  worker = null;
  requestId++;
  state("context-lost", "图形上下文丢失，等待恢复后重建。");
  document.dispatchEvent(new CustomEvent("scene-changing"));
});
canvas.addEventListener("webglcontextrestored", () => {
  lost = false;
  renderFailed = true;
  generate(result?.recipe ?? defaultRecipe);
});
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(raf);
  worker?.terminate();
  view?.dispose();
});
planner = mountPlanner($("planner"), {
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
assetPlanner = mountAssetSelection($("asset-planner"), {
  beforeApply() {
    planner?.invalidate("选材开始确认，原待审规划已失效。");
  },
  applyRecipe(recipe) {
    populate(recipe);
    return generate(recipe);
  },
});
try {
  view = await createGaussianView(canvas);
  view.setInteractive(true);
  view.setBackground(0xe9ecdf);
  new ResizeObserver(resize).observe(wrap);
  resize();
  raf = requestAnimationFrame(tick);
  populate(
    new URLSearchParams(location.search).get("surface") === "baseline"
      ? defaultRecipe
      : { ...riversideRecipe, algorithmVersion: "f0-riverside-grass-v2" },
  );
  generate();
} catch (e) {
  state("error", `无法启动WebGL：${String(e)}`);
}
