import { expect, test } from "@playwright/test";
import { defaultReviewRequestV2 } from "../../src/review-v2/requirements";
import { LLAMA_SMALL_MODEL } from "../../src/planner/service";
import {
  mockReviewModel,
  historyBytes,
  previewReview,
} from "../support/review";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/harness.html?workbench=1&review=1&planner=3b");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});
test("original river intent is visible while geometry remains pending and no choose/build happens", async ({
  page,
}) => {
  await page.route("**/api/planner/review/requirements-v2", async (route) => {
    const { prompt } = route.request().postDataJSON();
    const request = {
      ...defaultReviewRequestV2,
      water: { mode: "river", explicitLevel: null },
    };
    await route.fulfill({
      json: {
        schemaVersion: 2,
        prompt,
        request,
        raw: JSON.stringify(request),
        model: LLAMA_SMALL_MODEL,
        elapsedMs: 1,
      },
    });
  });
  let choices = 0;
  page.on("request", (r) => {
    if (r.url().includes("/assets/choose")) choices++;
  });
  const old = await historyBytes(page);
  const before = await page.evaluate(
    () => (window as any).workbench.result.recipe,
  );
  await page.locator("#review-prompt").fill("河岸上放一些低矮草丛和石头");
  await page.locator("#review-interpret").click();
  await expect(page.locator("#review-summary")).toContainText("需要河流");
  await expect(page.locator("#review-summary")).toContainText("水面位置");
  await page.locator("#review-rock-omit").check();
  await expect(page.locator("#review-preview")).toBeDisabled();
  await expect(page.locator("#review-summary")).not.toContainText("本次无水");
  await page.locator("#review-preview").evaluate((b: HTMLButtonElement) => {
    b.disabled = false;
    b.click();
  });
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "error",
  );
  expect(choices).toBe(0);
  expect(await historyBytes(page)).toEqual(old);
  expect(
    await page.evaluate(() => (window as any).workbench.result.recipe),
  ).toEqual(before);
});
test("manual dry override saves v2 intent and preserves existing v1 bytes only after use", async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem("wetland.sceneReviews.v1", "[]"),
  );
  const old = await historyBytes(page);
  await page.locator("#review-prompt").fill("河岸上放一些低矮草丛和石头");
  await page.locator("#review-manual").click();
  await expect(page.locator("#review-summary")).toContainText("需要河流");
  await page.locator("#review-water").selectOption("off");
  await page.locator("#review-rock-omit").check();
  await page.locator("#review-procedural").check();
  await previewReview(page);
  expect(await historyBytes(page)).toEqual(old);
  await page.locator("#review-cancel").click();
  expect(await historyBytes(page)).toEqual(old);
  await previewReview(page);
  await page.locator("#review-use").click();
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "used",
  );
  const after = await historyBytes(page);
  expect(after["wetland.sceneReviews.v1"]).toBe("[]");
  const records = JSON.parse(after["wetland.sceneReviews.v2"]!);
  expect(records).toHaveLength(1);
  expect(records[0].draft.originalRequest.water).toEqual({
    mode: "river",
    explicitLevel: null,
  });
  expect(records[0].draft.edits.water).toBe("off");
  expect(records[0].waterResolution.source).toBe("user-choice");
  expect(
    await page.evaluate(() => (window as any).workbench.result.scene.water),
  ).toBeNull();
});
test("a numeric level without a river noun is shown as a water surface", async ({
  page,
}) => {
  await mockReviewModel(page, { rockCount: 0, waterLevel: -0.025 });
  await page.locator("#review-prompt").fill("水位-0.025，4丛低草");
  await page.locator("#review-interpret").click();
  await expect(page.locator("#review-summary")).toContainText("需要水面");
  await expect(page.locator("#review-summary")).not.toContainText("未指定");
});
