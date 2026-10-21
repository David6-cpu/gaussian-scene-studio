import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const version of [
  "f0-riverside-grass-v1",
  "f0-riverside-reed-v1",
  "f0-riverside-grass-v2",
])
  test(`${version} keeps its choice through planning, ZIP reopen, and original-prop rollback`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const evidence = async () =>
      JSON.parse((await page.locator("#scene-evidence").textContent())!);
    await page.goto("/?advanced");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await expect(page.locator("#algorithmVersion")).toHaveValue(
      "f0-riverside-grass-v2",
    );
    await page.selectOption("#algorithmVersion", version);
    await page.click("#generate");
    await expect
      .poll(async () => (await evidence()).recipe.algorithmVersion)
      .toBe(version);
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await expect(page.locator(".mode-note")).toContainText("非实拍");
    expect((await evidence()).stats.ground.shBands).toBe(3);
    await page.click("#plan-demo");
    await expect(page.locator("#plan-summary")).toContainText("程序高斯候选");
    await page.click("#plan-confirm");
    await expect(page.locator("#status")).toHaveAttribute("data-seed", "42");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    const before = await evidence();
    expect(before.recipe.algorithmVersion).toBe(version);
    const planPromise = page.waitForEvent("download");
    await page.click("#plan-save");
    const plan = await planPromise;
    expect(
      JSON.parse(await readFile((await plan.path())!, "utf8")).recipe
        .algorithmVersion,
    ).toBe(version);
    const zipPromise = page.waitForEvent("download");
    await page.click("#save");
    const zip = await zipPromise;
    await page.selectOption("#algorithmVersion", "f0-riverside-v1");
    await page.click("#generate");
    await expect
      .poll(async () => (await evidence()).recipe.algorithmVersion)
      .toBe("f0-riverside-v1");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await expect(page.locator(".mode-note")).toContainText("原合成");
    await page.route("**/assets/riverside-ground-v1/**", (r) => r.abort());
    await page.click("#clear");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "empty",
    );
    await page.locator("#bundle-file").setInputFiles((await zip.path())!);
    await expect(page.locator("#status")).toContainText("已导入");
    expect((await evidence()).recipe).toEqual(before.recipe);
    expect((await evidence()).stats).toEqual(before.stats);
    await expect(page.locator(".mode-note")).toContainText("非实拍");
    expect(errors).toEqual([]);
  });
