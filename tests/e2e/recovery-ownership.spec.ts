import { test, expect, type Page } from "@playwright/test";

async function holdRecovery(page: Page) {
  await page.goto("/tests/harness.html?workbench=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.evaluate(() => {
    const ext = document.querySelector("canvas")!.getContext("webgl2")!
      .getExtension("WEBGL_lose_context")!;
    (window as any).recoveryLoss = ext;
    ext.loseContext();
  });
  await expect(page.locator("#status")).toHaveAttribute("data-state", "context-lost");
  await page.evaluate(() => {
    window.sparkProbe.pauseInitialization("packed");
    (window as any).recoveryLoss.restoreContext();
  });
  await expect.poll(() => page.evaluate(() => window.sparkProbe.snapshot().initializationHeld)).toBe(true);
  await page.evaluate(() => {
    const v = (window as any).workbench.view, prepare = v.prepareScene.bind(v);
    (window as any).recoveryTrace = { calls: 0, prepared: false };
    v.prepareScene = async (...args: any[]) => {
      (window as any).recoveryTrace.calls++;
      const swap = await prepare(...args);
      (window as any).recoveryTrace.prepared = true;
      return swap;
    };
  });
}

test("cancelled recovery cannot start a late scene transaction", async ({ page }) => {
  await holdRecovery(page);
  await page.locator("#cancel").click();
  await page.evaluate(() => window.sparkProbe.resumeInitialization());
  await expect.poll(() => page.evaluate(() => window.sparkProbe.snapshot().live.packed)).toBe(0);
  expect(await page.evaluate(() => (window as any).recoveryTrace.calls)).toBe(0);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "cancelled");
});

test("late recovery cannot roll back a newer activated scene", async ({ page }) => {
  await holdRecovery(page);
  await page.evaluate(() => {
    const v = (window as any).workbench.view;
    (window as any).originalDisplayed = v.isCurrentSceneDisplayed.bind(v);
    v.isCurrentSceneDisplayed = () => false;
  });
  await page.locator("#seed").fill("842");
  await page.locator("#generate").click();
  await expect.poll(() => page.evaluate(() => (window as any).recoveryTrace.prepared)).toBe(true);
  await page.evaluate(async () => {
    window.sparkProbe.resumeInitialization();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  expect(await page.evaluate(() => (window as any).recoveryTrace.calls)).toBe(1);
  await page.evaluate(() => {
    (window as any).workbench.view.isCurrentSceneDisplayed = (window as any).originalDisplayed;
  });
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "842");
});

test("obsolete recovery rejection cannot replace the newer success status", async ({ page }) => {
  await holdRecovery(page);
  await page.locator("#seed").fill("843");
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "843");
  await page.evaluate(async () => {
    window.sparkProbe.resumeInitialization("injected obsolete recovery failure");
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "843");
});
