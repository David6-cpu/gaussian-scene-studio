import { test, expect } from "@playwright/test";
test("shoreline candidate is opt-in and survives save, baseline switch and import", async ({
  page,
}) => {
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#algorithmVersion")).toHaveValue("f0-v1");
  const evidence = async () =>
    JSON.parse((await page.locator("#scene-evidence").textContent())!);
  expect((await evidence()).buildReport.activeSplats).toBe(85123);
  await page.locator("#algorithmVersion").selectOption("f0-shore-v2");
  await page.locator("#generate").click();
  await expect
    .poll(async () => (await evidence()).recipe.algorithmVersion)
    .toBe("f0-shore-v2");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  expect((await evidence()).buildReport.activeSplats).toBe(95319);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#save").click(),
  ]);
  await page.locator("#algorithmVersion").selectOption("f0-v1");
  await page.locator("#generate").click();
  await expect
    .poll(async () => (await evidence()).recipe.algorithmVersion)
    .toBe("f0-v1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  expect((await evidence()).buildReport.activeSplats).toBe(85123);
  await page.locator("#bundle-file").setInputFiles((await download.path())!);
  await expect(page.locator("#status")).toContainText("已导入");
  await expect(page.locator("#algorithmVersion")).toHaveValue("f0-shore-v2");
  expect((await evidence()).buildReport.activeSplats).toBe(95319);
});
// A forced DPR=1 in normal browsing must fail these checks on Retina screens.
for (const nativeDpr of [2, 3])
  test(`normal browsing preserves detail at DPR ${nativeDpr} with a bounded backing buffer`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: nativeDpr,
    });
    try {
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:4173/?surface=baseline");
      await expect(page.locator("#status")).toHaveAttribute(
        "data-state",
        "ready",
      );
      await expect
        .poll(() =>
          page.locator("canvas").evaluate((c) => {
            const canvas = c as HTMLCanvasElement;
            return canvas.width / canvas.getBoundingClientRect().width;
          }),
        )
        .toBeCloseTo(2, 1);
    } finally {
      await context.close();
    }
  });
test("a display DPR change updates the backing buffer without a layout resize", async ({
  page,
}) => {
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  const original = await page
    .locator("canvas")
    .evaluate((c) => (c as HTMLCanvasElement).width);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await expect
    .poll(() =>
      page.locator("canvas").evaluate((c) => (c as HTMLCanvasElement).width),
    )
    .toBe(original * 2);
});
for (const mode of ["viewport", "dpr"] as const)
  test(`mid-route ${mode} change permanently invalidates measurement`, async ({
    page,
  }) => {
    await page.goto("/?surface=baseline");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await page.locator("#measure").click();
    await expect(page.locator("#measurement-data")).toHaveAttribute(
      "data-state",
      "running",
    );
    if (mode === "viewport") {
      await page.setViewportSize({ width: 640, height: 720 });
      await page.setViewportSize({ width: 1280, height: 720 });
    } else
      await page.evaluate(() =>
        Object.defineProperty(window, "devicePixelRatio", {
          value: 2,
          configurable: true,
        }),
      );
    await expect(page.locator("#measurement-data")).toHaveAttribute(
      "data-state",
      "complete",
    );
    const report = JSON.parse(
      (await page.locator("#measurement-data").textContent())!,
    );
    expect(report.verdict.status).toBe("incomplete");
    expect(report.invalidReasons).toContain("测量期间分辨率或DPR变化");
  });
for (const duringMeasurement of [false, true])
  test(`one-time render failure ${duringMeasurement ? "invalidates measurement" : "can recover by generating again"}`, async ({
    page,
  }) => {
    await page.goto("/?surface=baseline");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    if (duringMeasurement) {
      await page.locator("#measure").click();
      await expect(page.locator("#measurement-data")).toHaveAttribute(
        "data-state",
        "running",
      );
    }
    await page.evaluate(() => {
      const gl = document.querySelector("canvas")!.getContext("webgl2")!,
        clear = gl.clear;
      gl.clear = function () {
        gl.clear = clear;
        throw new Error("F0 one-time render failure");
      };
    });
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "error",
    );
    if (duringMeasurement) {
      await expect(page.locator("#measurement-data")).toHaveAttribute(
        "data-state",
        "complete",
      );
      const report = JSON.parse(
        (await page.locator("#measurement-data").textContent())!,
      );
      expect(report.verdict.status).toBe("incomplete");
      expect(report.invalidReasons).toContain("渲染器发生异常");
    }
    await page.locator("#generate").click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
  });
for (const changedSeed of ["222", "-1"])
  test(`edits to ${changedSeed} during delayed build remain visibly pending`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener("message", (event) => {
            event.stopImmediatePropagation();
            setTimeout(
              () =>
                this.onmessage?.call(
                  this,
                  new MessageEvent("message", { data: event.data }),
                ),
              250,
            );
          });
        }
      };
    });
    await page.goto("/?surface=baseline");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await page.locator("#seed").fill("111");
    await page.locator("#generate").click();
    await page.locator("#seed").fill(changedSeed);
    await expect(page.locator("#status")).toHaveAttribute("data-seed", "111");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await expect(page.locator("#dirty")).toContainText("参数已修改");
    await expect(page.locator("#seed")).toHaveValue(changedSeed);
  });
test("a changed recipe cannot reuse the initial scene's cold-load timing", async ({
  page,
}) => {
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#rock").fill("9");
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toContainText("版本 2");
  await page.locator("#measure").click();
  await expect(page.locator("#measurement-data")).toHaveAttribute(
    "data-state",
    "complete",
  );
  const report = JSON.parse(
    (await page.locator("#measurement-data").textContent())!,
  );
  expect(report.verdict.status).toBe("incomplete");
  expect(report.invalidReasons).toContain(
    "加载计时来自其他配方，请重新打开默认场景后测量",
  );
});
test("measurement requires a displayed scene and records interruption instead of passing", async ({
  page,
}) => {
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  expect(
    Number(await page.locator("#status").getAttribute("data-first-ready-ms")),
  ).toBeGreaterThan(0);
  await expect(page.locator("#measure")).toBeEnabled();
  await page.locator("#measure").click();
  await expect(page.locator("#measurement-data")).toHaveAttribute(
    "data-state",
    "running",
  );
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent("scene-changing")),
  );
  await expect(page.locator("#measurement-data")).toHaveAttribute(
    "data-state",
    "complete",
  );
  const report = JSON.parse(
    (await page.locator("#measurement-data").textContent())!,
  );
  expect(report.verdict.status).toBe("incomplete");
  expect(report.invalidReasons).toContain("场景或参数变更");
  await expect(page.locator("#generate")).toBeEnabled();
});
test("clear releases all owned sources before reopening a saved scene", async ({
  page,
}) => {
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  const baseline = JSON.parse(
    (await page.locator("#scene-evidence").textContent())!,
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#save").click(),
  ]);
  await page.getByRole("button", { name: "清空场景", exact: true }).click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "empty");
  const empty = JSON.parse(
    (await page.locator("#scene-evidence").textContent())!,
  );
  expect(empty.stats.sourceBuffers).toBe(0);
  expect(empty.stats.ownedBytes).toBe(0);
  await page.locator("#bundle-file").setInputFiles((await download.path())!);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  const restored = JSON.parse(
    (await page.locator("#scene-evidence").textContent())!,
  );
  expect(restored.stats).toEqual(baseline.stats);
});
test("manual workbench generates offline, newest request wins and errors recover", async ({
  page,
}) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.goto("/?surface=baseline");
  await expect(
    page.getByRole("button", { name: "生成场景", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.getByLabel("随机种子").fill("111");
  await page.getByRole("button", { name: "生成场景", exact: true }).click();
  await page.getByLabel("随机种子").fill("222");
  await page.getByRole("button", { name: "生成场景", exact: true }).click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "222");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.getByLabel("随机种子").fill("-1");
  await page.getByRole("button", { name: "生成场景", exact: true }).click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await page.getByLabel("随机种子").fill("333");
  await page.getByRole("button", { name: "生成场景", exact: true }).click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "333");
  await expect(page.getByText("未接入 LLM", { exact: false })).toBeVisible();
  await page.screenshot({ path: ".local/screens/task4-workbench.png" });
});
test("exported local bundle reopens and context loss has explicit recoverable state", async ({
  page,
}) => {
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "保存场景包", exact: true }).click(),
  ]);
  const path = await download.path();
  await page.locator("#bundle-file").setInputFiles(path!);
  await expect(page.locator("#status")).toContainText("已导入");
  await page.evaluate(() => {
    const ext = document
      .querySelector("canvas")!
      .getContext("webgl2")!
      .getExtension("WEBGL_lose_context")!;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), 1000);
  });
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "context-lost",
  );
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready", {
    timeout: 10000,
  });
});
