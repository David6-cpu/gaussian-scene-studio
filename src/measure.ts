export interface RunInput {
  durationMs: number;
  hidden: boolean;
  invalidReasons: string[];
  softwareGpu: boolean | null;
  loadMs: number;
  medianFps: number;
  p95FrameMs: number;
  qualityPassed: boolean | null;
  memoryPressureRed: boolean | null;
  swapDeltaMiB: number | null;
}
export function evaluateMemoryWindow(
  samples: {
    timestamp: string;
    pressure: "normal" | "warning" | "critical" | null;
    swapUsedMiB: number | null;
  }[],
  startedAtMs: number,
  endedAtMs: number,
): {
  memoryPressureRed: boolean | null;
  swapDeltaMiB: number | null;
  reasons: string[];
} {
  const times = samples.map((s) => Date.parse(s.timestamp));
  const valid =
    samples.length >= 2 &&
    Number.isFinite(startedAtMs) &&
    Number.isFinite(endedAtMs) &&
    endedAtMs > startedAtMs &&
    times.every(
      (t, i) =>
        Number.isFinite(t) &&
        (i === 0 || (t > times[i - 1] && t - times[i - 1] <= 1500)),
    ) &&
    times[0] <= startedAtMs &&
    times[times.length - 1] >= endedAtMs &&
    samples.every(
      (s) =>
        ["normal", "warning", "critical"].includes(s.pressure ?? "") &&
        s.swapUsedMiB !== null &&
        Number.isFinite(s.swapUsedMiB) &&
        s.swapUsedMiB >= 0,
    );
  if (!valid)
    return {
      memoryPressureRed: null,
      swapDeltaMiB: null,
      reasons: ["内存采样缺失、间隔过长或未覆盖完整路线"],
    };
  return {
    memoryPressureRed: samples.some((s) => s.pressure === "critical"),
    swapDeltaMiB:
      Math.max(...samples.map((s) => s.swapUsedMiB!)) - samples[0].swapUsedMiB!,
    reasons: [],
  };
}
export function summarizeFrames(intervalsMs: number[]): {
  medianFps: number;
  p95FrameMs: number;
} {
  if (
    !intervalsMs.length ||
    intervalsMs.some((x) => !Number.isFinite(x) || x <= 0)
  )
    throw new Error("Invalid frame interval");
  const bins = Array<number>(60).fill(0);
  let elapsed = 0;
  for (const dt of intervalsMs) {
    elapsed += dt;
    const index = Math.floor((elapsed - 1e-6) / 1000);
    if (index >= 0 && index < 60) bins[index]++;
  }
  const sorted = [...intervalsMs].sort((a, b) => a - b),
    fps = bins.sort((a, b) => a - b);
  return {
    medianFps: (fps[29] + fps[30]) / 2,
    p95FrameMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
export function evaluateRun(i: RunInput): {
  status: "pass" | "fail" | "incomplete";
  reasons: string[];
} {
  const reasons = [...i.invalidReasons];
  if (i.hidden) reasons.push("标签页隐藏或失焦");
  if (i.durationMs < 60000) reasons.push("未完成60秒");
  if (i.softwareGpu === true) reasons.push("软件渲染");
  if (i.softwareGpu === null) reasons.push("缺少GPU证据");
  if (
    [i.durationMs, i.loadMs, i.medianFps, i.p95FrameMs].some(
      (n) => !Number.isFinite(n) || n < 0,
    ) ||
    (i.swapDeltaMiB !== null && !Number.isFinite(i.swapDeltaMiB))
  )
    reasons.push("无效测量值");
  if (reasons.length) return { status: "incomplete", reasons };
  if (i.loadMs > 10000) reasons.push("加载超过10秒");
  if (i.medianFps < 30) reasons.push("中位帧率低于30");
  if (i.p95FrameMs > 50) reasons.push("p95帧间隔超过50ms");
  if (i.qualityPassed === false) reasons.push("质量未通过");
  if (i.memoryPressureRed === true) reasons.push("系统压力达到critical");
  if (i.swapDeltaMiB !== null && i.swapDeltaMiB > 512)
    reasons.push("swap增量超过512MiB");
  if (reasons.length) return { status: "fail", reasons };
  if (i.qualityPassed === null) reasons.push("待人工质量审查");
  if (i.memoryPressureRed === null || i.swapDeltaMiB === null)
    reasons.push("待主机内存观测");
  return { status: reasons.length ? "incomplete" : "pass", reasons };
}
