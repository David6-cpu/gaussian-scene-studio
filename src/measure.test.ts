import { test, expect } from "vitest";
import {
  summarizeFrames,
  evaluateRun,
  evaluateMemoryWindow,
  type RunInput,
} from "./measure";
const valid: RunInput = {
  durationMs: 60000,
  hidden: false,
  invalidReasons: [],
  softwareGpu: false,
  loadMs: 10000,
  medianFps: 30,
  p95FrameMs: 50,
  qualityPassed: true,
  memoryPressureRed: false,
  swapDeltaMiB: 512,
};
test("60 one-second windows produce median FPS independently from frame p95", () => {
  const s = summarizeFrames(Array(3600).fill(1000 / 60));
  expect(s.medianFps).toBe(60);
  expect(s.p95FrameMs).toBeCloseTo(1000 / 60);
  const spikes = Array.from({ length: 3600 }, (_, i) =>
    i % 10 === 0 ? 100 : 16,
  );
  expect(summarizeFrames(spikes).p95FrameMs).toBe(100);
});
test("nonfinite and nonpositive frame intervals are rejected", () => {
  for (const v of [NaN, Infinity, 0, -1])
    expect(() => summarizeFrames([v])).toThrow();
});
test("exact valid boundaries pass", () =>
  expect(evaluateRun(valid).status).toBe("pass"));
test.each([
  { hidden: true },
  { durationMs: 59999 },
  { softwareGpu: true },
  { softwareGpu: null },
  { qualityPassed: null },
  { memoryPressureRed: null },
  { swapDeltaMiB: null },
  { invalidReasons: ["context lost"] },
  { medianFps: NaN },
])("incomplete evidence %j never passes", (patch) =>
  expect(evaluateRun({ ...valid, ...patch }).status).toBe("incomplete"),
);
test("host memory evidence must bracket the entire browser route, with peak swap retained", () => {
  const samples = Array.from({ length: 64 }, (_, i) => ({
    timestamp: new Date(100000 + i * 1000).toISOString(),
    pressure: "warning" as const,
    swapUsedMiB: i === 30 ? 700 : 400,
  }));
  expect(evaluateMemoryWindow(samples, 100100, 160200)).toEqual({
    memoryPressureRed: false,
    swapDeltaMiB: 300,
    reasons: [],
  });
  const late = evaluateMemoryWindow(samples, 99999, 160200);
  expect(late.memoryPressureRed).toBeNull();
  expect(late.reasons.length).toBeGreaterThan(0);
  expect(evaluateMemoryWindow(samples, 100100, 164000).swapDeltaMiB).toBeNull();
  expect(
    evaluateMemoryWindow(
      samples.filter((_, i) => i !== 30),
      100100,
      160200,
    ).memoryPressureRed,
  ).toBeNull();
  expect(
    evaluateMemoryWindow(
      [{ ...samples[0], pressure: null }, ...samples.slice(1)],
      100100,
      160200,
    ).memoryPressureRed,
  ).toBeNull();
  expect(
    evaluateMemoryWindow(
      samples.map((s, i) =>
        i === 10 ? { ...s, pressure: "critical" as const } : s,
      ),
      100100,
      160200,
    ).memoryPressureRed,
  ).toBe(true);
});
test.each([
  { qualityPassed: false },
  { memoryPressureRed: true },
  { swapDeltaMiB: 512.1 },
  { loadMs: 10001 },
  { medianFps: 29 },
  { p95FrameMs: 51 },
])(
  "valid measurements failing criterion %j are not hidden by other successes",
  (patch) => expect(evaluateRun({ ...valid, ...patch }).status).toBe("fail"),
);
