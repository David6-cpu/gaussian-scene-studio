import { test, expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";

async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.ready &&
          window.testView.isCurrentSceneDisplayed() &&
          !window.sparkProbe.snapshot().sorting,
      ),
    )
    .toBe(true);
}

test("same canvas recovery waits for old sorting and renders the replacement", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/harness.html");
  await settled(page);
  const disposedBeforeReplacement = await page.evaluate(async () => {
    window.sparkProbe.pauseReadback(150);
    window.testView.setCamera([2, 1, 6], [0, 0, 0]);
    window.testView.render();
    window.testView.dispose();
    const next = await window.createTestView(document.querySelector("canvas")!);
    const completed = window.sparkProbe.snapshot().disposals;
    next.resize(1280, 720, 1);
    next.setCamera([0, 0, 8], [0, 0, 0]);
    await next.setScene(window.fixture());
    window.testView = next;
    return completed;
  });
  expect(disposedBeforeReplacement).toBe(1);
  await settled(page);
  const png = PNG.sync.read(await page.locator("canvas").screenshot());
  const center = (360 * 1280 + 640) * 4;
  expect(png.data[center + 1] - png.data[center]).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test("Spark timer-triggered sorting failures remain observable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/harness.html");
  await settled(page);
  await page.evaluate(() => {
    window.sparkProbe.failNextReadback();
    window.sparkProbe.scheduleSort();
  });
  await expect.poll(() => errors).toEqual(["injected readback failure"]);
  await page.evaluate(() => window.testView.dispose());
  await expect
    .poll(() => page.evaluate(() => window.sparkProbe.snapshot().disposals))
    .toBe(1);
});

test("dispose during pending depth readback releases resources without page errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/harness.html");
  await settled(page);
  expect(
    await page.evaluate(() => {
      window.sparkProbe.pauseReadback(80);
      window.testView.setCamera([2, 1, 6], [0, 0, 0]);
      window.testView.render();
      const sorting = window.sparkProbe.snapshot().sorting;
      window.testView.dispose();
      window.testView.dispose();
      window.testView.render();
      return sorting;
    }),
  ).toBe(true);
  await page.waitForTimeout(250);
  expect(errors).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => window.sparkProbe.snapshot()))
    .toMatchObject({
      disposals: 1,
      programReferences: 0,
      worker: false,
    });
  expect(await page.evaluate(() => window.testView.stats().ownedBytes)).toBe(0);
});

test("six scene reloads release retired compute materials", async ({
  page,
}) => {
  await page.goto("/tests/harness.html");
  await settled(page);
  const baseline = await page.evaluate(
    () => window.sparkProbe.snapshot().programReferences,
  );
  expect(baseline).toBeGreaterThan(1);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(async () => {
      window.testView.clearScene();
      await window.testView.setScene(window.fixture());
    });
    await settled(page);
    expect(
      await page.evaluate(() => window.sparkProbe.snapshot().programReferences),
    ).toBe(baseline);
  }
});

test("dispose drains completion after the actual sort worker returns", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/harness.html");
  await settled(page);
  await page.evaluate(() => {
    window.sparkProbe.pauseAfterWorker();
    window.testView.setCamera([2, 1, 6], [0, 0, 0]);
    window.testView.render();
  });
  await page.waitForFunction(() => window.sparkProbe.snapshot().workerReturned);
  expect(
    await page.evaluate(() => {
      const sorting = window.sparkProbe.snapshot().sorting;
      window.testView.dispose();
      return sorting;
    }),
  ).toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.sparkProbe.snapshot()))
    .toMatchObject({
      disposals: 1,
      programReferences: 0,
      worker: false,
    });
  expect(errors).toEqual([]);
});

test("failed in-flight readback remains observable and does not prevent disposal", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/harness.html");
  await settled(page);
  await page.evaluate(() => {
    window.sparkProbe.pauseReadback(30);
    window.sparkProbe.failNextReadback();
    window.testView.setCamera([2, 1, 6], [0, 0, 0]);
    window.testView.render();
    window.testView.dispose();
  });
  await expect.poll(() => errors).toEqual(["injected readback failure"]);
  await expect
    .poll(() => page.evaluate(() => window.sparkProbe.snapshot()))
    .toMatchObject({
      disposals: 1,
      programReferences: 0,
      worker: false,
    });
});

test("LOD changes retire compute materials and keep shared sources usable", async ({
  page,
}) => {
  await page.goto("/tests/harness.html?assets=1&count=5");
  await page.evaluate(() => window.testView.setLodEnabled(false));
  await settled(page);
  const baseline = await page.evaluate(() => ({
    refs: window.sparkProbe.snapshot().programReferences,
    active: window.testView.stats().activeSplats,
  }));
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      window.testView.setLodEnabled(true);
      window.testView.setCamera([0, 40, 75], [0, 0, 0]);
    });
    await expect
      .poll(() => page.evaluate(() => window.testView.stats().activeSplats))
      .toBe(baseline.active - 5 * 3072);
    await settled(page);
    expect(
      await page.evaluate(() => window.sparkProbe.snapshot().programReferences),
    ).toBe(baseline.refs);
    await page.evaluate(() => window.testView.setLodEnabled(false));
    await expect
      .poll(() => page.evaluate(() => window.testView.stats().activeSplats))
      .toBe(baseline.active);
    await settled(page);
    expect(
      await page.evaluate(() => window.sparkProbe.snapshot().programReferences),
    ).toBe(baseline.refs);
  }
});
