import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { AssetRequest } from "../../src/selection/contract";
import {
  enterReview,
  mockReviewModel,
  originalReviewPrompt,
  readyReviewPrompt,
  previewReview,
  historyBytes,
  openAdvanced,
} from "../support/review";
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/harness.html?workbench=1&review=1&planner=3b");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});
test("ordinary review entry hides engineering controls and does not preselect fake rocks", async ({
  page,
}) => {
  await expect(page.locator("#scene-review")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("#advanced-compat")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator("#plan-proposal")).not.toBeVisible();
  await expect(page.locator(".scene-stats")).not.toBeVisible();
  await mockReviewModel(page);
  await page.locator("#review-prompt").fill(originalReviewPrompt);
  await page.locator("#review-interpret").click();
  await expect(page.locator("#review-summary")).toContainText("石头");
  await expect(page.locator("#review-rock-omit")).not.toBeChecked();
  await expect(page.locator("#review-rock-placeholder")).not.toBeChecked();
  await expect(page.locator("#review-preview")).toBeDisabled();
});
test("real preview leaves export/history untouched, cancel restores camera, use alone saves", async ({
  page,
}) => {
  await page.locator('[data-camera="top"]').click();
  const before = await page.evaluate(() => ({
    recipe: (window as any).workbench.result.recipe,
    camera: (window as any).workbench.view.getCamera(),
  }));
  const old = await historyBytes(page);
  await enterReview(page);
  await expect(page.locator("#review-summary")).toContainText(
    "模型建议2组；本次暂不添加",
  );
  await previewReview(page);
  expect(await historyBytes(page)).toEqual(old);
  expect(
    await page.evaluate(() => (window as any).workbench.result.recipe),
  ).toEqual(before.recipe);
  await expect(page.locator("#save")).toBeDisabled();
  await page.locator("#review-cancel").click();
  expect(await historyBytes(page)).toEqual(old);
  const restored = await page.evaluate(() =>
    (window as any).workbench.view.getCamera(),
  );
  for (const key of ["position", "target"] as const)
    for (let i = 0; i < 3; i++)
      expect(restored[key][i]).toBeCloseTo(before.camera[key][i], 10);
  await previewReview(page);
  await page.locator("#review-use").click();
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "used",
  );
  const after = await historyBytes(page),
    records = JSON.parse(after["wetland.sceneReviews.v2"]!);
  expect(records).toHaveLength(1);
  expect(records[0].draft.prompt).toBe(readyReviewPrompt);
  expect(records[0].draft.originalRequest.rockCount).toBe(2);
  expect(records[0].effectiveRequest.rockCount).toBe(0);
  expect(records[0].draft.requirements.raw).toContain('"explicitLevel":0');
  for (const key of Object.keys(old).filter(
    (k) => k !== "wetland.sceneReviews.v2",
  ))
    expect(after[key]).toBe(old[key]);
  expect(
    await page.evaluate(
      () => (window as any).workbench.result.scene.water.count,
    ),
  ).toBeGreaterThan(0);
  await openAdvanced(page);
  await expect(page.locator("#algorithmVersion")).toHaveValue(
    "f0-riverbank-grass-v1",
  );
  await expect(page.locator("#measure")).toBeDisabled();
  await page.locator("#measure").evaluate((b: HTMLButtonElement) => {
    b.disabled = false;
    b.click();
  });
  await expect(page.locator("#measurement-data")).toBeEmpty();
});
test("explicit dry input previews no water and preserves the requirement", async ({
  page,
}) => {
  await enterReview(page, "干涸河床，不放水，放4丛低草", {
    rockCount: 0,
    waterLevel: null,
  });
  await previewReview(page);
  await expect(page.locator("#review-summary")).toContainText("本次无水");
  await page.locator("#review-use").click();
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "used",
  );
  expect(
    await page.evaluate(() => (window as any).workbench.result.scene.water),
  ).toBeNull();
});
test("editing the description cancels the candidate and resets old rock/consent choices", async ({
  page,
}) => {
  await enterReview(page);
  await previewReview(page);
  await page.locator("#review-prompt").fill("河岸上放2丛芦苇和石头");
  await expect(page.locator("#review-use")).toBeDisabled();
  await page.locator("#review-interpret").click();
  await expect(page.locator("#review-summary")).toContainText("石头");
  await expect(page.locator("#review-rock-omit")).not.toBeChecked();
  await expect(page.locator("#review-procedural")).not.toBeChecked();
  expect((await historyBytes(page))["wetland.sceneReviews.v2"]).toBeNull();
});
test("model exit keeps user input and the committed scene, never substitutes a success", async ({
  page,
}) => {
  const before = await page.evaluate(
    () => (window as any).workbench.result.recipe,
  );
  await page.route("**/api/planner/review/requirements-v2", (route) =>
    route.fulfill({ status: 500, json: { error: "test service exited" } }),
  );
  await page.locator("#review-prompt").fill(originalReviewPrompt);
  await page.locator("#review-interpret").click();
  await expect(page.locator("#review-status")).toContainText("模型未完成");
  await expect(page.locator("#review-evidence")).toContainText(
    "test service exited",
  );
  await expect(page.locator("#review-prompt")).toHaveValue(
    originalReviewPrompt,
  );
  expect(
    await page.evaluate(() => (window as any).workbench.result.recipe),
  ).toEqual(before);
  await expect(page.locator("#review-preview")).toBeDisabled();
});
test("a late interpretation cannot replace an edited description", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/planner/review/requirements-v2", async (route) => {
    await gate;
    await route
      .fulfill({ status: 500, json: { error: "obsolete" } })
      .catch(() => {});
  });
  await page.locator("#review-prompt").fill(originalReviewPrompt);
  await page.locator("#review-interpret").click();
  await page.locator("#review-prompt").fill("新的手动描述");
  release();
  await expect(page.locator("#review-status")).not.toContainText("obsolete");
  await expect(page.locator("#review-preview")).toBeDisabled();
});
for (const kind of ["packed", "ext", "mesh"] as const)
  test(`GPU ${kind} failure retains old scene and no history`, async ({
    page,
  }) => {
    const before = await page.evaluate(() => ({
      recipe: (window as any).workbench.result.recipe,
      camera: (window as any).workbench.view.getCamera(),
    }));
    await enterReview(page);
    await page.evaluate((k) => window.sparkProbe.failInitialization(k), kind);
    await page.locator("#review-preview").click();
    await expect(page.locator("#review-status")).toHaveAttribute(
      "data-phase",
      "error",
    );
    expect(
      await page.evaluate(() => (window as any).workbench.result.recipe),
    ).toEqual(before.recipe);
    expect(
      await page.evaluate(() => (window as any).workbench.view.getCamera()),
    ).toEqual(before.camera);
    expect((await historyBytes(page))["wetland.sceneReviews.v2"]).toBeNull();
  });
test("cancelling while record hashing is held never commits or writes", async ({
  page,
}) => {
  await enterReview(page);
  await previewReview(page);
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    (window as any).releaseReviewHash = null;
    crypto.subtle.digest = async (...args) => {
      await new Promise<void>((resolve) => {
        (window as any).releaseReviewHash = resolve;
      });
      return digest(...args);
    };
  });
  await page.locator("#review-use").click();
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).releaseReviewHash)))
    .toBe(true);
  await page.locator("#review-cancel").click();
  await page.evaluate(() => (window as any).releaseReviewHash());
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "draft",
  );
  expect((await historyBytes(page))["wetland.sceneReviews.v2"]).toBeNull();
});
test("WebGL loss during preview restores only the previously committed scene", async ({
  page,
}) => {
  const before = await page.evaluate(
    () => (window as any).workbench.result.recipe,
  );
  await enterReview(page);
  await previewReview(page);
  await page.evaluate(() => {
    const ext = document
      .querySelector("canvas")!
      .getContext("webgl2")!
      .getExtension("WEBGL_lose_context")!;
    (window as any).reviewLoss = ext;
    ext.loseContext();
  });
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "context-lost",
  );
  await page.evaluate(() => (window as any).reviewLoss.restoreContext());
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  expect(
    await page.evaluate(() => (window as any).workbench.result.recipe),
  ).toEqual(before);
  expect((await historyBytes(page))["wetland.sceneReviews.v2"]).toBeNull();
  await expect(page.locator("#review-use")).toBeDisabled();
});
test("two isolated same-origin tabs save reviews without losing either record", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  await second.goto("/?review=1");
  await expect(second.locator("#status")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await enterReview(page);
  await previewReview(page);
  await enterReview(second, readyReviewPrompt, { seed: 43 });
  await previewReview(second);
  await Promise.all([
    page.locator("#review-use").click(),
    second.locator("#review-use").click(),
  ]);
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "used",
  );
  await expect(second.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "used",
  );
  const saved = JSON.parse(
    (await historyBytes(page))["wetland.sceneReviews.v2"]!,
  );
  expect(saved.map((r: any) => r.recipe.seed).sort()).toEqual([42, 43]);
  await second.close();
});
test("quota failure keeps prior history and offers the actually used record for download", async ({
  page,
}) => {
  await enterReview(page);
  await previewReview(page);
  const before = await historyBytes(page);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "wetland.sceneReviews.v2") throw Error("test quota");
      set.call(this, key, value);
    };
  });
  await page.locator("#review-use").click();
  await expect(page.locator("#review-status")).toContainText(
    "已使用此场景，但记录未保存",
  );
  expect(await historyBytes(page)).toEqual(before);
  await page.locator(".review-records > summary").click();
  const downloading = page.waitForEvent("download");
  await page.locator("#review-save").click();
  const record = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(record.draft.prompt).toBe(readyReviewPrompt);
  expect(record.recipe).toEqual(
    await page.evaluate(() => (window as any).workbench.result.recipe),
  );
});

for (const [name, patch, reason] of [
  ["unsupported environment", { biome: "unsupported" }, "本轮只支持湿地"],
  [
    "clarification",
    { clarification: "请说明两种植物中保留哪一种" },
    "请说明两种植物",
  ],
  ["missing captured plants", { plantOrigin: "captured" }, "资源缺失"],
] as [string, Partial<AssetRequest>, string][])
  test(`review blocker explains ${name} without opening advanced records`, async ({
    page,
  }) => {
    await mockReviewModel(page, { rockCount: 0, ...patch });
    await page.locator("#review-prompt").fill(readyReviewPrompt);
    await page.locator("#review-interpret").click();
    await expect(page.locator("#review-summary")).toContainText(reason);
    await expect(page.locator("#review-summary")).toContainText("修改描述");
    await expect(page.locator("#review-preview")).toBeDisabled();
    await expect(page.locator("#review-procedural")).toBeDisabled();
    expect((await historyBytes(page))["wetland.sceneReviews.v2"]).toBeNull();
  });

test("review semantic rejection explains why the original river description was not applied", async ({
  page,
}) => {
  await page.route("**/api/planner/review/requirements-v2", (r) =>
    r.fulfill({
      status: 400,
      json: {
        error:
          "水体要求不一致：描述需要河岸水面，返回了无水。请按原描述重新输出，不能省略水体。",
      },
    }),
  );
  await page.locator("#review-prompt").fill(originalReviewPrompt);
  await page.locator("#review-interpret").click();
  await expect(page.locator("#review-status")).toContainText("返回了无水");
  await expect(page.locator("#review-status")).toContainText("手动设置");
  await expect(page.locator("#review-prompt")).toHaveValue(
    originalReviewPrompt,
  );
});

async function holdReviewHistory(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const state = window as any;
    state.reviewLockHeld = false;
    state.committedReviews = [];
    document.addEventListener("review-used", (event) =>
      state.committedReviews.push((event as CustomEvent).detail),
    );
    const gate = new Promise<void>((resolve) => {
      state.releaseReviewLock = resolve;
    });
    void navigator.locks.request("wetland.sceneReviews.v2", async () => {
      state.reviewLockHeld = true;
      await gate;
    });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).reviewLockHeld))
    .toBe(true);
}

test("review persistence wait cannot cancel an already used scene or claim rollback", async ({
  page,
}) => {
  await enterReview(page, readyReviewPrompt, { seed: 63 });
  await previewReview(page);
  await holdReviewHistory(page);
  await page.locator("#review-use").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).committedReviews.length))
    .toBe(1);
  await expect(page.locator("#review-cancel")).toBeDisabled();
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "saving",
  );
  await page.locator("#review-cancel").evaluate((button: HTMLButtonElement) => {
    button.disabled = false;
    button.click();
  });
  await expect(page.locator("#review-status")).not.toContainText("恢复上一版");
  expect(
    await page.evaluate(() => (window as any).workbench.result.recipe.seed),
  ).toBe(63);
  await page.evaluate(() => (window as any).releaseReviewLock());
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "used",
  );
  expect(
    JSON.parse((await historyBytes(page))["wetland.sceneReviews.v2"]!),
  ).toHaveLength(1);
});

test("review persistence failure survives editing and a newer use, with the matching record downloadable", async ({
  page,
}) => {
  await enterReview(page, readyReviewPrompt, { seed: 63 });
  await previewReview(page);
  await holdReviewHistory(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let first = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === "wetland.sceneReviews.v2" && first) {
        first = false;
        throw Error("late quota");
      }
      original.call(this, key, value);
    };
  });
  await page.locator("#review-use").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).committedReviews.length))
    .toBe(1);
  await enterReview(page, "河岸上放4丛低草，水位0", { seed: 64, rockCount: 0 });
  await previewReview(page);
  await page.locator("#review-use").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).committedReviews.length))
    .toBe(2);
  await page.evaluate(() => (window as any).releaseReviewLock());
  await expect(page.locator("#review-persistence")).toContainText("late quota");
  await expect(page.locator("#review-persistence")).toBeVisible();
  await expect(page.locator("#review-status")).toHaveAttribute(
    "data-phase",
    "used",
  );
  expect(
    await page.evaluate(() => (window as any).workbench.result.recipe.seed),
  ).toBe(64);
  const records = JSON.parse(
    (await historyBytes(page))["wetland.sceneReviews.v2"]!,
  );
  expect(records.map((r: any) => r.recipe.seed)).toEqual([64]);
  const download = page.waitForEvent("download");
  await page.locator("#review-persistence button").click();
  const unsaved = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(unsaved.recipe.seed).toBe(63);
  expect(unsaved.draft.prompt).toBe(readyReviewPrompt);
});
