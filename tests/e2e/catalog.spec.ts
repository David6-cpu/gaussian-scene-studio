import { test, expect } from "@playwright/test";

const scene = async (page: any) =>
  JSON.parse(await page.locator("#scene-evidence").textContent());
test("catalog exposes origin and missing snow without applying a scene or writing history", async ({
  page,
}) => {
  await page.goto("/?planner=3b");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  const initial = await scene(page),
    history = await page.evaluate(() =>
      localStorage.getItem("wetland.plans.v1"),
    );
  await page.locator("#catalog-details summary").click();
  await expect(page.locator("#catalog-current")).toContainText(
    "river-low-grass-v2",
  );
  await expect(page.locator("#catalog-results")).toContainText("VeryOS");
  await expect(page.locator("#catalog-results")).toContainText("CC-BY-4.0");
  await page.locator("#catalog-category").selectOption("grass");
  await expect(page.locator("#catalog-results")).toContainText("程序");
  await page.locator("#catalog-origin").selectOption("captured");
  await expect(page.locator("#catalog-message")).toContainText("缺失");
  await expect(page.locator("#catalog-results li")).toHaveCount(0);
  await page.locator("#catalog-origin").selectOption("either");
  await page.locator("#catalog-biome").selectOption("snow-mountain");
  await page.locator("#catalog-category").selectOption("ground");
  await expect(page.locator("#catalog-message")).toContainText("雪山");
  await expect(page.locator("#catalog-message")).toContainText("缺失");
  await expect(page.locator("#catalog-results li")).toHaveCount(0);
  expect((await scene(page)).recipe).toEqual(initial.recipe);
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.plans.v1")),
  ).toBe(history);
  await expect(page.locator("#plan-confirm")).toBeDisabled();
});
test("snow wording gets an honest API rejection instead of a wetland fallback", async ({
  page,
}) => {
  await page.goto("/?planner=3b");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  const before = (await scene(page)).recipe;
  await page.locator("#plan-prompt").fill("雪山里三块石头，四丛草");
  const response = page.waitForResponse("**/api/planner/generate");
  await page.locator("#plan-run").click();
  expect((await response).status()).toBe(400);
  await expect(page.locator("#plan-message")).toContainText("资源缺失");
  await expect(page.locator("#plan-review")).toBeHidden();
  expect((await scene(page)).recipe).toEqual(before);
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.plans.v1")),
  ).toBeNull();
});
test("catalog description follows old scene-version choices and keeps query read-only", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#catalog-details summary").click();
  await page.locator("#algorithmVersion").selectOption("f0-riverside-reed-v1");
  await expect(page.locator("#catalog-current")).toContainText("river-reed-v1");
  await page.locator("#algorithmVersion").selectOption("f0-v1");
  await expect(page.locator("#catalog-current")).toContainText(
    "legacy-plant-v1",
  );
  await expect(page.locator("#catalog-current")).toContainText("程序地表");
});
