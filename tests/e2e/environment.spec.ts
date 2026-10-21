import { test, expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import {
  environmentSpz,
  environmentWorld,
  jsonBytes,
} from "../support/environment-fixture";
async function open(page: Page) {
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#environment-details > summary").click();
}
async function preview(page: Page, title?: string) {
  const world = environmentWorld();
  if (title) world.display_name = title;
  await page.locator("#environment-world-file").setInputFiles({
    name: "world.json",
    mimeType: "application/json",
    buffer: Buffer.from(jsonBytes(world)),
  });
  await page.locator("#environment-spz-file").setInputFiles({
    name: "test.spz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(environmentSpz()),
  });
  await page.locator("#environment-import").click();
  await expect(page.locator("#environment-status")).toContainText("预览就绪");
}
const original = (page: Page) => page.locator("#scene-evidence").textContent();
test("environment display does not attribute the previous scene size, timing or capture credit", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  const title = await page.locator("#scene-title").textContent();
  await expect(page.locator("#ground-credit")).toBeVisible();
  await page.locator("#environment-details > summary").click();
  await preview(page);
  await expect(page.locator("#scene-title")).toHaveText(
    "导入环境 · 待画质验收",
  );
  await expect(page.locator("#ground-credit")).toBeHidden();
  await expect(page.locator("#build-time")).toBeHidden();
  await page.locator("#environment-return").click();
  await expect(page.locator("#scene-title")).toHaveText(title!);
  await expect(page.locator("#ground-credit")).toBeVisible();
});
test("local SPZ displays real pixels; cancel restores original, save/reload/reopen and backup preserve it", async ({
  page,
}) => {
  const errors: string[] = [],
    remote: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:") &&
      !r.url().startsWith("blob:") &&
      !r.url().startsWith("data:")
    )
      remote.push(r.url());
  });
  await open(page);
  const before = await original(page);
  await page.evaluate(() =>
    localStorage.setItem("wetland.sceneReviews.v1", "[]"),
  );
  await preview(page);
  const pixels = PNG.sync.read(
    await page.locator("#environment-canvas").screenshot(),
  );
  expect(
    Array.from(
      { length: pixels.width * pixels.height },
      (_, i) => pixels.data[i * 4] > 100 || pixels.data[i * 4 + 1] > 100,
    ).filter(Boolean).length,
  ).toBeGreaterThan(300);
  await page.locator("#environment-cancel").click();
  await expect(page.locator("#environment-canvas")).toBeHidden();
  await expect.poll(() => original(page), { timeout: 5000 }).toBe(before);
  await preview(page);
  await page.locator("#environment-save").click();
  await expect(page.locator("#environment-status")).toContainText("已保存");
  await expect(page.locator("#environment-list button")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.locator("#environment-export").click();
  const backup = await download;
  const path = await backup.path();
  expect(path).toBeTruthy();
  await page.locator("#environment-return").click();
  await expect.poll(() => original(page), { timeout: 5000 }).toBe(before);
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#environment-details > summary").click();
  await page.locator("#environment-list button").click();
  await expect(page.locator("#environment-status")).toContainText("预览就绪");
  await page.locator("#environment-save").click();
  await expect(page.locator("#environment-status")).toContainText("已存在");
  await expect(page.locator("#environment-list button")).toHaveCount(1);
  await page.locator("#environment-return").click();
  await page.locator("#environment-backup-file").setInputFiles(path!);
  await expect(page.locator("#environment-status")).toContainText("预览就绪");
  expect(
    await page.evaluate(() => localStorage.getItem("wetland.sceneReviews.v1")),
  ).toBe("[]");
  expect(errors).toEqual([]);
  expect(remote).toEqual([]);
});
test("storage abort and invalid replacement preserve preview, retry and context-loss return work", async ({
  page,
}) => {
  await open(page);
  const before = await original(page);
  await preview(page);
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (
      ...args: Parameters<IDBObjectStore["add"]>
    ) {
      IDBObjectStore.prototype.add = add;
      throw new DOMException("test quota", "QuotaExceededError");
    };
  });
  await page.locator("#environment-save").click();
  await expect(page.locator("#environment-status")).toContainText("未保存");
  await expect(page.locator("#environment-canvas")).toBeVisible();
  await expect(page.locator("#environment-save")).toBeEnabled();
  await page.locator("#environment-save").click();
  await expect(page.locator("#environment-status")).toContainText("已保存");
  await page.locator("#environment-spz-file").setInputFiles({
    name: "broken.spz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("invalid"),
  });
  await page.locator("#environment-import").click();
  await expect(page.locator("#environment-status")).toContainText("导入失败");
  await expect(page.locator("#environment-canvas")).toBeVisible();
  await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("#environment-canvas")!;
    c.getContext("webgl2")!.getExtension("WEBGL_lose_context")!.loseContext();
  });
  await expect(page.locator("#environment-status")).toContainText("显示中断");
  await page.locator("#environment-return").click();
  await expect(page.locator("#environment-canvas")).toBeHidden();
  await expect.poll(() => original(page), { timeout: 5000 }).toBe(before);
});
test("late file read cannot replace a newer import or reopen a cancelled view", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === "slow.json")
        await new Promise((r) => setTimeout(r, 500));
      return read.call(this);
    };
  });
  await page.locator("#environment-world-file").setInputFiles({
    name: "slow.json",
    mimeType: "application/json",
    buffer: Buffer.from(jsonBytes(environmentWorld())),
  });
  await page.locator("#environment-spz-file").setInputFiles({
    name: "test.spz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(environmentSpz()),
  });
  await page.locator("#environment-import").click();
  await page.locator("#environment-cancel").click();
  await preview(page, "新的测试环境");
  await page.waitForTimeout(600);
  await expect(page.locator("#environment-info")).toContainText("新的测试环境");
});
test("native IndexedDB keeps concurrent limit and immutable duplicates; corruption is refused", async ({
  page,
}) => {
  await page.goto("/tests/environment-harness.html");
  await page.waitForFunction(() => Boolean((window as any).environmentTest));
  const outcome = await page.evaluate(async () => {
    const t = (window as any).environmentTest;
    const records = await Promise.all(
      Array.from({ length: 9 }, (_, i) => t.record("item-" + i)),
    );
    const saves = await Promise.allSettled(
      records.map((r: any) => t.store.save(r)),
    );
    const list = await t.store.list();
    const first = list[0];
    const duplicate = await t.store.save(first);
    await t.corrupt(first.asset.id);
    let readError = false,
      saveError = false;
    try {
      await t.store.list();
    } catch {
      readError = true;
    }
    try {
      await t.store.save(first);
    } catch {
      saveError = true;
    }
    return {
      fulfilled: saves.filter((x) => x.status === "fulfilled").length,
      count: list.length,
      duplicate: duplicate.duplicate,
      readError,
      saveError,
    };
  });
  expect(outcome).toEqual({
    fulfilled: 8,
    count: 8,
    duplicate: true,
    readError: true,
    saveError: true,
  });
});
test("Spark SPZ coordinates, SH3 and metric transform are checked using asymmetric source data", async ({
  page,
}) => {
  await page.goto("/tests/environment-harness.html");
  await page.waitForFunction(() => Boolean((window as any).environmentTest));
  const actual = await page.evaluate(async () => {
    const t = (window as any).environmentTest;
    return [await t.render(true), await t.render(false), await t.render(true, 3), await t.release()];
  });
  expect(actual[0].count).toBe(3);
  expect(actual[0].shDegree).toBe(3);
  expect(actual[0].rawFirst).toEqual([1, 2, 3]);
  expect(actual[0].worldFirst[0]).toBeCloseTo(2);
  expect(actual[0].worldFirst[1]).toBeCloseTo(-3.5);
  expect(actual[0].worldFirst[2]).toBeCloseTo(-6);
  expect(actual[1].worldFirst[1]).toBeCloseTo(3.5);
  expect(actual[1].worldFirst[2]).toBeCloseTo(6);
  expect(actual[2].count).toBe(3);
  expect(actual[2].shDegree).toBe(3);
  expect(actual[2].rawFirst).toEqual([1, 2, 3]);
  expect(actual[3].sources).toBe(0);
});
