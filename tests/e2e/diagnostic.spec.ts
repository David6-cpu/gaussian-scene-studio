import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test("rock cleanup is opt-in and returns to the exact original count and transform", async ({
  page,
}) => {
  await page.goto("/diagnostic.html?asset=rock&cleanup=large");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-state",
    "ready",
  );
  const read = async () =>
    JSON.parse((await page.locator("#diagnostic-evidence").textContent())!);
  await expect.poll(async () => (await read()).stats.activeSplats).toBe(197205);
  await expect(page.locator("#asset-label")).toContainText("候选");
  const transform = (await read()).load.transform;
  expect((await read()).load.cleanup.removedCount).toBe(46);
  await page.locator("#ground-cleanup").selectOption("off");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect.poll(async () => (await read()).stats.activeSplats).toBe(197251);
  expect((await read()).load.transform).toEqual(transform);
  await page.reload();
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect.poll(async () => (await read()).stats.activeSplats).toBe(197205);
  await page.goto("/diagnostic.html?asset=rock");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect.poll(async () => (await read()).stats.activeSplats).toBe(197251);
  expect((await read()).load.cleanup).toBeNull();
});
test("real rock crop remains isolated, attributed and bounded when switching diagnostics", async ({
  page,
}) => {
  await page.goto("/diagnostic.html?asset=rock");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(page.locator("#asset-mode")).toHaveValue("rock");
  const read = async () =>
    JSON.parse((await page.locator("#diagnostic-evidence").textContent())!);
  await expect(page.locator("#attribution")).toContainText("Loop CE");
  expect((await read()).stats).toMatchObject({
    sourceBuffers: 1,
    instanceCount: 0,
    activeSplats: 197251,
    uniqueSourceSplats: 197251,
  });
  expect((await read()).load.transform.displayFootprint).toBe(1);
  expect((await read()).source.sourceCount).toBe(7339238);
  await page.locator('[data-preset="top"]').click();
  await page.locator("#asset-mode").selectOption("capture");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-mode",
    "capture",
  );
  expect((await read()).stats.activeSplats).toBe(113648);
  await page.locator("#asset-mode").selectOption("rock");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-mode",
    "rock",
  );
  expect((await read()).stats.sourceBuffers).toBe(1);
  expect((await read()).stats.activeSplats).toBe(197251);
  await page.locator("#pixel-ratio").selectOption("1");
  await expect.poll(async () => (await read()).renderDpr).toBe(1);
  expect((await read()).appearance.density).toBe("original within crop");
});
test("licensed capture and synthetic control each render one source with accurate counts", async ({
  page,
}) => {
  await page.goto("/diagnostic.html");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(page.locator("#attribution")).toContainText("Marcel Padilla");
  await expect(
    page.locator("#attribution a").filter({ hasText: "CC BY 4.0" }),
  ).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
  const read = async () =>
    JSON.parse((await page.locator("#diagnostic-evidence").textContent())!);
  expect((await read()).stats).toMatchObject({
    sourceBuffers: 1,
    uniqueSourceSplats: 113648,
    activeSplats: 113648,
    instanceCount: 0,
  });
  expect((await read()).objectCount).toBe(1);
  await page.locator("#asset-mode").selectOption("synthetic");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-mode",
    "synthetic",
  );
  expect((await read()).stats).toMatchObject({
    sourceBuffers: 1,
    uniqueSourceSplats: 4096,
    activeSplats: 4096,
  });
  await expect(page.locator("#asset-label")).toContainText("程序合成");
  await page.locator("#asset-mode").selectOption("capture");
  await expect(page.locator("#diagnostic-status")).toHaveAttribute(
    "data-mode",
    "capture",
  );
  expect((await read()).stats.activeSplats).toBe(113648);
  await page.locator("#pixel-ratio").selectOption("1");
  await expect.poll(async () => (await read()).renderDpr).toBe(1);
  await page.locator("#pixel-ratio").selectOption("2");
  await expect.poll(async () => (await read()).renderDpr).toBe(2);
  await page.locator("#orbit").click();
  await expect(page.locator("#orbit")).toHaveAttribute("aria-pressed", "true");
  const camera = (await read()).camera;
  await expect
    .poll(async () => JSON.stringify((await read()).camera))
    .not.toBe(JSON.stringify(camera));
});
for (const asset of ["houseplant", "loopce-rock"])
  test(`a corrupted ${asset} diagnostic asset is rejected before scene adoption`, async ({
    page,
  }) => {
    const file = asset === "houseplant" ? "plant.splat" : "rock-patch.splat";
    const routePath = `**/diagnostics/${asset}/${file}`;
    const bad = readFileSync(`public/diagnostics/${asset}/${file}`);
    bad[0] ^= 1;
    await page.route(routePath, (route) =>
      route.fulfill({ body: bad, contentType: "application/octet-stream" }),
    );
    await page.goto(
      asset === "houseplant"
        ? "/diagnostic.html"
        : "/diagnostic.html?asset=rock",
    );
    await expect(page.locator("#diagnostic-status")).toHaveAttribute(
      "data-state",
      "error",
    );
    await expect(page.locator("#diagnostic-status")).toContainText("SHA-256");
    await page.unroute(routePath);
    await page.locator("#retry").click();
    await expect(page.locator("#diagnostic-status")).toHaveAttribute(
      "data-state",
      "ready",
    );
  });
