import { expect, test } from "@playwright/test";
import {
  createWorkbenchFixture,
  installWorkbenchFixture,
  observeWorkbenchErrors,
  readWorkbenchDatabase,
} from "../support/general-workbench-fixture";

test("example catalog failure preserves the error and old manual rows; retry fills only its own two groups", async ({
  page,
}, info) => {
  // Only the HTTP catalog/asset inputs are constructed. The panel, integration
  // lifecycle and native IndexedDB observations use the production code.
  const fixture = await createWorkbenchFixture();
  const trace = await installWorkbenchFixture(page, fixture);
  const errors = observeWorkbenchErrors(page);
  await page.goto("/tests/harness.html?workbench=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page
    .locator("#general-prompt")
    .fill("旧手工草稿：7 丛芦苇，来源待确认。");
  await page.locator("#general-manual").click();
  const rows = page.locator("#general-manual-roles fieldset");
  await expect(rows).toHaveCount(0);
  await page.locator("#general-add-role").click();
  await rows.locator("[data-manual-category]").selectOption("reed");
  await rows.locator("[data-manual-count]").fill("7");
  await rows.locator("[data-manual-source]").selectOption("captured");

  const readForm = () =>
    page.locator("#general-form").evaluate((form) => ({
      water: form.querySelector<HTMLSelectElement>("#general-water-mode")!
        .value,
      style: form.querySelector<HTMLSelectElement>("#general-style")!.value,
      rows: Array.from(
        form.querySelectorAll("#general-manual-roles fieldset"),
      ).map((row) => ({
        category: row.querySelector<HTMLSelectElement>(
          "[data-manual-category]",
        )!.value,
        count: row.querySelector<HTMLInputElement>("[data-manual-count]")!
          .value,
        source: row.querySelector<HTMLSelectElement>("[data-manual-source]")!
          .value,
      })),
    }));
  const before = await readForm();
  const databaseBefore = await readWorkbenchDatabase(page);
  expect(before.rows).toEqual([
    { category: "reed", count: "7", source: "captured" },
  ]);

  await page.route(
    "**/api/planner/general/catalog",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Constructed one-shot catalog failure" },
      }),
    { times: 1 },
  );
  const failureResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/planner/general/catalog" &&
      response.status() === 503,
  );
  await page.locator("#general-example").click();
  await failureResponse;
  await expect(page.locator("#general-example")).toBeEnabled();
  const afterFailure = {
    form: await readForm(),
    message: await page.locator("#general-message").innerText(),
    database: await readWorkbenchDatabase(page),
    phase: await page.locator("#general-status").getAttribute("data-phase"),
  };
  await info.attach("example-catalog-failure-before-retry", {
    body: JSON.stringify({
      before,
      afterFailure,
      databaseBefore,
      trace,
      errors,
    }),
    contentType: "application/json",
  });
  expect(afterFailure.message).toContain("本机素材读取失败 HTTP 503");
  expect(afterFailure.message).not.toContain("已填好示例");
  expect(afterFailure.form).toEqual(before);
  expect(afterFailure.database).toEqual(databaseBefore);
  expect(afterFailure.phase).not.toBe("previewing");
  await expect(page.locator("#general-preview")).toBeDisabled();
  await expect(page.locator("#general-use")).toBeDisabled();
  expect(trace.planning).toHaveLength(0);
  expect(trace.members).toBe(0);

  // The one-shot failure is gone; a new successful setup must replace the old
  // rows before the example adds its own groups, without generating or saving.
  await page.locator("#general-example").click();
  await expect(page.locator("#general-message")).toContainText("已填好示例");
  const afterRetry = await readForm();
  expect(afterRetry.rows).toEqual([
    { category: "rock", count: "3", source: "procedural" },
    { category: "grass", count: "5", source: "procedural" },
  ]);
  expect(afterRetry.water).toBe("none");
  expect(afterRetry.style).not.toBe("");
  await expect(page.locator("#general-preview")).toBeDisabled();
  await expect(page.locator("#general-use")).toBeDisabled();
  expect(await readWorkbenchDatabase(page)).toEqual(databaseBefore);
  expect(trace.planning).toHaveLength(0);
  expect(trace.members).toBe(0);
  expect(errors.pageErrors).toEqual([]);
  await info.attach("example-catalog-retry", {
    body: JSON.stringify({ afterRetry, trace, errors }),
    contentType: "application/json",
  });
});
