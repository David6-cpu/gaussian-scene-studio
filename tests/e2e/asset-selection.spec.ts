import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { interpretRequest, selectAssets } from "../../src/selection/service";
import {
  defaultAssetRequest,
  candidateSnapshot,
  type AssetRequest,
} from "../../src/selection/contract";
import { LLAMA_SMALL_MODEL } from "../../src/planner/service";
import { confirmAssetPlan } from "../../src/selection/history";
const request = {
  ...defaultAssetRequest,
  plantKind: "reed",
  plantCount: 3,
  seed: 73,
} as AssetRequest;
const reply = (v: unknown) => ({
  raw: JSON.stringify(v),
  model: LLAMA_SMALL_MODEL,
  done: true,
  doneReason: "stop",
});
async function fixtures(r = request) {
  const first = await interpretRequest(
    "湿地，2组石头和3丛芦苇",
    async () => reply(r),
    new AbortController().signal,
  );
  const second = await selectAssets(
    r,
    async () =>
      reply({
        choices: candidateSnapshot(r).map((c) => ({
          key: c.key,
          assetId: c.assetIds[0],
        })),
      }),
    new AbortController().signal,
  );
  return { first, second };
}
async function stage(page: Page) {
  const { first, second } = await fixtures();
  await page.route("**/api/planner/assets/requirements", (route) =>
    route.fulfill({ json: first }),
  );
  await page.route("**/api/planner/assets/choose", (route) =>
    route.fulfill({ json: second }),
  );
  await page.locator("#asset-prompt").fill(first.prompt);
  await page.locator("#asset-interpret").click();
  await expect(page.locator("#asset-request")).toHaveValue(
    JSON.stringify(request, null, 2),
  );
  await page.locator("#asset-choose").click();
  await expect(page.locator("#asset-selection")).toContainText("river-reed-v1");
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#asset-details > summary").click();
});
test("confirmed IDs change the displayed scene and survive separate JSON and legacy ZIP roundtrips", async ({
  page,
  context,
}) => {
  const old = await page.evaluate(() =>
    localStorage.getItem("wetland.plans.v1"),
  );
  await stage(page);
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await expect(page.locator("#algorithmVersion")).toHaveValue(
    "f0-riverside-grass-v2",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.assetPlans.v1")),
  ).toBeNull();
  await page.locator("#asset-program-confirm").check();
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#asset-current")).toContainText("场景已显示");
  await expect(page.locator("#algorithmVersion")).toHaveValue(
    "f0-riverside-reed-v1",
  );
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "73");
  const download = page.waitForEvent("download");
  await page.locator("#asset-save").click();
  const path = (await (await download).path())!;
  const record = JSON.parse(await readFile(path, "utf8"));
  expect(record).toMatchObject({
    format: "wetland-asset-plan",
    schemaVersion: 1,
    requirementsSource: "model",
  });
  expect(record.selection.choices[2].assetId).toBe("river-reed-v1");
  await page.locator("#clear").click();
  await page.locator("#asset-file").setInputFiles(path);
  await expect(page.locator("#asset-message")).toContainText("历史导入");
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await page.locator("#asset-program-confirm").check();
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#asset-current")).toContainText("历史导入");
  const zip = page.waitForEvent("download");
  await page.locator("#save").click();
  const zipPath = (await (await zip).path())!;
  await page.locator("#clear").click();
  await context.setOffline(true);
  await page.locator("#bundle-file").setInputFiles(zipPath);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#algorithmVersion")).toHaveValue(
    "f0-riverside-reed-v1",
  );
  await expect(page.locator("#asset-current")).toContainText("无已关联选材");
  await context.setOffline(false);
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.plans.v1")),
  ).toBe(old);
});
test("edited requirements revoke confirmation; missing captured plants and forged IDs cannot be applied", async ({
  page,
}) => {
  await stage(page);
  await page.locator("#asset-program-confirm").check();
  await page
    .locator("#asset-request")
    .fill(JSON.stringify({ ...request, plantOrigin: "captured" }));
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await page.locator("#asset-query").click();
  await expect(page.locator("#asset-message")).toContainText("缺失");
  await expect(page.locator("#asset-choose")).toBeDisabled();
  await page.locator("#asset-request").fill(JSON.stringify(request));
  await page.locator("#asset-query").click();
  const { second } = await fixtures();
  await page.route("**/api/planner/assets/choose", (route) =>
    route.fulfill({
      json: { ...second, choices: [{ key: "ground", assetId: "forged" }] },
    }),
  );
  await page.locator("#asset-choose").click();
  await expect(page.locator("#asset-message")).toContainText("失败");
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await expect(page.locator("#algorithmVersion")).toHaveValue(
    "f0-riverside-grass-v2",
  );
});
test("late inference cannot revive a draft after editing or manual generation", async ({
  page,
}) => {
  const { second } = await fixtures();
  await page.locator("#asset-request").fill(JSON.stringify(request));
  await page.locator("#asset-query").click();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let received!: () => void;
  const started = new Promise<void>((r) => (received = r));
  await page.route("**/api/planner/assets/choose", async (route) => {
    received();
    await held;
    await route.fulfill({ json: second }).catch(() => {});
  });
  await page.locator("#asset-choose").click();
  await started;
  await page
    .locator("#asset-request")
    .fill(JSON.stringify({ ...request, seed: 74 }));
  release();
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await stage(page);
  await page.locator("#asset-program-confirm").check();
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await expect(page.locator("#asset-selection")).not.toContainText(
    "river-reed-v1",
  );
});
test("corrupt new history is kept byte-for-byte while confirmation remains downloadable", async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem("wetland.assetPlans.v1", "broken history"),
  );
  await page.reload();
  await page.locator("#asset-details > summary").click();
  await expect(page.locator("#asset-storage")).toContainText("历史未载入");
  await stage(page);
  await page.locator("#asset-program-confirm").check();
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#asset-current")).toContainText("场景已显示");
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.assetPlans.v1")),
  ).toBe("broken history");
  const download = page.waitForEvent("download");
  await page.locator("#asset-save").click();
  expect((await download).suggestedFilename()).toMatch(
    /\.wetland-assets\.json$/,
  );
});
test("unsupported environment never invokes inference or changes the scene", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/planner/assets/**", (route) => {
    calls++;
    return route.abort();
  });
  await page.locator("#asset-prompt").fill("雪山");
  await page.locator("#asset-interpret").click();
  await expect(page.locator("#asset-message")).toContainText("缺失");
  expect(calls).toBe(0);
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-seed",
    "20261002",
  );
});

test("quota and build startup failure preserve the downloadable confirmation without claiming a displayed selection", async ({
  page,
}) => {
  await stage(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    window.Worker = function () {
      throw Error("injected build failure");
    } as unknown as typeof Worker;
  });
  await page.locator("#asset-program-confirm").check();
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#asset-storage")).toContainText("保存失败");
  await expect(page.locator("#asset-message")).toContainText("场景未启动");
  await expect(page.locator("#asset-current")).toContainText("无已关联选材");
  const d = page.waitForEvent("download");
  await page.locator("#asset-save").click();
  const r = JSON.parse(await readFile((await (await d).path())!, "utf8"));
  expect(r.recipe.seed).toBe(73);
});

test("old and new confirmation entries invalidate each other without rewriting old history", async ({
  page,
}) => {
  await page.locator("#plan-demo").click();
  await expect(page.locator("#plan-confirm")).toBeEnabled();
  await stage(page);
  await page.locator("#asset-program-confirm").check();
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#asset-current")).toContainText("场景已显示");
  await expect(page.locator("#plan-confirm")).toBeDisabled();
  await page.locator("#plan-demo").click();
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#plan-current")).toContainText("离线示例");
  await expect(page.locator("#asset-current")).toContainText("无已关联选材");
  const old = await page.evaluate(() =>
    localStorage.getItem("wetland.plans.v1"),
  );
  await stage(page);
  await page.locator("#asset-program-confirm").check();
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#asset-current")).toContainText("场景已显示");
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.plans.v1")),
  ).toBe(old);
});

for (const edited of [false, true]) {
  test(`review: imported first-stage provenance survives candidate refresh (edited=${edited})`, async ({
    page,
  }) => {
    const { first, second } = await fixtures();
    const original = await confirmAssetPlan(first, second, [
      "river-rock-v1",
      "river-reed-v1",
    ]);
    await page.locator("#asset-file").setInputFiles({
      name: "imported.wetland-assets.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(original)),
    });
    await expect(page.locator("#asset-message")).toContainText("历史导入");
    const req = edited ? { ...request, seed: 74 } : request;
    if (edited) await page.locator("#asset-request").fill(JSON.stringify(req));
    await page.locator("#asset-query").click();
    const next = await fixtures(req);
    await page.route("**/api/planner/assets/choose", (r) =>
      r.fulfill({ json: next.second }),
    );
    await page.locator("#asset-choose").click();
    await expect(page.locator("#asset-selection")).toContainText(
      "river-reed-v1",
    );
    await page.locator("#asset-program-confirm").check();
    await page.locator("#asset-confirm").click();
    await expect(page.locator("#asset-current")).toContainText("场景已显示");
    const record = await page
      .locator("#asset-evidence")
      .evaluate((n) => JSON.parse(n.textContent!).latestConfirmed);
    expect(record.parentId).toBe(original.id);
    expect(record.origin).toBe("imported");
    expect(record.requirements.raw).toBe(first.raw);
    expect(record.requirementsSource).toBe(edited ? "edited" : "model");
    await expect(page.locator("#asset-current")).toContainText("历史导入");
    await page.locator("#asset-prompt").fill("新的独立湿地想法");
    await page.locator("#asset-query").click();
    await page.locator("#asset-choose").click();
    await expect(page.locator("#asset-selection")).toContainText(
      "river-reed-v1",
    );
    await page.locator("#asset-program-confirm").check();
    await page.locator("#asset-confirm").click();
    await expect(page.locator("#asset-current")).not.toContainText("历史导入");
    const independent = await page
      .locator("#asset-evidence")
      .evaluate((n) => JSON.parse(n.textContent!).latestConfirmed);
    expect(independent.parentId).toBeNull();
    expect(independent.requirements).toBeNull();
    expect(independent.origin).toBe("local");
  });
}

for (const earlier of ["old", "new"] as const) {
  test(`review: ${earlier} confirmation cannot cancel a newer cross-entry intent while hashing`, async ({
    page,
  }) => {
    await stage(page);
    await page.locator("#asset-program-confirm").check();
    await page.locator("#plan-demo").click();
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      const releases: Array<() => Promise<void>> = [];
      Object.assign(window, { digestReleases: releases });
      crypto.subtle.digest = ((...args: Parameters<SubtleCrypto["digest"]>) =>
        new Promise<ArrayBuffer>((resolve) => {
          releases.push(async () => {
            resolve(await original(...args));
            await new Promise((r) => setTimeout(r, 0));
          });
          // Only hold the two confirmation hashes, not later ground integrity checks.
          if (releases.length === 2) crypto.subtle.digest = original;
        })) as SubtleCrypto["digest"];
    });
    const firstButton = earlier === "old" ? "#plan-confirm" : "#asset-confirm";
    const secondButton = earlier === "old" ? "#asset-confirm" : "#plan-confirm";
    await page.locator(firstButton).click();
    await expect(page.locator(secondButton)).toBeDisabled();
    if (earlier === "old") {
      await stage(page);
      await page.locator("#asset-program-confirm").check();
    } else await page.locator("#plan-demo").click();
    await page.locator(secondButton).click();
    await page.waitForFunction(
      () =>
        (window as unknown as { digestReleases: unknown[] }).digestReleases
          .length === 2,
    );
    await page.evaluate(async () => {
      await (
        window as unknown as { digestReleases: Array<() => Promise<void>> }
      ).digestReleases[0]();
    });
    await expect(page.locator("#status")).toHaveAttribute(
      "data-seed",
      "20261002",
    );
    expect(
      await page.evaluate(() => localStorage.getItem("wetland.assetPlans.v1")),
    ).toBeNull();
    expect(
      await page.evaluate(() => localStorage.getItem("wetland.plans.v1")),
    ).toBeNull();
    await page.evaluate(async () => {
      await (
        window as unknown as { digestReleases: Array<() => Promise<void>> }
      ).digestReleases[1]();
    });
    await expect(page.locator("#status")).toHaveAttribute(
      "data-seed",
      earlier === "old" ? "73" : "42",
    );
    await expect(
      page.locator(earlier === "old" ? "#asset-current" : "#plan-current"),
    ).toContainText(earlier === "old" ? "场景已显示" : "离线示例");
  });
}

test("acceptance A10: cancelling a pending choice never revives confirmation or changes history", async ({
  page,
}) => {
  const { second } = await fixtures();
  await page.locator("#asset-request").fill(JSON.stringify(request));
  await page.locator("#asset-query").click();
  let release!: () => void, received!: () => void, finished!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (received = r)),
    handled = new Promise<void>((r) => (finished = r));
  await page.route("**/api/planner/assets/choose", async (route) => {
    received();
    await hold;
    await route.fulfill({ json: second }).catch(() => {});
    finished();
  });
  const before = await page.locator("#scene-evidence").textContent();
  await page.locator("#asset-choose").click();
  await started;
  await page.locator("#asset-cancel").click();
  release();
  await handled;
  await expect(page.locator("#asset-message")).toContainText("已取消");
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await expect(page.locator("#asset-selection")).not.toContainText(
    "river-reed-v1",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.assetPlans.v1")),
  ).toBeNull();
  const after = JSON.parse(
    (await page.locator("#scene-evidence").textContent())!,
  );
  expect(after.recipe).toEqual(JSON.parse(before!).recipe);
});

test("acceptance A11: rapid repeated confirmation creates only one record and one scene", async ({
  page,
}) => {
  await stage(page);
  await page.locator("#asset-program-confirm").check();
  const initial = Number(
    await page.locator("#status").getAttribute("data-request-id"),
  );
  await page.locator("#asset-confirm").evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.locator("#asset-current")).toContainText("场景已显示");
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  expect(
    Number(await page.locator("#status").getAttribute("data-request-id")),
  ).toBe(initial + 1);
  const history = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("wetland.assetPlans.v1")!),
  );
  expect(history).toHaveLength(1);
  expect(history[0].recipe.seed).toBe(73);
});

test("acceptance A06: rainforest is clarified before any model request", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/planner/assets/**", (r) => {
    calls++;
    return r.abort();
  });
  await page.locator("#asset-prompt").fill("热带雨林");
  await page.locator("#asset-interpret").click();
  await expect(page.locator("#asset-message")).toContainText("需要澄清");
  await expect(page.locator("#asset-choose")).toBeDisabled();
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-seed",
    "20261002",
  );
  expect(calls).toBe(0);
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.assetPlans.v1")),
  ).toBeNull();
});

test("unresolved source returns live clarification without a model and keeps the displayed scene", async ({
  page,
}) => {
  await page
    .locator("#asset-prompt")
    .fill(
      "湿地，不是不要实拍草，但也没说必须程序草，来源还没定；只放3丛低草，不要碎石，不放水，种子91。",
    );
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/planner/assets/requirements"),
  );
  await page.locator("#asset-interpret").click();
  expect((await response).status()).toBe(400);
  await expect(page.locator("#asset-message")).toContainText("请澄清素材来源");
  await expect(page.locator("#asset-choose")).toBeDisabled();
  await expect(page.locator("#asset-confirm")).toBeDisabled();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-seed",
    "20261002",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.assetPlans.v1")),
  ).toBeNull();
});
