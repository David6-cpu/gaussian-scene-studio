import { test, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  enterReview,
  previewReview,
  readyReviewPrompt,
} from "../support/review";
import { buildScene } from "../../src/build";
import {
  sampleRiverbankWater,
  riverbankSurface,
} from "../../src/terrain/riverbank-water";
import { sampleHeight } from "../../src/terrain/heightfield";
import type { RiverbankRecipe } from "../../src/gaussian/types";

test.use({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
test("default entry is a plain-language review with no additional rocks", async ({
  page,
}) => {
  test.fixme(
    true,
    "Visual gate rejected the flat clipped water surface; keep review=1 opt-in. See riverbank-review-preview-results.md.",
  );
  await page.goto("/?planner=3b");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#scene-review")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("#advanced-compat")).not.toHaveAttribute(
    "open",
    "",
  );
  const evidence = JSON.parse(
    (await page.locator("#scene-evidence").textContent())!,
  );
  expect(evidence.recipe.algorithmVersion).toBe("f0-riverbank-grass-v1");
  expect(evidence.recipe.requested.rock).toBe(0);
});

const cases = [42, 20261002]
  .flatMap((seed) =>
    [0, -0.025, null].map((waterLevel) => ({
      seed,
      waterLevel,
      plantKind: "grass" as "grass" | "reed",
      rock: "omit" as "omit" | "placeholder",
    })),
  )
  .concat([
    { seed: 42, waterLevel: 0, plantKind: "reed", rock: "placeholder" },
    {
      seed: 20261002,
      waterLevel: -0.025,
      plantKind: "reed",
      rock: "placeholder",
    },
  ]);

for (const c of cases) {
  const name = `${c.seed}-${c.waterLevel === null ? "dry" : c.waterLevel === 0 ? "zero" : "minus0025"}-${c.plantKind}-${c.rock}`;
  test(`offline river visibility ${name}`, async ({ page }, testInfo) => {
    test.setTimeout(45000);
    const dir = process.env.REVIEW_VISUAL_DIR ?? testInfo.outputPath("visual");
    await mkdir(dir, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/tests/harness.html?workbench=1&review=1");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    const prompt =
      c.waterLevel === null
        ? "干涸河床，不放水，放4丛低草"
        : c.waterLevel === 0
          ? readyReviewPrompt
          : "河岸水位-0.025，2组石头、4丛低草";
    await enterReview(page, prompt, {
      seed: c.seed,
      waterLevel: c.waterLevel,
      plantKind: c.plantKind,
    });
    if (c.rock === "placeholder") {
      await page.locator("#review-rock-placeholder").check();
      await page.locator("#review-procedural").check();
    }
    await previewReview(page);
    await page.screenshot({ path: join(dir, `${name}-review.png`) });
    await page.locator("#review-use").click();
    await expect(page.locator("#review-status")).toHaveAttribute(
      "data-phase",
      "used",
    );
    const recipe = (await page.evaluate(
      () => (window as any).workbench.result.recipe,
    )) as RiverbankRecipe;
    const built = buildScene(recipe),
      water = sampleRiverbankWater(built.heightfield, recipe),
      surface = riverbankSurface(water, c.plantKind === "reed");
    expect(recipe.waterLevel).toBe(c.waterLevel);
    expect(recipe.requested.rock).toBe(c.rock === "omit" ? 0 : 2);
    for (const instance of built.scene.instances)
      expect(surface.isWet(instance.position[0], instance.position[2])).toBe(
        false,
      );
    if (c.waterLevel === null) {
      expect(built.scene.water).toBeNull();
      await expect(page.locator("#review-summary")).toContainText("本次无水");
    } else {
      expect(water.metrics.components).toBe(1);
      expect(water.metrics.spansZ).toBe(true);
      for (let z = 0; z < 81; z++) {
        expect(water.mask.slice(z * 81, z * 81 + 81).some(Boolean)).toBe(true);
        for (let x = 0; x < 81; x++)
          if (water.mask[z * 81 + x]) {
            for (const [dx, dz] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const nx = x + dx,
                nz = z + dz;
              if (
                nx >= 0 &&
                nx < 81 &&
                nz >= 0 &&
                nz < 81 &&
                !water.mask[nz * 81 + nx]
              )
                expect(
                  sampleHeight(built.heightfield, nx * 0.05 - 2, nz * 0.05 - 2),
                ).toBeGreaterThanOrEqual(c.waterLevel);
            }
          }
      }
    }
    const views = [];
    for (const preset of ["overlap", "top", "near"]) {
      await page.locator(`[data-camera="${preset}"]`).click();
      const camera = await page.evaluate(() =>
        (window as any).workbench.view.getCamera(),
      );
      const frames: Buffer[] = [];
      for (const enabled of [true, false]) {
        await page.evaluate(
          async ({ enabled, camera }) => {
            const w = (window as any).workbench;
            await w.view.setScene({
              ...w.result.scene,
              water: enabled ? w.result.scene.water : null,
            });
            w.view.setLodEnabled(false);
            w.view.setCamera(camera.position, camera.target);
          },
          { enabled, camera },
        );
        await page.waitForFunction(() =>
          (window as any).workbench.view.isCurrentSceneDisplayed(),
        );
        // Let the same fixed-camera sort settle before both captures.
        await page.waitForTimeout(180);
        frames.push(
          await page.locator("canvas").screenshot({
            path: join(
              dir,
              `${name}-${preset}-${enabled ? "water" : "without-water"}.png`,
            ),
          }),
        );
      }
      const a = PNG.sync.read(frames[0]),
        b = PNG.sync.read(frames[1]);
      expect([b.width, b.height]).toEqual([a.width, a.height]);
      let changed = 0;
      for (let i = 0; i < a.data.length; i += 4)
        if ([0, 1, 2].some((k) => Math.abs(a.data[i + k] - b.data[i + k]) >= 8))
          changed++;
      const fraction = changed / (a.width * a.height);
      views.push({
        preset,
        camera,
        width: a.width,
        height: a.height,
        changedPixels: changed,
        changedFraction: fraction,
      });
      if (c.waterLevel !== null && preset !== "near")
        expect(fraction).toBeGreaterThanOrEqual(0.03);
      if (c.waterLevel === null) expect(fraction).toBe(0);
    }
    const evidence = {
      basis:
        "Constructed test responses, real renderer and Riverside; no real model inference",
      recipe,
      report: built.report,
      water: { count: water.buffer?.count ?? 0, ...water.metrics },
      views,
      errors,
      gpu: await page.evaluate(() => (window as any).workbench.view.gpuInfo()),
    };
    await writeFile(
      join(dir, `${name}.json`),
      JSON.stringify(evidence, null, 2),
    );
    expect(errors).toEqual([]);
  });
}

for (const [version, zipVersion] of [
  ["f0-v1", 1],
  ["f0-riverside-grass-v2", 2],
] as const)
  test(`offline legacy archive v${zipVersion} keeps the same image and original bytes`, async ({
    page,
  }, testInfo) => {
    const dir = process.env.REVIEW_VISUAL_DIR ?? testInfo.outputPath("visual");
    await mkdir(dir, { recursive: true });
    await page.goto("/tests/harness.html?workbench=1");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await page.locator("#algorithmVersion").selectOption(version);
    await page.locator("#generate").click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await page.locator('[data-camera="top"]').click();
    const camera = await page.evaluate(() =>
      (window as any).workbench.view.getCamera(),
    );
    await page.waitForTimeout(180);
    const before = await page
      .locator("canvas")
      .screenshot({ path: join(dir, `legacy-v${zipVersion}-before.png`) });
    const download = page.waitForEvent("download");
    await page.locator("#save").click();
    const path = (await (await download).path())!,
      bytes = await readFile(path);
    const sha = (value: Buffer) =>
      createHash("sha256").update(value).digest("hex");
    await writeFile(join(dir, `legacy-v${zipVersion}.zip`), bytes);
    await page.route("**/assets/**", (r) => r.abort());
    await page.locator("#clear").click();
    await page.locator("#bundle-file").setInputFiles(path);
    await expect(page.locator("#status")).toContainText("已导入");
    await page.evaluate(
      (camera) =>
        (window as any).workbench.view.setCamera(
          camera.position,
          camera.target,
        ),
      camera,
    );
    await page.waitForFunction(() =>
      (window as any).workbench.view.isCurrentSceneDisplayed(),
    );
    await page.waitForTimeout(180);
    const after = await page
      .locator("canvas")
      .screenshot({ path: join(dir, `legacy-v${zipVersion}-after.png`) });
    expect(PNG.sync.read(after).data).toEqual(PNG.sync.read(before).data);
    expect(sha(await readFile(path))).toBe(sha(bytes));
    await writeFile(
      join(dir, `legacy-v${zipVersion}.json`),
      JSON.stringify(
        {
          version,
          zipVersion,
          sha256: sha(bytes),
          camera,
          pixelDifference: 0,
          basis:
            "Offline roundtrip of unchanged legacy recipe; pre-catalog scene hashes checked separately",
        },
        null,
        2,
      ),
    );
  });
