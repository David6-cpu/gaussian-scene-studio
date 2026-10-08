import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { selectAssets } from "../../src/selection/service";
import {
  defaultAssetRequest,
  candidateSnapshot,
} from "../../src/selection/contract";
import { LLAMA_SMALL_MODEL } from "../../src/planner/service";
import { parseCatalogContext } from "../../src/assets/catalog/context";
test.skip(
  !process.env.WETLAND_LOCAL_CATALOG,
  "Prepared-ground suite requires explicit WETLAND_LOCAL_CATALOG; synthetic fixture only.",
);
async function stage(page: Page) {
  const context = await parseCatalogContext(
    await (await page.request.get("/api/planner/assets/catalog")).json(),
  );
  const evidence = await selectAssets(
    { ...defaultAssetRequest, seed: 731 },
    async () => ({
      raw: JSON.stringify({
        choices: candidateSnapshot(defaultAssetRequest, context).map((c) => ({
          key: c.key,
          assetId: c.assetIds[0],
        })),
      }),
      model: LLAMA_SMALL_MODEL,
      done: true,
      doneReason: "stop",
    }),
    new AbortController().signal,
    context,
  );
  await page.route("**/api/planner/assets/choose", (r) =>
    r.fulfill({ json: evidence }),
  );
  await page.locator("#asset-details summary").click();
  await page.locator("#asset-request").fill(JSON.stringify(evidence.request));
  await page.locator("#asset-query").click();
  await page.locator("#asset-choose").click();
  await expect(page.locator("#asset-selection")).toContainText(
    context.prepared!.metadata.id,
  );
  await page.locator("#asset-program-confirm").check();
  return context;
}
const snapshot = (page: Page) =>
  page.evaluate(() => ({
    recipe: JSON.parse(document.querySelector("#scene-evidence")!.textContent!)
      .recipe,
    history1: localStorage.getItem("wetland.assetPlans.v1"),
    history2: localStorage.getItem("wetland.assetPlans.v2"),
    camera: (window as any).workbench.view.getCamera(),
  }));
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/harness.html?workbench=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});
test("new review flow explicitly refuses the prepared catalog without replacing its ground", async ({
  page,
}) => {
  await page.goto("/tests/harness.html?workbench=1&review=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  const before = await snapshot(page);
  await expect(page.locator("#review-status")).toContainText(
    "当前目录包含外加地表",
  );
  await expect(page.locator("#review-manual")).toBeDisabled();
  await expect(page.locator("#review-interpret")).toBeDisabled();
  await expect(page.locator("#review-preview")).toBeDisabled();
  expect(await snapshot(page)).toEqual(before);
});
test("prepared selection commits only after display and v3 reopens without asset requests", async ({
  page,
}) => {
  await stage(page);
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "731");
  await expect(page.locator("#asset-current")).toContainText("场景已显示");
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("wetland.assetPlans.v2")),
    )
    .not.toBeNull();
  expect((await snapshot(page)).history1).toBeNull();
  await expect(page.locator("#measure")).toBeDisabled();
  const download = page.waitForEvent("download");
  await page.locator("#save").click();
  const path = (await (await download).path())!;
  const before = await snapshot(page);
  const original = await readFile(path);
  await page.waitForTimeout(180);
  const beforeImage = await page.locator("canvas").screenshot();
  await page.route("**/api/planner/assets/package/**", (r) => r.abort());
  await page.route("**/assets/**", (r) => r.abort());
  await page.locator("#bundle-file").setInputFiles(path);
  await expect(page.locator("#status")).toContainText("已导入");
  expect((await snapshot(page)).recipe).toEqual(before.recipe);
  await page.waitForTimeout(180);
  const afterImage = await page.locator("canvas").screenshot();
  expect(PNG.sync.read(afterImage).data).toEqual(
    PNG.sync.read(beforeImage).data,
  );
  expect(await readFile(path)).toEqual(original);
  if (process.env.REVIEW_VISUAL_DIR) {
    const dir = process.env.REVIEW_VISUAL_DIR;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/legacy-v3-before.png`, beforeImage);
    await writeFile(`${dir}/legacy-v3-after.png`, afterImage);
    await writeFile(`${dir}/legacy-v3.zip`, original);
    await writeFile(
      `${dir}/legacy-v3.json`,
      JSON.stringify(
        {
          zipVersion: 3,
          sha256: createHash("sha256").update(original).digest("hex"),
          camera: before.camera,
          pixelDifference: 0,
          basis:
            "Synthetic prepared-ground archive, compatibility only, not a qualified real asset",
        },
        null,
        2,
      ),
    );
  }
});
for (const failure of ["404", "corrupt", "ext", "mesh", "display"] as const)
  test(`${failure} preserves committed scene, camera, archive and histories`, async ({
    page,
  }) => {
    const before = await snapshot(page);
    await stage(page);
    if (failure === "404")
      await page.route("**/api/planner/assets/package/**", (r) =>
        r.fulfill({ status: 404 }),
      );
    if (failure === "corrupt")
      await page.route("**/api/planner/assets/package/**", async (r) => {
        const response = await r.fetch(),
          b = await response.body();
        b[100] ^= 1;
        await r.fulfill({ body: b });
      });
    if (failure === "ext" || failure === "mesh")
      await page.evaluate(
        (f) => (window as any).sparkProbe.failInitialization(f),
        failure,
      );
    if (failure === "display")
      await page.evaluate(() => {
        (window as any).workbench.view.isCurrentSceneDisplayed = () => false;
      });
    await page.locator("#asset-confirm").click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "error",
      { timeout: 18000 },
    );
    expect(await snapshot(page)).toEqual(before);
    await expect(page.locator("#asset-save")).toBeDisabled();
    const d = page.waitForEvent("download");
    await page.locator("#save").click();
    expect((await readFile((await (await d).path())!)).length).toBeGreaterThan(
      1000,
    );
  });
test("cancel during fetching and newer generation prevent late commit", async ({
  page,
}) => {
  const before = await snapshot(page);
  await stage(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/planner/assets/package/**", async (r) => {
    await gate;
    await r.continue().catch(() => {});
  });
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "building",
  );
  await page.locator("#cancel").click();
  release();
  expect(await snapshot(page)).toEqual(before);
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  expect((await snapshot(page)).recipe.schemaVersion).toBe(1);
});
test("quota failure keeps prior bytes while displayed v2 record remains downloadable", async ({
  page,
}) => {
  await stage(page);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "wetland.assetPlans.v2") throw Error("quota");
      set.call(this, k, v);
    };
  });
  await page.locator("#asset-confirm").click();
  await expect(page.locator("#asset-current")).toContainText("场景已显示");
  await expect(page.locator("#asset-storage")).toContainText("quota");
  expect((await snapshot(page)).history2).toBeNull();
  await expect(page.locator("#asset-save")).toBeEnabled();
});

for (const kind of ["packed", "ext", "mesh"] as const)
  test(`cancel at ${kind} initialization frees temporary resources and a newer scene wins`, async ({
    page,
  }) => {
    const before = await snapshot(page),
      live = await page.evaluate(() => window.sparkProbe.snapshot().live);
    await stage(page);
    await page.evaluate((k) => window.sparkProbe.pauseInitialization(k), kind);
    await page.locator("#asset-confirm").click();
    await expect
      .poll(() =>
        page.evaluate(() => window.sparkProbe.snapshot().initializationHeld),
      )
      .toBe(true);
    expect((await snapshot(page)).recipe).toEqual(before.recipe);
    await page.locator("#cancel").click();
    await page.evaluate(() => window.sparkProbe.resumeInitialization());
    await expect
      .poll(() => page.evaluate(() => window.sparkProbe.snapshot().live))
      .toEqual(live);
    expect(await snapshot(page)).toEqual(before);
    await page.locator("#generate").click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    expect((await snapshot(page)).recipe.schemaVersion).toBe(1);
  });
test("context loss during tentative display retains the old CPU scene and restores it", async ({
  page,
}) => {
  const before = await snapshot(page);
  await stage(page);
  await page.evaluate(() => {
    (window as any).workbench.view.isCurrentSceneDisplayed = () => false;
  });
  await page.locator("#asset-confirm").click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).workbench.view.stats().ground.id),
    )
    .toBe("test-prepared-ground");
  await page.evaluate(() => {
    const ext = document
      .querySelector("canvas")!
      .getContext("webgl2")!
      .getExtension("WEBGL_lose_context")!;
    (window as any).loss = ext;
    ext.loseContext();
  });
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "context-lost",
  );
  expect((await snapshot(page)).recipe).toEqual(before.recipe);
  await page.evaluate(() => (window as any).loss.restoreContext());
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  expect((await snapshot(page)).recipe).toEqual(before.recipe);
  expect((await snapshot(page)).history2).toBe(before.history2);
});
test("download URLs are revoked on click failure, delayed completion and unload", async ({
  page,
}) => {
  await page.evaluate(() => {
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL,
      a = HTMLAnchorElement.prototype.click;
    (window as any).urls = { created: 0, revoked: 0 };
    URL.createObjectURL = (b) => {
      (window as any).urls.created++;
      return create(b);
    };
    URL.revokeObjectURL = (u) => {
      (window as any).urls.revoked++;
      revoke(u);
    };
    HTMLAnchorElement.prototype.click = function () {
      HTMLAnchorElement.prototype.click = a;
      throw Error("injected click failure");
    };
  });
  await page.locator("#save").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).urls))
    .toEqual({ created: 1, revoked: 1 });
  const d = page.waitForEvent("download");
  await page.locator("#save").click();
  await d;
  await expect
    .poll(() => page.evaluate(() => (window as any).urls), { timeout: 8000 })
    .toEqual({ created: 2, revoked: 2 });
  const next = page.waitForEvent("download");
  await page.locator("#save").click();
  await next;
  await page.evaluate(() => window.dispatchEvent(new Event("beforeunload")));
  expect(await page.evaluate(() => (window as any).urls)).toEqual({
    created: 3,
    revoked: 3,
  });
});
