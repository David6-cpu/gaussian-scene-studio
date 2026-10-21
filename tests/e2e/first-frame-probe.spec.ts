import { expect, test } from "@playwright/test";
import {
  createWorkbenchFixture,
  installWorkbenchFixture,
  observeWorkbenchErrors,
  workbenchPrompts,
} from "../support/general-workbench-fixture";

// Constructed green terrain and the existing default camera, not visual admission.
// A negative or incomplete observation is reported as inconclusive, never hidden
// by changing the camera, waiting for extra draws, or retrying this measurement.
test("first preview eligibility is paired with a real default-framebuffer draw", async ({
  page,
}, info) => {
  const errors = observeWorkbenchErrors(page);
  const fixture = await createWorkbenchFixture();
  await installWorkbenchFixture(page, fixture, "dry");
  await page.goto("/tests/harness.html?workbench=1&firstFrameProbe=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#general-prompt").fill(workbenchPrompts.dry);
  await page.locator("#general-plan").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "awaiting-review",
  );
  const choices = page.locator("#general-scene-panel input[data-slot]");
  await expect(choices).toHaveCount(3);
  for (const choice of await choices.all()) await choice.check();
  await page.locator("#general-review").click();
  await expect(page.locator("#general-preview")).toBeEnabled();

  await page.evaluate(() => window.generalFirstFrameProbe!.arm());
  await page.locator("#general-preview").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.generalFirstFrameProbe!.snapshot().stopReason,
        ),
      { timeout: 5000 },
    )
    .not.toBeNull();
  const observed = await page.evaluate(() => ({
    probe: window.generalFirstFrameProbe!.snapshot(),
    capturedAt: performance.now(),
    phase:
      document.querySelector<HTMLElement>("#general-status")?.dataset.phase,
    useDisabled:
      document.querySelector<HTMLButtonElement>("#general-use")?.disabled,
  }));
  const screenshotStartedAt = await page.evaluate(() => performance.now());
  const screenshot = await page.screenshot();
  const screenshotCompletedAt = await page.evaluate(() => performance.now());
  const first = observed.probe.firstPreview;
  const draw = first?.draw;
  const reasons: string[] = [];
  if (!first)
    reasons.push(
      "No first-preview notification within the bounded observation.",
    );
  if (!draw)
    reasons.push(
      "No native draw was associated with the first-preview notification.",
    );
  if (draw && first?.latestNativeDrawSerial !== draw.serial)
    reasons.push(
      "The sampled draw was superseded after the observation reached its frame limit.",
    );
  if (draw && (!draw.defaultFramebuffer || draw.error))
    reasons.push(
      "The associated draw has no successful default-framebuffer pixel observation.",
    );
  if (
    draw &&
    (!draw.mapping.length ||
      !Number.isFinite(draw.activeSplats) ||
      draw.activeSplats <= 0)
  )
    reasons.push(
      "The associated draw did not report nonempty mapping and active splats.",
    );
  if (draw && (!(draw.nonBlackPixels! > 0) || !(draw.greenPixels! > 0)))
    reasons.push(
      "The center sample did not establish visible green terrain; coverage or drawing requires investigation.",
    );
  // The controller's enclosing UI operation may finish after this notification.
  // Preserve both early readings, and separately record the settled button here.
  if (observed.useDisabled !== false)
    reasons.push(
      "Use/save was not enabled at the separately timestamped UI observation.",
    );
  const conclusion = reasons.length
    ? "inconclusive"
    : "first-eligible-draw-observed";
  await info.attach("first-preview-native-frame-observation", {
    body: JSON.stringify(
      {
        conclusion,
        reasons,
        limits:
          "At most 30 actual general draws, with no new sample started after 3000 ms. A synchronous readPixels begun inside that window may finish later and may affect timing. Not performance or visual acceptance.",
        observed,
        screenshot: {
          screenshotStartedAt,
          screenshotCompletedAt,
          purpose: "Later corroborating PNG; not the first eligible frame.",
        },
        errors,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await info.attach("first-preview-corresponding-page", {
    body: screenshot,
    contentType: "image/png",
  });
  expect(observed.probe.samples.length).toBeLessThanOrEqual(30);
  expect(errors.pageErrors).toEqual([]);
  expect(conclusion, reasons.join("\n")).toBe("first-eligible-draw-observed");
});
