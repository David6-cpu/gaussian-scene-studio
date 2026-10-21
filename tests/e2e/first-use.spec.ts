import { expect, test } from "@playwright/test";

// Uses the bundled starter library served by the real planner server; no
// model, fixture library or route interception.
test("first-use example previews a starter scene without a local model", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#general-steps")).toContainText("描述");
  await expect(page.locator("#advanced-compat")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.locator("#general-example").click();
  await expect(page.locator("#general-message")).toContainText("已填好示例");
  await expect(page.locator("#general-prompt")).not.toHaveValue("");
  await expect(page.locator("#general-water-mode")).toHaveValue("none");
  await expect(page.locator("#general-manual-roles fieldset")).toHaveCount(2);

  await page.locator("#general-manual-prepare").click();
  const choices = page.locator("#general-scene-panel input[data-slot]");
  await expect(choices).toHaveCount(3);
  // The example never pre-confirms procedural sources.
  for (const choice of await choices.all()) {
    await expect(choice).not.toBeChecked();
    await choice.check();
  }
  await page.locator("#general-review").click();
  await expect(page.locator("#general-preview")).toBeEnabled();
  await page.locator("#general-preview").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "previewing",
    { timeout: 30000 },
  );
  await expect(page.locator("#general-use")).toBeEnabled();
});
