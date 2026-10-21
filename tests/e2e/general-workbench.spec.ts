import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync, zipSync } from "fflate";
import { createCatalogView } from "../../src/general-scene/asset-library";
import {
  createWorkbenchFixture,
  observeWorkbenchErrors,
  installWorkbenchFixture,
  installWorkbenchDrawObservation,
  readWorkbenchDatabase,
  readWorkbenchStoredMetadata,
  workbenchPrompts,
  type WorkbenchScenario,
} from "../support/general-workbench-fixture";

test.use({ video: "on" });

const browserErrors = new WeakMap<
  Page,
  ReturnType<typeof observeWorkbenchErrors>
>();
test.beforeEach(async ({ page }) => {
  browserErrors.set(page, observeWorkbenchErrors(page));
});
test.afterEach(async ({ page }, info) => {
  const log = browserErrors.get(page);
  await info.attach("actual-browser-errors", {
    body: JSON.stringify(log, null, 2),
    contentType: "application/json",
  });
  expect(log?.pageErrors ?? []).toEqual([]);
});

async function openWorkbench(
  page: Page,
  scenario: WorkbenchScenario = "dry",
  redistributable = true,
  unusedVariant = false,
) {
  const fixture = await createWorkbenchFixture({
    redistributable,
    unusedVariant,
  });
  const trace = await installWorkbenchFixture(page, fixture, scenario);
  await page.goto("/tests/harness.html?workbench=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(
    page.getByRole("region", { name: "生成自然场景", exact: true }),
  ).toBeVisible();
  return { fixture, trace };
}
async function plan(page: Page, scenario: WorkbenchScenario = "dry") {
  await page.locator("#general-prompt").fill(workbenchPrompts[scenario]);
  await page.locator("#general-plan").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "awaiting-review",
  );
}
async function confirmAndPreview(page: Page) {
  const choices = page.locator("#general-scene-panel input[data-slot]");
  await expect(choices).toHaveCount(3);
  for (const choice of await choices.all()) await choice.check();
  await page.locator("#general-review").click();
  await expect(page.locator("#general-preview")).toBeEnabled();
  await page.locator("#general-preview").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "previewing",
  );
  await expect(page.locator("#general-scene-canvas")).toBeVisible();
  await expect(page.locator("#general-use")).toBeEnabled();
}

test("ordinary homepage exposes natural-scene planning without engineering flags", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(
    page.getByRole("region", { name: "生成自然场景", exact: true }),
  ).toBeVisible({ timeout: 3000 });
});

test("constructed planning requires each procedural role and only actual use saves a draft", async ({
  page,
}, info) => {
  const { trace } = await openWorkbench(page);
  await plan(page);
  const choices = page.locator("#general-scene-panel input[data-slot]");
  await expect(choices).toHaveCount(3);
  for (const choice of await choices.all())
    await expect(choice).not.toBeChecked();
  await expect(page.locator("#general-preview")).toBeDisabled();
  await expect(page.locator("#general-summary")).toContainText("无水");
  await expect(page.locator("#general-summary")).toContainText("石头");
  expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
  await confirmAndPreview(page);
  expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
  await info.attach("constructed-preview-not-visual-acceptance", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.locator("#general-use").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "committed",
  );
  const db = await readWorkbenchDatabase(page);
  expect(db.scenes).toHaveLength(1);
  expect(db.revisions).toHaveLength(1);
  expect(db.revisions[0]).toEqual(
    expect.objectContaining({ status: "committed", reviewStatus: "draft" }),
  );
  expect(db.operations).toHaveLength(1);
  const stored = await readWorkbenchStoredMetadata(page);
  expect(stored.snapshot.intent.raw).toBe(workbenchPrompts.dry);
  expect(stored.snapshot.water.mode).toBe("none");
  expect(
    stored.snapshot.surfaces.some(
      (surface: { role: string }) => surface.role === "water",
    ),
  ).toBe(false);
  expect(
    stored.snapshot.modelEvidence.every(
      (e: { provenance: string }) => e.provenance === "constructed",
    ),
  ).toBe(true);
  expect(
    stored.snapshot.instances
      .map((item: { groupId: string }) => item.groupId)
      .sort(),
  ).toEqual(["grass", "rock"]);
  await expect(page.locator("#general-quality")).toContainText(
    /待验收|pending|未验收/,
  );
  expect(trace.planning).toHaveLength(1);
  await info.attach("actual-native-records", {
    body: JSON.stringify(db, null, 2),
    contentType: "application/json",
  });
});

test("revoking a procedural role after review invalidates preview until an explicit new review", async ({
  page,
}) => {
  await openWorkbench(page);
  await plan(page);
  const choices = page.locator("#general-scene-panel input[data-slot]");
  for (const choice of await choices.all()) await choice.check();
  await page.locator("#general-review").click();
  await expect(page.locator("#general-preview")).toBeEnabled();
  await choices.first().uncheck();
  await expect(page.locator("#general-preview")).toBeDisabled();
  await expect(page.locator("#general-use")).toBeDisabled();
  await choices.first().check();
  await expect(page.locator("#general-preview")).toBeDisabled();
  expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
  await page.locator("#general-review").click();
  await expect(page.locator("#general-preview")).toBeEnabled();
  await page.locator("#general-preview").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "previewing",
  );
});

test("global replan consent can be revoked and any structural edit requires fresh global consent", async ({
  page,
}) => {
  await saveConstructedScene(page);
  const saved = await readWorkbenchDatabase(page);
  await plan(page);
  const global = page.locator("#general-global-accept");
  await expect(global).not.toBeChecked();
  for (const choice of await page
    .locator("#general-scene-panel input[data-slot]")
    .all())
    await choice.check();
  await global.check();
  await page.locator("#general-review").click();
  await expect(page.locator("#general-preview")).toBeEnabled();
  await global.uncheck();
  await expect(page.locator("#general-preview")).toBeDisabled();
  await global.check();
  await expect(page.locator("#general-preview")).toBeDisabled();
  await page.locator("#general-review").click();
  await expect(page.locator("#general-preview")).toBeEnabled();
  await page.getByText("地形与水体参数", { exact: true }).click();
  await page.locator("#general-seed").fill("817");
  await expect(global).not.toBeChecked();
  await expect(page.locator("#general-preview")).toBeDisabled();
  expect((await readWorkbenchDatabase(page)).scenes).toEqual(saved.scenes);
});

test("changing the description invalidates the displayed unsaved candidate and consent", async ({
  page,
}) => {
  await openWorkbench(page);
  await plan(page);
  await confirmAndPreview(page);
  await page.locator("#general-prompt").fill("新的描述：平坦场地，不要水。");
  await expect(page.locator("#general-use")).toBeDisabled();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "idle",
  );
  expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
  for (const choice of await page
    .locator("#general-scene-panel input[data-slot]")
    .all())
    await expect(choice).not.toBeChecked();
});

test("unspecified water stays visibly distinct from an explicit dry requirement", async ({
  page,
}) => {
  await openWorkbench(page, "unspecified");
  await plan(page, "unspecified");
  await expect(page.locator("#general-summary")).toContainText(
    /未说明|未提及|未指定/,
  );
  await expect(page.locator("#general-water-mode")).toHaveValue("unspecified");
  await expect(page.locator("#general-use")).toBeDisabled();
  expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
});

test("model suggested grass quantity is visible separately from hard user rock quantity", async ({
  page,
}) => {
  await openWorkbench(page, "suggestions");
  await plan(page, "suggestions");
  await expect(page.locator("#general-summary")).toContainText("建议");
  await expect(page.locator('[data-group-count="rock"]')).toHaveValue("1");
  await expect(page.locator('[data-group-count="grass"]')).toHaveValue("4");
  await expect(page.locator("#general-use")).toBeDisabled();
});

for (const scenario of ["trees", "metric", "left"] as const) {
  test(`constructed ${scenario} requirement remains blocked with its specific gap`, async ({
    page,
  }) => {
    await openWorkbench(page, scenario);
    await plan(page, scenario);
    const pattern =
      scenario === "trees"
        ? /树|tree/
        : scenario === "metric"
          ? /米制|展示单位/
          : /左右|方向/;
    await expect(page.locator("#general-summary")).toContainText(pattern);
    await expect(page.locator("#general-use")).toBeDisabled();
    await expect(page.locator("#general-preview")).toBeDisabled();
    await expect(page.locator("#general-prompt")).toHaveValue(
      workbenchPrompts[scenario],
    );
    expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
  });
}

test("empty manual entry explains the required description without planning, drawing or saving", async ({
  page,
}, info) => {
  const { trace } = await openWorkbench(page);
  const before = await page.evaluate(() =>
    (window as any).workbench.general.diagnostics(),
  );
  await expect(page.locator("#general-prompt")).toHaveValue("");
  await page.locator("#general-manual").click();
  await expect(page.locator("#general-message")).toHaveText(
    "请先填写场景描述，再设置手工参数。",
  );
  await expect(page.locator("#general-prompt")).toBeFocused();
  await expect(page.locator("#general-prompt-help")).toContainText(/手工/);
  expect(trace.planning).toHaveLength(0);
  expect(trace.catalog).toBe(0);
  expect(trace.members).toBe(0);
  const after = await page.evaluate(() =>
    (window as any).workbench.general.diagnostics(),
  );
  expect(after.frames).toBe(before.frames);
  expect(after.view).toBeNull();
  expect(after.lease.running).toBeNull();
  expect(after.lease.queued).toBe(0);
  const db = await readWorkbenchDatabase(page);
  expect(db.scenes).toHaveLength(0);
  expect(db.revisions).toHaveLength(0);
  expect(db.operations).toHaveLength(0);
  await info.attach("empty-manual-actual-observations", {
    body: JSON.stringify({ before, after, trace, db }),
    contentType: "application/json",
  });
});

test("model offline retains the description and exposes an explicitly manual route", async ({
  page,
}) => {
  const { trace } = await openWorkbench(page);
  await page.route("**/api/planner/general/plan", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Constructed offline service failure" },
    }),
  );
  await page.locator("#general-prompt").fill(workbenchPrompts.dry);
  await page.locator("#general-plan").click();
  await expect(page.locator("#general-summary")).toContainText(
    /手工|未完成|离线|失败|offline/i,
  );
  // A parse with nothing to review keeps the previous scene on screen.
  await expect(page.locator("body")).not.toHaveClass(/general-mode/);
  await expect(page.getByLabel("湿地高斯场景")).toBeVisible();
  await expect(page.locator("#general-message")).toContainText(
    "旧场景保持不变",
  );
  await expect(page.locator("#general-prompt")).toHaveValue(
    workbenchPrompts.dry,
  );
  await expect(page.locator("#general-use")).toBeDisabled();
  await page.locator("#general-manual").click();
  await expect(page.locator("#general-scene-panel")).toContainText(
    "手工设置，未验证原句完整覆盖",
  );
  await page.locator("#general-water-mode").selectOption("none");
  await page.locator("#general-style").selectOption({ index: 1 });
  for (const category of ["rock", "grass"]) {
    await page.locator("#general-add-role").click();
    const row = page.locator("#general-manual-roles fieldset").last();
    await row.locator("[data-manual-category]").selectOption(category);
    await row.locator("[data-manual-count]").fill("1");
    await row.locator("[data-manual-source]").selectOption("procedural");
  }
  await page.locator("#general-manual-prepare").click();
  await confirmAndPreview(page);
  expect(trace.planning).toHaveLength(0);
  expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
});

async function openStorageControls(page: Page) {
  const section = page
    .locator("#general-scene-panel details")
    .filter({ has: page.locator("#general-scenes") });
  if (!(await section.evaluate((element: HTMLDetailsElement) => element.open)))
    await section.locator(":scope > summary").click();
}
async function saveConstructedScene(
  page: Page,
  redistributable = true,
  unusedVariant = false,
) {
  const ready = await openWorkbench(
    page,
    "dry",
    redistributable,
    unusedVariant,
  );
  await plan(page);
  await confirmAndPreview(page);
  await page.locator("#general-use").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "committed",
  );
  await expect(page.locator("#general-edit")).toBeVisible();
  return ready;
}
async function exportBytes(page: Page, mode: "reference" | "embedded") {
  await openStorageControls(page);
  const pending = page.waitForEvent("download");
  await page.locator(`#general-export-${mode}`).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw Error("Actual export download is missing");
  await expect(page.locator("#general-list")).toBeEnabled();
  return readFile(path);
}

test("license limitations keep embedded export disabled while reference dependencies remain explicit", async ({
  page,
}, info) => {
  await saveConstructedScene(page, false);
  await openStorageControls(page);
  await expect(page.locator("#general-dependencies")).toContainText(
    "不可随包分发",
  );
  await expect(page.locator("#general-dependencies")).toContainText(
    "相同内容版本",
  );
  await expect(page.locator("#general-export-embedded")).toBeDisabled();
  const bytes = await exportBytes(page, "reference");
  const manifest = JSON.parse(
    new TextDecoder().decode(unzipSync(bytes)["manifest.json"]),
  );
  expect(manifest.mode).toBe("reference");
  expect(manifest.document.snapshot.reviewStatus).toBe("draft");
  expect(
    manifest.document.snapshot.assets.every(
      (a: any) => a.manifest.provenance.license.redistributable === false,
    ),
  ).toBe(true);
  await info.attach("constructed-reference-package", {
    body: bytes,
    contentType: "application/zip",
  });
});

test("reference import with missing exact dependencies is readonly and preserves original bytes", async ({
  page,
}, info) => {
  await saveConstructedScene(page);
  const bytes = await exportBytes(page, "reference");
  const isolated = await page
    .context()
    .browser()!
    .newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const imported = await isolated.newPage();
    const empty = await createCatalogView([], []);
    await imported.route("**/api/planner/general/catalog", (route) =>
      route.fulfill({ json: empty }),
    );
    await imported.goto("http://127.0.0.1:4173/");
    await expect(imported.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await openStorageControls(imported);
    await imported.locator("#general-import").setInputFiles({
      name: "constructed-reference.zip",
      mimeType: "application/zip",
      buffer: bytes,
    });
    await expect(imported.locator("#general-current")).toContainText("只读");
    await expect(imported.locator("#general-use")).toBeDisabled();
    await expect(imported.locator("#general-edit")).toBeHidden();
    expect((await readWorkbenchDatabase(imported)).scenes).toHaveLength(0);
    const download = imported.waitForEvent("download");
    await imported
      .locator("#general-original")
      .getByRole("button", { name: "下载导入原件" })
      .click();
    const original = await download;
    expect(await readFile((await original.path())!)).toEqual(bytes);
    await info.attach("missing-dependencies-readonly", {
      body: await imported.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await isolated.close();
  }
});

test("unknown archive version rejects editing and downloads the exact original without changing saved pointer", async ({
  page,
}) => {
  await saveConstructedScene(page);
  const before = await readWorkbenchDatabase(page);
  const bytes = await exportBytes(page, "reference");
  const files = unzipSync(bytes);
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  manifest.formatVersion = 99;
  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));
  const unknown = Buffer.from(zipSync(files, { level: 0 }));
  await page.locator("#general-import").setInputFiles({
    name: "constructed-future.zip",
    mimeType: "application/zip",
    buffer: unknown,
  });
  await expect(page.locator("#general-current")).toContainText("未知版本");
  await expect(page.locator("#general-use")).toBeDisabled();
  expect((await readWorkbenchDatabase(page)).scenes).toEqual(before.scenes);
  const download = page.waitForEvent("download");
  await page
    .locator("#general-original")
    .getByRole("button", { name: "下载导入原件" })
    .click();
  const original = await download;
  expect(await readFile((await original.path())!)).toEqual(unknown);
});

test.describe("recorded technical workflow — constructed assets and model only", () => {
  test("saved scene reopens offline, reviews local R/H, saves, exports and undoes without reinterpreting", async ({
    page,
    context,
  }, info) => {
    test.setTimeout(90000);
    const started = Date.now();
    const { trace } = await saveConstructedScene(page);
    const first = await readWorkbenchStoredMetadata(page);
    const source = first.snapshot;
    const initialDatabase = await readWorkbenchDatabase(page);
    await page.reload();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await page.unroute("**/api/planner/general/catalog");
    await page.unroute("**/api/planner/general/assets/**");
    await page.unroute("**/api/planner/general/plan");
    await context.setOffline(true);
    try {
      expect(
        await page.evaluate(() =>
          fetch("/api/planner/general/catalog").then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      await openStorageControls(page);
      await page.locator("#general-list").click();
      await expect(
        page.locator("#general-scenes button[data-scene-id]"),
      ).toHaveCount(1);
      await page.locator("#general-scenes button[data-scene-id]").click();
      await expect(page.locator("#general-edit")).toBeVisible();
      await expect(page.locator("#general-scene-canvas")).toBeVisible();
      expect((await readWorkbenchStoredMetadata(page)).digest).toBe(
        first.digest,
      );
      const removed = source.instances.find((i: any) => i.groupId === "rock");
      const [x, , z] = removed.transform.position;
      const minX = Math.max(-2, x - 0.4),
        maxX = Math.min(2, x + 0.4),
        minZ = Math.max(-2, z - 0.4),
        maxZ = Math.min(2, z + 0.4);
      await page.locator("#general-edit-kind").selectOption("remove");
      await page
        .locator("#general-edit-instance")
        .selectOption(removed.instanceId);
      await page
        .locator("#general-edit-description")
        .fill("只删除指定石头，其余内容保持");
      await page
        .locator("#general-edit-region")
        .fill(
          `${minX} ${minZ}\n${maxX} ${minZ}\n${maxX} ${maxZ}\n${minX} ${maxZ}`,
        );
      await page.locator("#general-propose").click();
      await expect(page.locator("#general-scope")).toContainText("请求区域 R");
      await expect(page.locator("#general-scope")).toContainText(
        "实际影响区域 H",
      );
      await expect(page.locator("#general-scope")).toContainText("变化对象");
      await expect(page.locator("#general-patch-preview")).toBeDisabled();
      expect((await readWorkbenchDatabase(page)).scenes).toEqual(
        initialDatabase.scenes,
      );
      await info.attach("actual-local-scope-before-consent", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.locator("#general-scope-accept").check();
      await page.locator("#general-patch-preview").click();
      await expect(page.locator("#general-status")).toHaveAttribute(
        "data-phase",
        "previewing",
      );
      expect((await readWorkbenchDatabase(page)).scenes).toEqual(
        initialDatabase.scenes,
      );
      await page.locator("#general-use").click();
      await expect(page.locator("#general-status")).toHaveAttribute(
        "data-phase",
        "committed",
      );
      const edited = await readWorkbenchStoredMetadata(page);
      expect(edited.snapshot.instances).toEqual(
        source.instances.filter(
          (i: any) => i.instanceId !== removed.instanceId,
        ),
      );
      expect(edited.snapshot.state.tombstones).toContain(removed.instanceId);
      expect(edited.snapshot.patch.review.scopeAccepted).toBe(true);
      expect(edited.buffers).toEqual(first.buffers);
      expect(edited.snapshot.reviewStatus).toBe("draft");
      const bytes = await exportBytes(page, "embedded");
      const exported = JSON.parse(
        new TextDecoder().decode(unzipSync(bytes)["manifest.json"]),
      );
      expect(exported.mode).toBe("embedded");
      expect(exported.document.snapshot.state.tombstones).toContain(
        removed.instanceId,
      );
      await page.locator("#general-undo").click();
      await expect(page.locator("#general-status")).toHaveAttribute(
        "data-phase",
        "committed",
      );
      expect((await readWorkbenchStoredMetadata(page)).digest).toBe(
        first.digest,
      );
      expect((await readWorkbenchDatabase(page)).scenes).toEqual(
        initialDatabase.scenes,
      );
      expect(trace.planning).toHaveLength(1);
      await info.attach("actual-offline-local-metadata", {
        body: JSON.stringify({ first, edited }, null, 2),
        contentType: "application/json",
      });
      // A real continuous browser recording, with interactive inspection; no visual/performance acceptance claim.
      const canvas = page.locator("#general-scene-canvas");
      await canvas.scrollIntoViewIfNeeded();
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width * 0.7,
        box.y + box.height * 0.55,
        { steps: 20 },
      );
      await page.mouse.up();
      if (Date.now() - started < 32000)
        await page.waitForTimeout(32000 - (Date.now() - started));
      await info.attach("technical-workflow-final-not-visual-acceptance", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    } finally {
      await context.setOffline(false);
    }
  });
});

test("ordinary local-edit controls preserve scope, locks and stable identities across all supported operations", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const { fixture, trace } = await saveConstructedScene(page, true, true);
  let parent = await readWorkbenchStoredMetadata(page);
  const initial = parent;
  const observations: unknown[] = [];
  const rockId = parent.snapshot.instances.find(
    (i: any) => i.groupId === "rock",
  ).instanceId;
  const grass = parent.snapshot.instances.find(
    (i: any) => i.groupId === "grass",
  );
  const variant = fixture.catalog.manifests.find((m) =>
    m.id.endsWith("-variant"),
  )!;
  const variantRef = { id: variant.id, contentVersion: variant.contentVersion };
  expect(
    parent.snapshot.assets.some((a: any) => a.assetRef.id === variant.id),
  ).toBe(false);
  expect(trace.memberRefs.some((r) => r.id === variant.id)).toBe(false);
  const fullRegion = "-2 -2\n2 -2\n2 2\n-2 2";
  async function propose(options: {
    kind: string;
    instanceId?: string;
    groupId?: string;
    x?: number;
    z?: number;
    asset?: string;
    count?: number;
    region?: string;
    radius?: number;
    delta?: number;
  }) {
    await expect(page.locator("#general-edit")).toBeVisible();
    await page.locator("#general-edit-kind").selectOption(options.kind);
    if (options.instanceId)
      await page
        .locator("#general-edit-instance")
        .selectOption(options.instanceId);
    if (options.groupId)
      await page.locator("#general-edit-group").selectOption(options.groupId);
    if (options.x !== undefined)
      await page.locator("#general-edit-x").fill(String(options.x));
    if (options.z !== undefined)
      await page.locator("#general-edit-z").fill(String(options.z));
    if (options.asset)
      await page.locator("#general-edit-asset").selectOption(options.asset);
    if (options.count !== undefined)
      await page.locator("#general-edit-count").fill(String(options.count));
    if (options.radius !== undefined)
      await page.locator("#general-brush-radius").fill(String(options.radius));
    if (options.delta !== undefined)
      await page.locator("#general-brush-delta").fill(String(options.delta));
    await page
      .locator("#general-edit-region")
      .fill(options.region ?? fullRegion);
    await page
      .locator("#general-edit-description")
      .fill(`构造软件夹具：用户明确${options.kind}`);
    if (options.kind === "replace" || options.kind === "add") {
      await expect(page.locator("#general-edit-procedural")).not.toBeChecked();
      await page.locator("#general-edit-procedural").check();
    }
    await page.locator("#general-propose").click();
  }
  async function previewAndSave(kind: string) {
    await expect(page.locator("#general-scope")).toBeVisible();
    await expect(page.locator("#general-scope-accept")).not.toBeChecked();
    await expect(page.locator("#general-patch-preview")).toBeDisabled();
    const proposed = JSON.parse(
      (await page.locator("#general-evidence").textContent())!,
    );
    const before = parent;
    await page.locator("#general-scope-accept").check();
    await page.locator("#general-patch-preview").click();
    await expect(page.locator("#general-status")).toHaveAttribute(
      "data-phase",
      "previewing",
    );
    expect((await readWorkbenchStoredMetadata(page)).digest).toBe(
      before.digest,
    );
    await page.locator("#general-use").click();
    await expect(page.locator("#general-status")).toHaveAttribute(
      "data-phase",
      "committed",
    );
    await expect(page.locator("#general-edit")).toBeVisible();
    parent = await readWorkbenchStoredMetadata(page);
    expect(parent.snapshot.parentRevisionId).toBe(before.snapshot.revisionId);
    expect(parent.snapshot.patch.review.scopeAccepted).toBe(true);
    const unchanged = before.snapshot.instances.filter(
      (i: any) => !proposed.changedInstanceIds.includes(i.instanceId),
    );
    for (const instance of unchanged) {
      const kept = parent.snapshot.instances.find(
        (i: any) => i.instanceId === instance.instanceId,
      );
      expect(kept).toBeDefined();
      expect({
        id: kept.instanceId,
        ref: kept.assetRef,
        transform: kept.transform,
      }).toEqual({
        id: instance.instanceId,
        ref: instance.assetRef,
        transform: instance.transform,
      });
    }
    if (kind !== "brush") expect(parent.buffers).toEqual(before.buffers);
    expect(
      parent.snapshot.instances.find(
        (i: any) => i.instanceId === grass.instanceId,
      ).transform,
    ).toEqual(grass.transform);
    expect(parent.snapshot.reviewStatus).toBe("draft");
    observations.push({
      kind,
      proposal: proposed,
      revision: parent.snapshot.revisionId,
      instances: parent.snapshot.instances,
      state: parent.snapshot.state,
      geometryDigest: parent.snapshot.geometryDigest,
    });
  }
  const rock = parent.snapshot.instances.find(
    (i: any) => i.instanceId === rockId,
  );
  const destination = [
    [0.25, 0],
    [-0.25, 0],
    [0, 0.25],
    [0, -0.25],
    [0.25, 0.25],
    [0.25, -0.25],
    [-0.25, 0.25],
    [-0.25, -0.25],
  ]
    .map(([dx, dz]) => [
      rock.transform.position[0] + dx,
      rock.transform.position[2] + dz,
    ])
    .find(
      ([x, z]) =>
        Math.abs(x) < 1.7 &&
        Math.abs(z) < 1.7 &&
        Math.hypot(
          x - grass.transform.position[0],
          z - grass.transform.position[2],
        ) > 0.4,
    );
  expect(
    destination,
    "constructed scene must have a valid bounded move for this UI sequence",
  ).toBeDefined();
  const [mx, mz] = destination!;
  const x0 = Math.max(-2, Math.min(mx, rock.transform.position[0]) - 0.3),
    x1 = Math.min(2, Math.max(mx, rock.transform.position[0]) + 0.3),
    z0 = Math.max(-2, Math.min(mz, rock.transform.position[2]) - 0.3),
    z1 = Math.min(2, Math.max(mz, rock.transform.position[2]) + 0.3);
  await page.locator(`[data-lock-instance="${grass.instanceId}"]`).check();
  await propose({
    kind: "move",
    instanceId: rockId,
    x: mx,
    z: mz,
    region: `${x0} ${z0}\n${x1} ${z0}\n${x1} ${z1}\n${x0} ${z1}`,
  });
  await previewAndSave("move");
  expect(
    parent.snapshot.instances.find((i: any) => i.instanceId === rockId)
      .transform.position[0],
  ).toBeCloseTo(mx, 8);
  // Select an admitted same-category variant absent from the saved dependencies and browser cache.
  const movedTransform = structuredClone(
    parent.snapshot.instances.find((i: any) => i.instanceId === rockId)
      .transform,
  );
  await page.locator("#general-edit-instance").selectOption(rockId);
  const refOption = await page
    .locator("#general-edit-asset option")
    .evaluateAll(
      (options, id) =>
        (options as HTMLOptionElement[]).find((option) =>
          option.value.includes(String(id)),
        )?.value,
      variantRef.id,
    );
  expect(refOption).toBeTruthy();
  await propose({ kind: "replace", instanceId: rockId, asset: refOption! });
  await previewAndSave("replace");
  expect(
    parent.snapshot.instances.find((i: any) => i.instanceId === rockId)
      .assetRef,
  ).toEqual(variantRef);
  expect(
    parent.snapshot.instances.find((i: any) => i.instanceId === rockId)
      .transform,
  ).toEqual(movedTransform);
  expect(
    trace.memberRefs.some(
      (r) => r.id === variant.id && r.contentVersion === variant.contentVersion,
    ),
  ).toBe(true);
  await propose({ kind: "add", groupId: "rock", asset: refOption!, count: 1 });
  await previewAndSave("add");
  const added = parent.snapshot.instances.find(
    (i: any) => i.groupId === "rock" && i.instanceId !== rockId,
  ).instanceId;
  await propose({ kind: "set-count", groupId: "rock", count: 1 });
  await previewAndSave("set-count");
  expect(parent.snapshot.state.tombstones).toContain(added);
  await openStorageControls(page);
  await page.locator("#general-scenes button[data-scene-id]").click();
  await expect(page.locator("#general-edit")).toBeVisible();
  await propose({ kind: "add", groupId: "rock", asset: refOption!, count: 1 });
  await previewAndSave("add-after-reopen");
  expect(
    parent.snapshot.instances.some((i: any) => i.instanceId === added),
  ).toBe(false);
  expect(parent.snapshot.state.tombstones).toContain(added);
  const center = [
    [-1.3, -1.3],
    [-1.3, 1.3],
    [1.3, -1.3],
    [1.3, 1.3],
  ].sort(
    (a, b) =>
      Math.min(
        ...parent.snapshot.instances.map((i: any) =>
          Math.hypot(
            b[0] - i.transform.position[0],
            b[1] - i.transform.position[2],
          ),
        ),
      ) -
      Math.min(
        ...parent.snapshot.instances.map((i: any) =>
          Math.hypot(
            a[0] - i.transform.position[0],
            a[1] - i.transform.position[2],
          ),
        ),
      ),
  )[0];
  const [bx, bz] = center;
  const previousGeometry = parent.snapshot.geometryDigest;
  await propose({
    kind: "brush",
    x: bx,
    z: bz,
    radius: 0.2,
    delta: 0.05,
    region: `${bx - 0.2} ${bz - 0.2}\n${bx + 0.2} ${bz - 0.2}\n${bx + 0.2} ${bz + 0.2}\n${bx - 0.2} ${bz + 0.2}`,
  });
  await previewAndSave("brush");
  expect(parent.snapshot.geometryDigest).not.toBe(previousGeometry);
  expect(parent.snapshot.state.brushes).toHaveLength(1);
  const beforeLockedFailure = parent.digest;
  await propose({ kind: "remove", instanceId: grass.instanceId });
  await expect(page.locator("#general-message")).toContainText(/锁|lock/i);
  await expect(page.locator("#general-use")).toBeDisabled();
  expect((await readWorkbenchStoredMetadata(page)).digest).toBe(
    beforeLockedFailure,
  );
  const currentText = await page.locator("#general-current").innerText(),
    qualityText = await page.locator("#general-quality").innerText();
  await propose({ kind: "remove", instanceId: rockId });
  await expect(page.locator("#general-scope")).toBeVisible();
  await page.locator("#general-scope-accept").check();
  await page.locator("#general-patch-preview").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "previewing",
  );
  await page.locator("#general-cancel").click();
  await expect(page.locator("#general-current")).toHaveText(currentText, {
    useInnerText: true,
  });
  await expect(page.locator("#general-quality")).toHaveText(qualityText, {
    useInnerText: true,
  });
  await expect(page.locator("#general-edit")).toBeVisible();
  expect((await readWorkbenchStoredMetadata(page)).digest).toBe(parent.digest);
  await info.attach("all-ui-edit-operations-actual-records", {
    body: JSON.stringify(
      { initial: initial.snapshot, observations, final: parent.snapshot },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("readonly imported B cannot export or edit saved A and cancel restores A metadata and actual rendering", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await installWorkbenchDrawObservation(page);
  await saveConstructedScene(page);
  const a = await readWorkbenchStoredMetadata(page);
  const currentText = await page.locator("#general-current").innerText();
  const qualityText = await page.locator("#general-quality").innerText();
  const isolated = await page
    .context()
    .browser()!
    .newContext({
      baseURL: "http://127.0.0.1:4173",
      viewport: { width: 1280, height: 720 },
    });
  let bytes: Buffer;
  let bRevision: string;
  try {
    const other = await isolated.newPage();
    // Different exact content versions, generated through normal UI/save/export in an independent native database.
    await saveConstructedScene(other, false);
    bRevision = (await readWorkbenchStoredMetadata(other)).snapshot.revisionId;
    bytes = await exportBytes(other, "reference");
  } finally {
    await isolated.close();
  }
  const empty = await createCatalogView([], []);
  await page.route("**/api/planner/general/catalog", (route) =>
    route.fulfill({ json: empty }),
  );
  await openStorageControls(page);
  await page.locator("#general-import").setInputFiles({
    name: "constructed-readonly-B.zip",
    mimeType: "application/zip",
    buffer: bytes!,
  });
  await expect(page.locator("#general-current")).toContainText("只读");
  expect(
    JSON.parse((await page.locator("#general-evidence").textContent())!)
      .revisionId,
  ).toBe(bRevision!);
  for (const id of [
    "general-export-reference",
    "general-export-embedded",
    "general-undo",
    "general-use",
  ])
    await expect(page.locator(`#${id}`)).toBeDisabled();
  await expect(page.locator("#general-edit")).toBeHidden();
  expect((await readWorkbenchStoredMetadata(page)).digest).toBe(a.digest);
  await page.locator("#general-cancel").click();
  await expect(page.locator("#general-current")).toHaveText(currentText, {
    useInnerText: true,
  });
  await expect(page.locator("#general-quality")).toHaveText(qualityText, {
    useInnerText: true,
  });
  await expect(page.locator("#general-edit")).toBeVisible();
  await expect(page.locator("#general-export-reference")).toBeEnabled();
  await expect(page.locator("#general-export-embedded")).toBeEnabled();
  expect(
    JSON.parse((await page.locator("#general-evidence").textContent())!)
      .revisionId,
  ).toBe(a.snapshot.revisionId);
  await expect(page.locator("#general-scene-canvas")).toBeVisible();
  const before = await page.evaluate(() => ({
    diagnostics: (window as any).workbench.general.diagnostics(),
    draws: (window as any).generalWorkbenchDrawObservation.snapshot(),
  }));
  expect(before.diagnostics.readonlyView).toBeNull();
  expect(before.diagnostics.rafActive).toBe(true);
  await page.waitForTimeout(200);
  const after = await page.evaluate(() =>
    (window as any).generalWorkbenchDrawObservation.snapshot(),
  );
  expect(after.counts["general-scene-canvas"]).toBeGreaterThan(
    before.draws.counts["general-scene-canvas"] ?? 0,
  );
  expect((await readWorkbenchStoredMetadata(page)).digest).toBe(a.digest);
  await info.attach("readonly-B-current-A-actual-evidence", {
    body: JSON.stringify({
      aRevision: a.snapshot.revisionId,
      bRevision: bRevision!,
      before,
      after,
    }),
    contentType: "application/json",
  });
});

test("displayed imported candidate B cancels to actual A and mode reentry redraws the saved A scene", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await installWorkbenchDrawObservation(page);
  await saveConstructedScene(page);
  const savedA = await readWorkbenchStoredMetadata(page);
  const expectedNodes = (snapshot: any) =>
    snapshot.instances.length +
    snapshot.surfaces.reduce(
      (total: number, surface: any) =>
        total + (surface.role === "water" ? 1 : surface.tiles.length),
      0,
    );
  const observe = () =>
    page.evaluate(() => ({
      actual: (window as any).workbenchSparkDrawObservation.snapshot()[
        "general-scene-canvas"
      ],
      diagnostics: (window as any).workbench.general.diagnostics(),
      legacy: (window as any).workbench.observe(),
    }));
  await expect
    .poll(async () => (await observe()).actual?.nodes.length)
    .toBe(expectedNodes(savedA.snapshot));
  const a = await observe();
  expect(a.actual.nodes.length).toBe(a.diagnostics.view.instanceCount);
  const isolated = await page
    .context()
    .browser()!
    .newContext({
      baseURL: "http://127.0.0.1:4173",
      viewport: { width: 1280, height: 720 },
    });
  let embedded: Buffer;
  let savedB: Awaited<ReturnType<typeof readWorkbenchStoredMetadata>>;
  try {
    const other = await isolated.newPage();
    await openWorkbench(other, "suggestions");
    await plan(other, "suggestions");
    await confirmAndPreview(other);
    await other.locator("#general-use").click();
    await expect(other.locator("#general-status")).toHaveAttribute(
      "data-phase",
      "committed",
    );
    savedB = await readWorkbenchStoredMetadata(other);
    expect(savedB.snapshot.instances).toHaveLength(5);
    embedded = await exportBytes(other, "embedded");
  } finally {
    await isolated.close();
  }
  await openStorageControls(page);
  await page.locator("#general-import").setInputFiles({
    name: "constructed-editable-B.zip",
    mimeType: "application/zip",
    buffer: embedded!,
  });
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "previewing",
  );
  await expect
    .poll(async () => (await observe()).actual?.nodes.length)
    .toBe(expectedNodes(savedB!.snapshot));
  const b = await observe();
  expect(b.actual.nodes.length).not.toBe(a.actual.nodes.length);
  expect(b.actual.nodes.length).toBe(b.diagnostics.view.instanceCount);
  expect(b.actual.serial).toBeGreaterThan(a.actual.serial);
  expect((await readWorkbenchStoredMetadata(page)).digest).toBe(savedA.digest);
  const candidateRevision = JSON.parse(
    (await page.locator("#general-evidence").textContent())!,
  ).revisionId;
  expect(candidateRevision).not.toBe(savedA.snapshot.revisionId);
  await page.locator("#general-cancel").click();
  await expect
    .poll(async () => (await observe()).actual?.nodes.length)
    .toBe(a.actual.nodes.length);
  const restored = await observe();
  expect(restored.actual.serial).toBeGreaterThan(b.actual.serial);
  expect(restored.actual.nodes.map((node: any) => node.uuid).sort()).toEqual(
    a.actual.nodes.map((node: any) => node.uuid).sort(),
  );
  expect(restored.diagnostics.view.sourceCount).toBe(
    a.diagnostics.view.sourceCount,
  );
  expect(
    JSON.parse((await page.locator("#general-evidence").textContent())!)
      .revisionId,
  ).toBe(savedA.snapshot.revisionId);
  expect((await readWorkbenchStoredMetadata(page)).digest).toBe(savedA.digest);
  await page.locator("#general-leave").click();
  await expect.poll(async () => (await observe()).legacy.mode).toBe("legacy");
  await expect(page.locator("#general-scene-canvas")).toBeHidden();
  const left = await observe();
  expect(left.diagnostics.rafActive).toBe(false);
  await page.locator("#general-list").click();
  await expect(page.locator("#general-scene-canvas")).toBeVisible();
  await expect
    .poll(async () => (await observe()).actual?.serial ?? 0)
    .toBeGreaterThan(left.actual.serial);
  await expect
    .poll(async () => (await observe()).diagnostics.view?.instanceCount ?? 0)
    .toBe(a.diagnostics.view.instanceCount);
  const reentered = await observe();
  const mapped = (nodes: any[]) =>
    nodes
      .map(({ count, matrixWorld }) => ({ count, matrixWorld }))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  expect(mapped(reentered.actual.nodes)).toEqual(mapped(a.actual.nodes));
  expect(reentered.diagnostics.view.sourceCount).toBe(
    a.diagnostics.view.sourceCount,
  );
  expect(reentered.legacy.mode).toBe("general");
  expect(reentered.legacy.legacyRafActive).toBe(false);
  expect(reentered.diagnostics.rafActive).toBe(true);
  expect(reentered.diagnostics.lastDrawGeneration).toBe(
    reentered.diagnostics.generation,
  );
  await page.waitForTimeout(200);
  const settled = await observe();
  expect(settled.actual.serial).toBeGreaterThan(reentered.actual.serial);
  expect(settled.legacy.legacyFrames).toBe(reentered.legacy.legacyFrames);
  expect((await readWorkbenchStoredMetadata(page)).digest).toBe(savedA.digest);
  await info.attach("actual-import-cancel-and-mode-reentry-mapping", {
    body: JSON.stringify({
      aRevision: savedA.snapshot.revisionId,
      bSourceRevision: savedB!.snapshot.revisionId,
      candidateRevision,
      a,
      b,
      restored,
      left,
      reentered,
      settled,
    }),
    contentType: "application/json",
  });
});
