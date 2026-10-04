import "./style.css";
import { createGaussianView } from "../gaussian/view";
import { makeSyntheticAssets } from "../assets/synthetic";
import {
  decodeSplat,
  orientDiagnostic,
  orientGround,
  removeLargeGroundSplats,
} from "./splat";
import { readExactAsset } from "./load";
import type { GaussianView, Vec3 } from "../gaussian/types";

const source = {
  title: "Houseplant",
  author: "Marcel Padilla",
  license: "CC-BY-4.0",
  commit: "c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411",
  sha256: "ce9d490b18f16d6730d832227bf541431b8b1a5d167c5a3fe89af4f324c0d8fd",
  bytes: 3636736,
  count: 113648,
};
const rockSource = {
  title: "Rock — continuous surface crop",
  author: "Loop CE",
  license: "CC-BY-4.0",
  commit: "f8c5eeae5ff5410dc537a27762c8927ba2fd29a2",
  sha256: "f3eec340ceae43a6bae8ad60294f5863b90fe78606c81f88ceb7c645df7b967c",
  bytes: 6312032,
  count: 197251,
  sourceCount: 7339238,
  sourceSha256:
    "c6999cae22a6da0ccac6a8964af04d4d219266aac075930769557ab13d3603a2",
};
document.querySelector("#diagnostic")!.innerHTML = `
<header><div><p class="eyebrow">F0 / ASSET CLARITY CHECK</p><h1>单资产清晰度诊断</h1></div><a href="/">返回湿地基线 ↗</a></header>
<div class="controls">
<label>对照素材<select id="asset-mode"><option value="capture">Houseplant · 外部实拍重建</option><option value="synthetic">F0 植株 · 程序合成</option><option value="rock">Rock · 真实岩面局部</option></select></label>
<label id="ground-cleanup-label" hidden>岩面清理<select id="ground-cleanup"><option value="off">原始裁片</option><option value="large">剔除超大基元（候选）</option></select></label>
<label>渲染分辨率<select id="pixel-ratio"><option value="native">跟随屏幕（最高 2×）</option><option value="1">固定 DPR 1</option><option value="2">固定 DPR 2</option></select></label>
<label>中性背景<select id="background"><option value="dark">深灰</option><option value="light">浅灰</option></select></label>
<div class="views"><button data-preset="whole">整株</button><button data-preset="close">叶片近景</button><button data-preset="top" hidden>俯视</button><button data-preset="low" hidden>低角度</button><button id="orbit" aria-pressed="false">缓慢环绕</button></div></div>
<section id="stage"><canvas aria-label="单资产高斯诊断画面"></canvas><div class="caption"><b id="asset-label">正在加载</b><span id="render-label"></span></div><div class="stage-credit">Houseplant © Marcel Padilla · CC BY 4.0 · 朝向与展示尺度已调整</div></section>
<div class="readout"><span id="diagnostic-status" role="status" data-state="loading">准备同一 Spark 渲染器…</span><button id="retry">重新加载</button><span id="counts"></span></div>
<footer><p id="attribution">实拍素材：<a href="https://github.com/marcelpadilla/splats/blob/${source.commit}/data/plant/meta.json">Houseplant — Marcel Padilla</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · <a href="/diagnostics/houseplant/ATTRIBUTION.md">来源与改动记录</a>。室内盆栽，不是湿地植物或本项目自采。</p><p id="limitations">一次只显示一个对象。保持原始密度、颜色与透明度；仅修正朝向和展示尺度。无雾、无重着色、无稀疏化。无 SH 视角相关光照；展示单位不代表米。拖动旋转，滚轮缩放。</p></footer>
<pre id="diagnostic-evidence" hidden></pre>`;
const el = (id: string) => document.getElementById(id)!,
  select = (id: string) => el(id) as HTMLSelectElement,
  status = el("diagnostic-status"),
  canvas = document.querySelector("canvas")!,
  stage = el("stage");
const plantAttribution = el("attribution").innerHTML,
  plantLimitations = el("limitations").textContent!;
if (new URLSearchParams(location.search).get("asset") === "rock")
  select("asset-mode").value = "rock";
if (new URLSearchParams(location.search).get("cleanup") === "large")
  select("ground-cleanup").value = "large";
let view: GaussianView,
  version = 0,
  frame = 0,
  lastEvidence = 0,
  renderDpr = 1,
  orbitStarted: number | null = null,
  loadedMode: string | null = null,
  loadEvidence: Record<string, unknown> | null = null,
  failed = false;
function desiredDpr() {
  return select("pixel-ratio").value === "native"
    ? Math.min(2, Math.max(1, devicePixelRatio || 1))
    : Number(select("pixel-ratio").value);
}
function resize() {
  renderDpr = desiredDpr();
  view?.resize(
    Math.max(1, stage.clientWidth),
    Math.max(1, stage.clientHeight),
    renderDpr,
  );
}
function orbitOff() {
  orbitStarted = null;
  el("orbit").setAttribute("aria-pressed", "false");
  view?.setInteractive(true);
}
const presets: Record<string, { position: Vec3; target: Vec3 }> = {
  whole: { position: [1.0, 0.78, 1.35], target: [0, 0.5, 0] },
  close: { position: [0.38, 0.72, 0.7], target: [0, 0.67, 0] },
};
const groundPresets: typeof presets = {
  whole: { position: [0.7, 0.85, 1.1], target: [0, 0.25, 0] },
  close: { position: [0.02, 0.55, 0.55], target: [0, 0.25, 0] },
  top: { position: [0, 1.5, 0.0001], target: [0, 0.25, 0] },
  low: { position: [0, 0.38, 1.1], target: [0, 0.25, 0] },
};
function preset(name: string) {
  orbitOff();
  const p = (select("asset-mode").value === "rock" ? groundPresets : presets)[
    name
  ];
  if (!p) return;
  view.setCamera(p.position, p.target);
}
function evidence() {
  const stats = view.stats();
  el("diagnostic-evidence").textContent = JSON.stringify({
    mode: loadedMode,
    objectCount: loadedMode ? 1 : 0,
    stats,
    source:
      loadedMode === "rock"
        ? rockSource
        : loadedMode === "capture"
          ? source
          : null,
    load: loadEvidence,
    camera: view.getCamera(),
    gpu: view.gpuInfo(),
    viewport: { width: canvas.width, height: canvas.height },
    renderDpr,
    deviceDpr: devicePixelRatio,
    appearance: {
      density:
        loadedMode === "rock"
          ? loadEvidence?.cleanup
            ? "original crop minus extreme-size records"
            : "original within crop"
          : "original",
      recolor: false,
      fog: false,
      shDegree: 0,
      lod: false,
    },
  });
  el("counts").textContent =
    `${loadedMode ? 1 : 0} 个对象 · ${stats.activeSplats.toLocaleString()} 活跃高斯 · ${stats.uniqueSourceSplats.toLocaleString()} 源高斯`;
  el("render-label").textContent =
    `${canvas.width} × ${canvas.height} px · DPR ${renderDpr} · 同一 Spark 渲染链`;
}
function tick(now: number) {
  if (!failed) {
    if (desiredDpr() !== renderDpr) resize();
    if (orbitStarted !== null) {
      const a = ((now - orbitStarted) / 12000) * Math.PI * 2;
      view.setCamera(
        [1.25 * Math.sin(a), 0.7 + 0.08 * Math.sin(a * 2), 1.25 * Math.cos(a)],
        loadedMode === "rock" ? [0, 0.25, 0] : [0, 0.52, 0],
      );
    }
    try {
      view.render();
    } catch (e) {
      failed = true;
      status.dataset.state = "error";
      status.textContent = `渲染停止：${String(e)}。请刷新页面。`;
    }
  }
  if (now - lastEvidence > 100) {
    evidence();
    lastEvidence = now;
  }
  frame = requestAnimationFrame(tick);
}
async function load() {
  const ticket = ++version,
    mode = select("asset-mode").value,
    cleanup = mode === "rock" && select("ground-cleanup").value === "large",
    start = performance.now();
  el("ground-cleanup-label").hidden = mode !== "rock";
  orbitOff();
  status.dataset.state = "loading";
  status.dataset.mode = "";
  status.textContent = "加载并验证素材…";
  loadedMode = null;
  loadEvidence = null;
  view.clearScene();
  try {
    let buffer,
      fetchMs = 0,
      decodeMs = 0;
    if (mode === "capture" || mode === "rock") {
      const selectedSource = mode === "rock" ? rockSource : source;
      const response = await fetch(
        mode === "rock"
          ? "/diagnostics/loopce-rock/rock-patch.splat"
          : "/diagnostics/houseplant/plant.splat",
      );
      if (!response.ok) throw new Error(`素材读取失败 HTTP ${response.status}`);
      const bytes = await readExactAsset(response, selectedSource.bytes);
      if (bytes.length !== selectedSource.bytes)
        throw new Error("素材长度不匹配");
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== selectedSource.sha256)
        throw new Error("素材 SHA-256 校验失败");
      fetchMs = performance.now() - start;
      const t = performance.now();
      buffer = decodeSplat(bytes);
      decodeMs = performance.now() - t;
    } else
      buffer = makeSyntheticAssets().find((a) => a.id === "reed")!.lods.full;
    if (ticket !== version) return;
    const oriented =
      mode === "rock"
        ? orientGround(buffer, [1, 0, 0, 0])
        : orientDiagnostic(buffer, mode === "capture" ? "-y" : "+y");
    const uploadStart = performance.now();
    const cleaned = cleanup
      ? removeLargeGroundSplats(oriented.buffer, 0.08)
      : null;
    // Static Gaussian buffer slot only; no F0 recipe, asset inventory or bundle importer is involved.
    await view.setScene({
      terrain: cleaned?.buffer ?? oriented.buffer,
      water: null,
      assets: [],
      instances: [],
    });
    if (ticket !== version) return;
    view.setLodEnabled(false);
    preset("whole");
    const deadline = performance.now() + 10000;
    while (!view.isCurrentSceneDisplayed()) {
      if (ticket !== version) return;
      if (failed || performance.now() > deadline)
        throw new Error("素材显示超时");
      await new Promise(requestAnimationFrame);
    }
    view.render();
    await new Promise(requestAnimationFrame);
    if (ticket !== version) return;
    loadedMode = mode;
    loadEvidence = {
      fetchAndHashMs: fetchMs,
      decodeMs,
      uploadAndDisplayMs: performance.now() - uploadStart,
      totalMs: performance.now() - start,
      cleanup: cleaned
        ? {
            rule: "maxSigmaDisplay > 0.08",
            removedCount: cleaned.removedIndices.length,
            retainedCount: cleaned.buffer.count,
            referenceTransform: "original crop; not refitted",
          }
        : null,
      transform: {
        sourceUp: mode === "synthetic" ? "+Y" : "-Y (display orientation)",
        uniformScale: oriented.scale,
        orientedOrigin: oriented.center,
        ...(mode === "rock"
          ? {
              displayFootprint: 1,
              rotationXYZW: [1, 0, 0, 0],
              flattened: false,
            }
          : { displayHeight: 1 }),
        units: "non-metric display units",
      },
    };
    el("asset-label").textContent =
      mode === "rock"
        ? cleanup
          ? "Loop CE Rock · 清理候选 · 197,205 高斯"
          : "Loop CE Rock · 真实岩面局部 · 197,251 高斯"
        : mode === "capture"
          ? "Houseplant · 外部实拍重建 · 113,648 高斯"
          : "F0 植株 · 程序合成 · 4,096 高斯";
    document.querySelector<HTMLElement>(".stage-credit")!.textContent =
      mode === "rock"
        ? cleanup
          ? "Rock © Loop CE · CC BY 4.0 · 局部裁剪 / 剔除46个超大基元 / 展示变换"
          : "Rock © Loop CE · CC BY 4.0 · 连续局部裁剪 / 展示变换"
        : mode === "capture"
          ? "Houseplant © Marcel Padilla · CC BY 4.0 · 朝向与展示尺度已调整"
          : "程序合成对照 · 本项目 F0 原型 · 非实拍资产";
    document.querySelector('[data-preset="whole"]')!.textContent =
      mode === "rock" ? "局部全貌" : "整株";
    document.querySelector('[data-preset="close"]')!.textContent =
      mode === "rock" ? "岩面近景" : "叶片近景";
    (document.querySelector('[data-preset="top"]') as HTMLElement).hidden =
      mode !== "rock";
    (document.querySelector('[data-preset="low"]') as HTMLElement).hidden =
      mode !== "rock";
    el("attribution").innerHTML =
      mode === "rock"
        ? '实拍素材：<a href="https://loopce.com/gaussian-splats">Rock — Loop CE</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · <a href="/diagnostics/loopce-rock/ATTRIBUTION.md">来源与裁剪记录</a> · <a href="/diagnostics/loopce-rock/reference-0001.png">作者原照片</a>。外部岩面，不是湿地泥土或本项目自采。'
        : plantAttribution;
    el("limitations").textContent =
      mode === "rock"
        ? (cleanup
            ? "候选按原展示尺度剔除最大sigma>0.08的46条记录；保留记录与原变换不变。外围色块减少，但毛刺仍在，表面颜色也会变化；不是无损清理。"
            : "一次只显示岩面裁片：全景保留2.69%的基元，局部记录原样保留，无随机抽稀、重着色或表面压平。") +
          "作者SPLAT导出无SH，已包含现场光照；展示单位不代表米。裁剪边缘和近景可能有重建痕迹，不代表整片湿地已达标。"
        : plantLimitations;
    evidence();
    status.textContent = `已显示 · ${(performance.now() - start).toFixed(0)} ms · 仅供清晰度诊断`;
    status.dataset.mode = mode;
    status.dataset.state = "ready";
  } catch (e) {
    if (ticket === version) {
      status.dataset.state = "error";
      status.textContent = String(e);
    }
  }
}
select("asset-mode").onchange = () => void load();
select("ground-cleanup").onchange = () => void load();
select("pixel-ratio").onchange = () => {
  resize();
  evidence();
};
select("background").onchange = () =>
  view.setBackground(
    select("background").value === "dark" ? 0x30343b : 0xe2e4e7,
  );
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-preset]",
))
  button.onclick = () => preset(button.dataset.preset!);
el("orbit").onclick = () => {
  if (!loadedMode) return;
  if (orbitStarted !== null) orbitOff();
  else {
    orbitStarted = performance.now();
    view.setInteractive(false);
    el("orbit").setAttribute("aria-pressed", "true");
  }
};
el("retry").onclick = () => void load();
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(frame);
  view?.dispose();
});
try {
  view = await createGaussianView(canvas);
  view.setBackground(0x30343b);
  view.setInteractive(true);
  new ResizeObserver(resize).observe(stage);
  resize();
  frame = requestAnimationFrame(tick);
  await load();
} catch (e) {
  status.dataset.state = "error";
  status.textContent = String(e);
}
