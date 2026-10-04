import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { sampleMemory } from "../../scripts/observe-memory.mjs";
import { evaluateRun, evaluateMemoryWindow } from "../../src/measure";
const exec = promisify(execFile);
const phase = process.env.BENCH_PHASE ?? "performance";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const directory = `.local/measurements/${phase}-${stamp}`;
const save = (name: string, data: unknown) =>
  writeFile(`${directory}/${name}`, JSON.stringify(data, null, 2));
const evidence = async (page: Page) =>
  JSON.parse((await page.locator("#scene-evidence").textContent())!);
async function ready(page: Page) {
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready", {
    timeout: 15000,
  });
}
async function generate(page: Page, values: Record<string, number | boolean>) {
  if ((await page.locator("details").getAttribute("open")) === null)
    await page.locator("summary").click();
  for (const [key, value] of Object.entries(values)) {
    const el = page.locator(`#${key}`);
    if (typeof value === "boolean") await el.setChecked(value);
    else if (await el.evaluate((n) => n.tagName === "SELECT"))
      await el.selectOption(String(value));
    else await el.fill(String(value));
  }
  await page.locator("#generate").click();
  await ready(page);
}
test(`F0 headed ${phase} evidence`, async ({ page, browser }, testInfo) => {
  test.skip(phase === "lod");
  test.setTimeout(240000);
  if (!["quality", "reload", "performance", "video"].includes(phase))
    throw new Error("Unknown BENCH_PHASE");
  await mkdir(directory, { recursive: true });
  const cdp = await browser.newBrowserCDPSession();
  const git = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  let llmCheck: { code: number; stdout: string; error?: string };
  try {
    llmCheck = {
      code: 0,
      stdout: (
        await exec("/usr/bin/pgrep", ["-il", "ollama|llama-server|mlx_lm"])
      ).stdout,
    };
  } catch (e: any) {
    llmCheck = {
      code: typeof e.code === "number" ? e.code : -1,
      stdout: e.stdout ?? "",
      error: e.code === 1 ? undefined : String(e),
    };
  }
  await page.goto("/?surface=baseline");
  await page.bringToFront();
  await ready(page);
  // Navigation may replace Chrome's renderer process; sample the page's live set.
  const processes = (await cdp.send("SystemInfo.getProcessInfo")).processInfo;
  const pids = processes.map((p) => p.id);
  const environment = {
    git,
    dirty: (await exec("git", ["status", "--short"])).stdout,
    browser: browser.version(),
    headed: true,
    project: testInfo.project.name,
    processes,
    llmCheck,
    package: JSON.parse(await readFile("package.json", "utf8")),
    initialScene: await evidence(page),
    browserEnvironment: await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      dpr: devicePixelRatio,
      focused: document.hasFocus(),
      hidden: document.hidden,
      viewport: [innerWidth, innerHeight],
      firstReadyMs: Number(
        document.getElementById("status")!.dataset.firstReadyMs,
      ),
    })),
  };
  await save("environment.json", environment);
  if (phase === "quality" || phase === "reload") {
    const configs = [
      ...[0.1, 0.2, 0.4].map((spacing) => ({
        name: `spacing-${spacing}`,
        values: {
          spacing,
          tangentFactor: 0.75,
          normalFactor: 0.1,
          opacity: 0.95,
        },
      })),
      ...[0.5, 0.75, 1].map((tangentFactor) => ({
        name: `tangent-${tangentFactor}`,
        values: {
          spacing: 0.2,
          tangentFactor,
          normalFactor: 0.1,
          opacity: 0.95,
        },
      })),
      ...[0.05, 0.1].map((normalFactor) => ({
        name: `normal-${normalFactor}`,
        values: {
          spacing: 0.2,
          tangentFactor: 0.75,
          normalFactor,
          opacity: 0.95,
        },
      })),
      ...[0.8, 0.95].map((opacity) => ({
        name: `opacity-${opacity}`,
        values: {
          spacing: 0.2,
          tangentFactor: 0.75,
          normalFactor: 0.1,
          opacity,
        },
      })),
    ];
    const comparisons: unknown[] = [];
    for (const config of phase === "quality" ? configs : []) {
      await generate(page, config.values);
      const frames: unknown[] = [];
      for (const preset of ["top", "eye", "low", "near", "overlap"]) {
        await page.locator(`[data-camera=${preset}]`).click();
        await page.evaluate(() => document.body.classList.add("benchmark"));
        await page.waitForTimeout(350);
        await page
          .locator("canvas")
          .screenshot({ path: `${directory}/${config.name}-${preset}.png` });
        frames.push({ preset, ...(await evidence(page)) });
        await page.evaluate(() => document.body.classList.remove("benchmark"));
      }
      comparisons.push({ ...config, frames });
      await save("quality-comparisons.json", comparisons);
    }
    await generate(page, {
      spacing: 0.2,
      tangentFactor: 0.75,
      normalFactor: 0.1,
      opacity: 0.95,
    });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#save").click(),
    ]);
    await download.saveAs(`${directory}/candidate.zip`);
    const baseline = await evidence(page),
      cycles: unknown[] = [];
    for (let i = 1; i <= 3; i++) {
      const before = await sampleMemory(pids);
      await page.locator("#clear").click();
      await expect(page.locator("#status")).toHaveAttribute(
        "data-state",
        "empty",
      );
      const cleared = await evidence(page);
      expect(cleared.stats.sourceBuffers).toBe(0);
      expect(cleared.stats.ownedBytes).toBe(0);
      await page
        .locator("#bundle-file")
        .setInputFiles(`${directory}/candidate.zip`);
      await ready(page);
      const restored = await evidence(page);
      expect(restored.stats).toEqual(baseline.stats);
      cycles.push({
        cycle: i,
        before,
        cleared,
        restored,
        after: await sampleMemory(pids),
      });
      await save("reload-cycles.json", { baseline, cycles });
    }
    const growth: unknown[] = [];
    for (const count of [1, 5, 20]) {
      await page.goto(`/tests/harness.html?assets=1&count=${count}`);
      await expect
        .poll(() => page.evaluate(() => window.ready ?? window.failure))
        .toBe(true);
      for (const lod of [false, true]) {
        await page.evaluate((enabled) => {
          window.testView.setLodEnabled(enabled);
          window.testView.setCamera([0, 40, 75], [0, 0, 0]);
        }, lod);
        await page.waitForTimeout(250);
        const stats = await page.evaluate(() => window.testView.stats());
        expect(stats.instanceCount).toBe(count);
        growth.push({ count, lod, stats });
      }
    }
    await save("instance-lod-growth.json", growth);
  } else {
    let recorderStarted = false;
    if (phase === "video") {
      await page.evaluate(() => document.body.classList.add("benchmark"));
      await expect
        .poll(() =>
          page.evaluate(() => document.querySelector("canvas")!.width),
        )
        .toBe(1280);
      await page.evaluate(() => {
        const stream = document.querySelector("canvas")!.captureStream(30);
        const recorder = new MediaRecorder(stream, {
          mimeType: "video/webm;codecs=vp8",
          videoBitsPerSecond: 5_000_000,
        });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          const a = document.createElement("a");
          const url = URL.createObjectURL(
            new Blob(chunks, { type: "video/webm" }),
          );
          a.href = url;
          a.download = "f0-route.webm";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        };
        (window as any).stopF0Recording = () => recorder.stop();
        recorder.start(1000);
      });
      recorderStarted = true;
    }
    const observer = spawn(
      process.execPath,
      [
        "scripts/observe-memory.mjs",
        "--seconds",
        "63",
        "--output",
        `${directory}/memory.json`,
        "--pids",
        pids.join(","),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let observerLog = "";
    observer.stdout.on("data", (s) => (observerLog += s));
    observer.stderr.on("data", (s) => (observerLog += s));
    const observerDone = new Promise<number | null>((resolve, reject) => {
      observer.once("error", reject);
      observer.once("close", resolve);
    });
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(
              await readFile(`${directory}/memory.json`, "utf8"),
            ).samples.length;
          } catch {
            return 0;
          }
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
    if (recorderStarted)
      await page
        .locator("#measure")
        .evaluate((button: HTMLButtonElement) => button.click());
    else await page.locator("#measure").click();
    await expect(page.locator("#measurement-data")).toHaveAttribute(
      "data-state",
      "complete",
      { timeout: 75000 },
    );
    const report = JSON.parse(
      (await page.locator("#measurement-data").textContent())!,
    );
    await save("browser.json", report);
    await writeFile(
      `${directory}/frames.csv`,
      "index,interval_ms\n" +
        report.intervalsMs
          .map((v: number, i: number) => `${i},${v}`)
          .join("\n") +
        "\n",
    );
    if (recorderStarted) {
      const [video] = await Promise.all([
        page.waitForEvent("download"),
        page.evaluate(() => (window as any).stopF0Recording()),
      ]);
      await video.saveAs(`${directory}/f0-route.webm`);
    }
    const code = await observerDone;
    await writeFile(`${directory}/observer.log`, observerLog);
    const memory = JSON.parse(
      await readFile(`${directory}/memory.json`, "utf8"),
    );
    const samples = memory.samples;
    const first = samples[0],
      last = samples.at(-1);
    const memoryVerdict = evaluateMemoryWindow(
      samples,
      report.startedAtMs,
      report.endedAtMs,
    );
    const input = {
      ...report,
      invalidReasons: [
        ...report.invalidReasons,
        ...(llmCheck.code === 1 ? [] : ["无法确认LLM未驻留"]),
        ...(phase === "video" ? ["录屏运行不用于性能验收"] : []),
        ...memoryVerdict.reasons,
        ...(code === 0 && memory.completed ? [] : ["主机采样器未完整结束"]),
      ],
      memoryPressureRed: memoryVerdict.memoryPressureRed,
      swapDeltaMiB: memoryVerdict.swapDeltaMiB,
    };
    await save("combined.json", {
      ...input,
      verdict: evaluateRun(input),
      memoryWindow: {
        first: first.timestamp,
        last: last.timestamp,
        samples: samples.length,
        peakSwapMiB: Math.max(...samples.map((s: any) => s.swapUsedMiB ?? NaN)),
        notes:
          "保守使用覆盖路线的63秒窗口峰值增量，另保留每秒原始观测；RSS不相加。",
      },
      recording: recorderStarted,
    });
    await page.screenshot({ path: `${directory}/workbench-result.png` });
    console.log(
      JSON.stringify({
        directory,
        durationMs: report.durationMs,
        loadMs: report.loadMs,
        medianFps: report.medianFps,
        p95FrameMs: report.p95FrameMs,
        invalidReasons: input.invalidReasons,
      }),
    );
  }
  await writeFile(`.local/measurements/latest-${phase}.txt`, directory + "\n");
  console.log(`Evidence: ${directory}`);
});
test("Gaussian LOD near/far transition recording", async ({ page }) => {
  test.skip(phase !== "lod");
  test.setTimeout(30000);
  await mkdir(directory, { recursive: true });
  await page.goto("/tests/harness.html?assets=1&count=20");
  await page.bringToFront();
  await expect
    .poll(() => page.evaluate(() => window.ready ?? window.failure))
    .toBe(true);
  await page.evaluate(() => window.testView.setCamera([0, 3, 8], [0, 0, 0]));
  await page.waitForTimeout(300);
  const [download, route] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(async () => {
      const stream = document.querySelector("canvas")!.captureStream(30),
        recorder = new MediaRecorder(stream, {
          mimeType: "video/webm;codecs=vp8",
          videoBitsPerSecond: 5_000_000,
        }),
        chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise<void>(
        (resolve) =>
          (recorder.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            const a = document.createElement("a"),
              url = URL.createObjectURL(
                new Blob(chunks, { type: "video/webm" }),
              );
            a.href = url;
            a.download = "f0-lod.webm";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            resolve();
          }),
      );
      const samples: {
          elapsedMs: number;
          active: number;
          camera: ReturnType<typeof window.testView.getCamera>;
        }[] = [],
        invalidReasons: string[] = [];
      const changed = () => invalidReasons.push("失焦或隐藏");
      window.addEventListener("blur", changed);
      document.addEventListener("visibilitychange", changed);
      if (!document.hasFocus() || document.hidden)
        invalidReasons.push("开始时不在前台");
      recorder.start(1000);
      let start = 0;
      await new Promise<void>((resolve) => {
        const step = (now: number) => {
          if (!start) start = now;
          const t = now - start,
            f = (1 - Math.cos(2 * Math.PI * Math.min(1, t / 12000))) / 2;
          window.testView.setCamera([0, 3 + 40 * f, 8 + 67 * f], [0, 0, 0]);
          samples.push({
            elapsedMs: t,
            active: window.testView.stats().activeSplats,
            camera: window.testView.getCamera(),
          });
          if (t >= 12000) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      recorder.stop();
      await stopped;
      window.removeEventListener("blur", changed);
      document.removeEventListener("visibilitychange", changed);
      return {
        samples,
        invalidReasons,
        gpu: window.testView.gpuInfo(),
        finalStats: window.testView.stats(),
        performanceAcceptance: false,
      };
    }),
  ]);
  await download.saveAs(`${directory}/f0-lod.webm`);
  await save("lod-route.json", route);
  expect(route.invalidReasons).toEqual([]);
  expect(Math.min(...route.samples.map((s) => s.active))).toBe(23683);
  expect(Math.max(...route.samples.map((s) => s.active))).toBe(85123);
  expect(route.finalStats.sourceBuffers).toBe(6);
  await writeFile(".local/measurements/latest-lod.txt", directory + "\n");
  console.log(`Evidence: ${directory}`);
});
