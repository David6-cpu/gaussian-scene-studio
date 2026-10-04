import type {
  BuildResult,
  F0Recipe,
  GaussianView,
  Vec3,
} from "./gaussian/types";
import { evaluateRun, summarizeFrames } from "./measure";

/** Route is time-based; camera guard remains active throughout. */
export function routePosition(seconds: number): Vec3 {
  const t = Math.max(0, Math.min(60, seconds));
  const lerp = (a: Vec3, b: Vec3, f: number): Vec3 => [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
  if (t <= 15) return lerp([0, 12, 0.01], [0, 1.6, 6.5], t / 15);
  if (t <= 35) {
    const a = ((t - 15) / 20) * Math.PI * 2;
    return [6.5 * Math.sin(a), 1.6, 6.5 * Math.cos(a)];
  }
  if (t <= 50) return lerp([0, 1.6, 6.5], [0, 0.5, 1], (t - 35) / 15);
  return lerp([0, 0.5, 1], [6, 4, 7], (t - 50) / 10);
}

export async function measureRoute(
  view: GaussianView,
  canvas: HTMLCanvasElement,
  result: BuildResult,
  loadMs: number,
  initialLoadRecipe: F0Recipe,
) {
  const invalidReasons: string[] = [],
    intervalsMs: number[] = [];
  const samples: {
    elapsedMs: number;
    camera: ReturnType<GaussianView["getCamera"]>;
    stats: ReturnType<GaussianView["stats"]>;
  }[] = [];
  const gpu = view.gpuInfo(),
    startedAtMs = Date.now();
  let hidden = document.hidden || !document.hasFocus(),
    start = 0,
    previous = 0,
    raf = 0,
    finish: () => void = () => {};
  const invalidate = (reason: string) => {
    if (!invalidReasons.includes(reason)) invalidReasons.push(reason);
    finish();
  };
  const onHidden = () => {
      if (document.hidden) {
        hidden = true;
        invalidate("标签页隐藏");
      }
    },
    onBlur = () => {
      hidden = true;
      invalidate("页面失焦");
    },
    onChange = () => invalidate("场景或参数变更"),
    onFailure = () => invalidate("渲染器发生异常"),
    onResize = () => invalidate("测量期间分辨率或DPR变化"),
    onLost = () => invalidate("WebGL上下文丢失"),
    onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") invalidate("用户中止");
    };
  if (hidden) invalidReasons.push("开始时页面不在前台");
  if (JSON.stringify(result.recipe) !== JSON.stringify(initialLoadRecipe))
    invalidReasons.push("加载计时来自其他配方，请重新打开默认场景后测量");
  if (canvas.width !== 1280 || canvas.height !== 720 || devicePixelRatio !== 1)
    invalidReasons.push("要求1280×720与DPR=1");
  if (
    result.recipe.width !== 10 ||
    result.recipe.depth !== 10 ||
    result.recipe.seed !== 20261002
  )
    invalidReasons.push("固定路线要求10×10m和seed=20261002");
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("blur", onBlur);
  document.addEventListener("scene-changing", onChange);
  document.addEventListener("renderer-failed", onFailure);
  window.addEventListener("resize", onResize);
  const resolution = matchMedia("(resolution: 1dppx)");
  resolution.addEventListener("change", onResize);
  canvas.addEventListener("webglcontextlost", onLost);
  window.addEventListener("keydown", onKey);
  view.setInteractive(false);
  try {
    if (!invalidReasons.length)
      await new Promise<void>((resolve) => {
        finish = resolve;
        const step = (now: number) => {
          if (
            canvas.width !== 1280 ||
            canvas.height !== 720 ||
            devicePixelRatio !== 1
          ) {
            onResize();
            return;
          }
          if (!start) start = previous = now;
          else intervalsMs.push(now - previous);
          previous = now;
          const elapsed = now - start;
          view.setCamera(routePosition(elapsed / 1000), [0, 0, 0]);
          if (elapsed >= samples.length * 1000)
            samples.push({
              elapsedMs: elapsed,
              camera: view.getCamera(),
              stats: view.stats(),
            });
          if (elapsed >= 60000) resolve();
          else raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      });
  } finally {
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("scene-changing", onChange);
    document.removeEventListener("renderer-failed", onFailure);
    window.removeEventListener("resize", onResize);
    resolution.removeEventListener("change", onResize);
    canvas.removeEventListener("webglcontextlost", onLost);
    window.removeEventListener("keydown", onKey);
    view.setInteractive(true);
  }
  const frameStats = intervalsMs.length
    ? summarizeFrames(intervalsMs)
    : { medianFps: 0, p95FrameMs: 0 };
  const input = {
    durationMs: start ? previous - start : 0,
    hidden,
    invalidReasons,
    softwareGpu: gpu.software,
    loadMs,
    ...frameStats,
    qualityPassed: null,
    memoryPressureRed: null,
    swapDeltaMiB: null,
  };
  return {
    schemaVersion: 1,
    routeVersion: "f0-route-v1",
    startedAtMs,
    endedAtMs: Date.now(),
    ...input,
    verdict: evaluateRun(input),
    gpu,
    viewport: {
      width: canvas.width,
      height: canvas.height,
      dpr: devicePixelRatio,
    },
    recipe: result.recipe,
    initialLoadRecipe,
    buildReport: result.report,
    intervalsMs,
    samples,
    memoryAccounting: {
      buildCpuBuffersBytes: result.report.cpuBufferBytes,
      ownedSourceAndPackedBytes: view.stats().ownedBytes,
      perAssetLods: result.scene.assets.map((a) => ({
        id: a.id,
        fullCount: a.lods.full.count,
        coarseCount: a.lods.coarse.count,
        fullBytes: a.lods.full.data.byteLength,
        coarseBytes: a.lods.coarse.data.byteLength,
      })),
      sortPairPayloadEstimateBytes:
        Math.max(0, ...samples.map((s) => s.stats.activeSplats)) * 8,
      sortEstimateAssumption:
        "每个活跃高斯一个32位深度键和一个32位索引的理论负载；不含排序副本、对齐、累积纹理、WASM或驱动；不是实际分配。",
      actualGpuBytes: null,
    },
    notes:
      "rAF间隔不是GPU执行时间；质量和主机内存须另行核验。ownedBytes只含明确拥有的CPU源/打包数组；GPU分配未知。",
  };
}
