import { expect, type Page } from "@playwright/test";
import {
  defaultAssetRequest,
  candidateSnapshot,
  type AssetRequest,
} from "../../src/selection/contract";
import { BUILTIN_CONTEXT } from "../../src/assets/catalog/context";
import { LLAMA_SMALL_MODEL } from "../../src/planner/service";
export const originalReviewPrompt = "河岸上放一些低矮草丛和石头";
// Ready geometry fixture for transaction tests, separate from the original sentence.
export const readyReviewPrompt = "河岸上放一些低矮草丛和石头，水位0";
export async function openAdvanced(page: Page) {
  const container = page.locator("#advanced-compat");
  if (
    (await container.count()) &&
    !(await container.evaluate((e) => (e as HTMLDetailsElement).open))
  )
    await container.locator(":scope > summary").click();
}
// Constructed HTTP responses exercise the app, never count as real-model evidence.
export async function mockReviewModel(
  page: Page,
  patch: Partial<AssetRequest> = {},
) {
  await page.route("**/api/planner/review/requirements-v2", async (route) => {
    const { prompt } = route.request().postDataJSON();
    const { waterLevel: _legacy, ...materials } = {
      ...defaultAssetRequest,
      ...patch,
    };
    const explicit = /水位\s*(-?\d+(?:\.\d+)?)/.exec(prompt);
    const mode = /不放水|无水|干涸/.test(prompt)
      ? "none"
      : /河岸|河流/.test(prompt)
        ? "river"
        : explicit
          ? "surface"
          : "unspecified";
    const request = {
      ...materials,
      water: { mode, explicitLevel: explicit ? Number(explicit[1]) : null },
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
  await page.route("**/api/planner/assets/choose", async (route) => {
    const { request } = route.request().postDataJSON();
    const candidates = candidateSnapshot(request);
    const choices = candidates.map((s) => ({
      key: s.key,
      assetId: s.assetIds[0],
    }));
    await route.fulfill({
      json: {
        request,
        catalogVersion: BUILTIN_CONTEXT.catalogVersion,
        candidates,
        choices,
        raw: JSON.stringify({ choices }),
        model: LLAMA_SMALL_MODEL,
        elapsedMs: 1,
      },
    });
  });
}
export async function enterReview(
  page: Page,
  prompt = readyReviewPrompt,
  patch: Partial<AssetRequest> = {},
) {
  await mockReviewModel(page, patch);
  await page.locator("#review-prompt").fill(prompt);
  await page.locator("#review-interpret").click();
  await expect(page.locator("#review-summary")).toContainText("植物");
  if ((patch.rockCount ?? 2) > 0)
    await page.locator("#review-rock-omit").check();
  if ((patch.plantCount ?? 4) > 0)
    await page.locator("#review-procedural").check();
}
export async function previewReview(page: Page) {
  await page.locator("#review-preview").click();
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "preview",
  );
}
export async function historyBytes(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [
        "wetland.plans.v1",
        "wetland.assetPlans.v1",
        "wetland.assetPlans.v2",
        "wetland.sceneReviews.v1",
        "wetland.sceneReviews.v2",
      ].map((key) => [key, localStorage.getItem(key)]),
    ),
  );
}
