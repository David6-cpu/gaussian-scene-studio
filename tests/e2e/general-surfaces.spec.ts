import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
for (const name of ["flat", "slope", "river"] as const)
  test(`${name} Gaussian packet is drawn and moving the camera does not resample`, async ({
    page,
  }) => {
    await page.goto("/tests/general-harness.html");
    await page.waitForFunction(() => (window as any).general?.ready);
    const before = await page.evaluate(
      (name) => (window as any).general.surfaceCase(name),
      name,
    );
    expect(before.drawnNodes).toBe(before.stats.instanceCount);
    expect(before.sampling.maxLogicalRadius).toBeLessThanOrEqual(
      before.sampling.candidateLogicalRadius,
    );
    expect(before.actualConfig.maxStdDev).toBe(Math.sqrt(8));
    expect(before.bindings.waterAlgorithm).toBeTruthy();
    expect(before.pointCount).toBeGreaterThanOrEqual(1681);
    expect(before.stats.activeSplats).toBeGreaterThanOrEqual(before.pointCount);
    const png = PNG.sync.read(
      await page
        .locator("#general")
        .screenshot({ style: "label,#debug {visibility:hidden!important}" }),
    );
    let visible = 0;
    for (let i = 0; i < png.data.length; i += 4)
      if (Math.max(...png.data.subarray(i, i + 3)) > 40) visible++;
    expect(visible).toBeGreaterThan(20000);
    await page.evaluate(() =>
      (window as any).general.camera({
        position: [-4, 2, 4],
        target: [0, 0, 0],
      }),
    );
    const after = await page.evaluate(() =>
      (window as any).general.surfaceState(),
    );
    expect(after.sourceDigest).toBe(before.sourceDigest);
    expect(after.pointCount).toBe(before.pointCount);
    await page.evaluate(() => (window as any).general.release());
  });
