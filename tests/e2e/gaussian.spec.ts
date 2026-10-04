import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "node:fs";
function colored(bytes: Buffer) {
  const p = PNG.sync.read(bytes);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4)
    if (p.data[i] > 30 || p.data[i + 1] > 30) n++;
  return n;
}
test("real Gaussian pixels, view parallax and shared source survive removal", async ({
  page,
}) => {
  await page.goto("/tests/harness.html");
  await expect
    .poll(() => page.evaluate(() => window.ready ?? window.failure))
    .toBe(true);
  await expect
    .poll(async () => colored(await page.locator("canvas").screenshot()))
    .toBeGreaterThan(5000);
  expect(await page.evaluate(() => window.testView.stats())).toMatchObject({
    sourceBuffers: 1,
    instanceCount: 2,
    uniqueSourceSplats: 2,
    activeSplats: 4,
  });
  const before = await page.locator("canvas").screenshot();
  mkdirSync(".local/screens", { recursive: true });
  writeFileSync(".local/screens/task1-shared.png", before);
  writeFileSync(
    ".local/screens/task1-gpu.json",
    JSON.stringify(
      await page.evaluate(() => {
        const gl = document.querySelector("canvas")!.getContext("webgl2")!;
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          userAgent: navigator.userAgent,
          renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        };
      }),
      null,
      2,
    ),
  );
  await page.evaluate(() => window.testView.setCamera([3, 1, 8], [0, 0, 0]));
  await expect
    .poll(async () =>
      Buffer.compare(before, await page.locator("canvas").screenshot()),
    )
    .not.toBe(0);
  await page.evaluate(() => window.testView.removeInstance("a"));
  await expect
    .poll(async () => colored(await page.locator("canvas").screenshot()))
    .toBeGreaterThan(1000);
  expect(await page.evaluate(() => window.testView.stats())).toMatchObject({
    sourceBuffers: 1,
    instanceCount: 1,
    activeSplats: 2,
  });
  await page.evaluate(() => window.testView.dispose());
  expect(await page.evaluate(() => window.testView.stats())).toMatchObject({
    sourceBuffers: 0,
    instanceCount: 0,
    ownedBytes: 0,
  });
});
test("linear midpoint produces an sRGB gray card without double conversion", async ({
  page,
}) => {
  await page.goto("/tests/harness.html");
  await expect
    .poll(() => page.evaluate(() => window.ready ?? window.failure))
    .toBe(true);
  await page.evaluate(async () => {
    const f = window.fixture();
    f.instances = [];
    f.assets = [];
    f.terrain = {
      count: 1,
      data: new Float32Array([
        0, 0, 0, 1, 1, 0.1, 0, 0, 0, 1, 0.5, 0.5, 0.5, 1,
      ]),
    };
    await window.testView.setScene(f);
  });
  await expect
    .poll(async () => {
      const p = PNG.sync.read(await page.locator("canvas").screenshot());
      return p.data[(360 * 1280 + 640) * 4];
    })
    .toBeGreaterThan(178);
  const png = await page.locator("canvas").screenshot();
  const p = PNG.sync.read(png);
  expect(p.data[(360 * 1280 + 640) * 4]).toBeLessThan(198);
  mkdirSync(".local/screens", { recursive: true });
  writeFileSync(".local/screens/task1-gray.png", png);
});
test("cross-object depth order shows nearer green, then red after front instance removal", async ({
  page,
}) => {
  await page.goto("/tests/harness.html");
  await expect
    .poll(() => page.evaluate(() => window.ready ?? window.failure))
    .toBe(true);
  const center = async () => {
    const p = PNG.sync.read(await page.locator("canvas").screenshot());
    const i = (360 * 1280 + 640) * 4;
    return { r: p.data[i], g: p.data[i + 1] };
  };
  await expect
    .poll(async () => {
      const c = await center();
      return c.g - c.r;
    })
    .toBeGreaterThan(50);
  await page.evaluate(() => window.testView.removeInstance("b"));
  await expect
    .poll(async () => {
      const c = await center();
      return c.r - c.g;
    })
    .toBeGreaterThan(50);
});
test("heightfield and static water render as Gaussians in five views", async ({
  page,
}) => {
  await page.goto("/tests/harness.html?terrain=1");
  await expect
    .poll(() => page.evaluate(() => window.ready ?? window.failure))
    .toBe(true);
  expect(
    (await page.evaluate(() => window.testView.stats())).activeSplats,
  ).toBeGreaterThan(2601);
  const views: [string, [number, number, number], [number, number, number]][] =
    [
      ["top", [0, 12, 0.01], [0, 0, 0]],
      ["eye", [0, 1.6, 6], [0, 0, 0]],
      ["low", [0, 0.7, 6], [0, 0, 0]],
      ["near", [0, 0.5, 1], [0, 0, 0]],
      ["overlap", [4, 2, 4], [0, 0, 0]],
    ];
  for (const [name, pos, target] of views) {
    await page.evaluate(
      ([p, t]) => window.testView.setCamera(p, t),
      [pos, target],
    );
    await expect
      .poll(async () => colored(await page.locator("canvas").screenshot()))
      .toBeGreaterThan(15000);
    await page
      .locator("canvas")
      .screenshot({ path: ".local/screens/task2-" + name + ".png" });
  }
});
test("1/5/20 instances share prototypes and LOD switches preserve surviving sources", async ({
  page,
}) => {
  for (const count of [1, 5, 20]) {
    await page.goto("/tests/harness.html?assets=1&count=" + count);
    await expect
      .poll(() => page.evaluate(() => window.ready ?? window.failure))
      .toBe(true);
    expect(
      (await page.evaluate(() => window.testView.stats())).instanceCount,
    ).toBe(count);
    await page.evaluate(() => {
      window.testView.setLodEnabled(false);
      window.testView.render();
    });
    const original = await page.evaluate(() => window.testView.stats());
    expect(original.sourceBuffers).toBe(6);
    await page.evaluate(() => {
      window.testView.setLodEnabled(true);
      window.testView.setCamera([0, 40, 75], [0, 0, 0]);
    });
    await expect
      .poll(() => page.evaluate(() => window.testView.stats().activeSplats))
      .toBe(original.activeSplats - count * 3072);
    if (count === 20) {
      await page.evaluate(() =>
        window.testView.removeInstance(window.currentScene.instances[0].id),
      );
      await page.evaluate(() =>
        window.testView.setCamera([0, 3, 8], [0, 0, 0]),
      );
      await expect
        .poll(() => page.evaluate(() => window.testView.stats().activeSplats))
        .toBeGreaterThan(original.activeSplats - 4096 - 10000);
      await page
        .locator("canvas")
        .screenshot({ path: ".local/screens/task3-assets.png" });
    }
  }
});
test("overlapping scene uploads commit only the newest source set", async ({
  page,
}) => {
  await page.goto("/tests/harness.html");
  await expect
    .poll(() => page.evaluate(() => window.ready ?? window.failure))
    .toBe(true);
  await page.evaluate(async () => {
    const a = window.fixture(),
      b = window.fixture();
    b.assets = [];
    b.instances = [];
    b.terrain = {
      count: 1,
      data: new Float32Array([0, 0, 0, 0.5, 0.5, 0.1, 0, 0, 0, 1, 0, 0, 1, 1]),
    };
    await Promise.all([
      window.testView.setScene(a),
      window.testView.setScene(b),
    ]);
  });
  expect(await page.evaluate(() => window.testView.stats())).toMatchObject({
    sourceBuffers: 1,
    instanceCount: 0,
    activeSplats: 1,
  });
});
