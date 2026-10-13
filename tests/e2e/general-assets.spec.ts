import { test, expect, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
async function saveEvidence(
  testInfo: TestInfo,
  name: string,
  attachment: { body: Buffer; contentType: string },
) {
  const path = testInfo.outputPath(name);
  await writeFile(path, attachment.body);
  await testInfo.attach(name, { path, contentType: attachment.contentType });
}
const pixels = (bytes: Buffer) => {
  const p = PNG.sync.read(bytes);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4)
    if (Math.max(...p.data.subarray(i, i + 3)) > 40) n++;
  return n;
};
test("general harness displays shared Gaussian instances with a nonzero anchor", async ({
  page,
}) => {
  await page.goto("/tests/general-harness.html");
  await expect
    .poll(() => page.evaluate(() => (window as any).general?.ready ?? false), {
      timeout: 3000,
    })
    .toBe(true);
  expect(
    pixels(
      await page.locator("#general").screenshot({
        style: "label, #debug { visibility: hidden !important; }",
      }),
    ),
  ).toBeGreaterThan(500);
  expect(
    await page.evaluate(() => (window as any).general.view.stats()),
  ).toMatchObject({ sourceCount: 1, instanceCount: 2, activeSplats: 2 });
  await page.evaluate(() => (window as any).general.removeFirst());
  expect(
    pixels(
      await page.locator("#general").screenshot({
        style: "label, #debug { visibility: hidden !important; }",
      }),
    ),
  ).toBeGreaterThan(250);
  expect(
    await page.evaluate(() => (window as any).general.view.stats()),
  ).toMatchObject({ sourceCount: 1, instanceCount: 1, activeSplats: 1 });
  const image = PNG.sync.read(
    await page.locator("#general").screenshot({
      style: "label, #debug { visibility: hidden !important; }",
    }),
  );
  let total = 0,
    sumX = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (Math.max(image.data[i], image.data[i + 1], image.data[i + 2]) > 40) {
        total++;
        sumX += x;
      }
    }
  expect(sumX / total).toBeGreaterThan(780);
  expect(sumX / total).toBeLessThan(810);
});

const ready = async (page: import("@playwright/test").Page) => {
  await page.goto("/tests/general-harness.html");
  await expect
    .poll(() => page.evaluate(() => (window as any).general?.ready ?? false))
    .toBe(true);
};
const center = (bytes: Buffer) => {
  const p = PNG.sync.read(bytes),
    out = [0, 0, 0];
  for (let y = p.height / 2 - 5; y < p.height / 2 + 5; y++)
    for (let x = p.width / 2 - 5; x < p.width / 2 + 5; x++)
      for (let c = 0; c < 3; c++)
        out[c] += p.data[(y * p.width + x) * 4 + c] / 100;
  return out;
};
test("SH3 retains relative local-view colors through rotated normalization and placement", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).general.directional(0, false));
  const a = center(
    await page.locator("#general").screenshot({
      style: "label, #debug { visibility: hidden !important; }",
    }),
  );
  await page.evaluate(() =>
    (window as any).general.directional(Math.PI / 2, false),
  );
  const b = center(
    await page.locator("#general").screenshot({
      style: "label, #debug { visibility: hidden !important; }",
    }),
  );
  expect(Math.max(...a.map((v, i) => Math.abs(v - b[i])))).toBeLessThan(4);
  await page.evaluate(() =>
    (window as any).general.directional(Math.PI / 2, true),
  );
  const changed = center(
    await page.locator("#general").screenshot({
      style: "label, #debug { visibility: hidden !important; }",
    }),
  );
  expect(
    Math.max(...a.map((v, i) => Math.abs(v - changed[i]))),
  ).toBeGreaterThan(15);
});
for (const kind of ["packed", "ext", "mesh"] as const)
  test(`paused/failed ${kind} candidate never publishes and ten cycles release`, async ({
    page,
  }) => {
    await ready(page);
    const baseline = await page.evaluate(() =>
      (window as any).general.probe.snapshot(),
    );
    for (let i = 0; i < 10; i++) {
      await page.evaluate(
        (k) => (window as any).general.beginCandidate(k, "pause"),
        kind,
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).general.probe.snapshot().initializationHeld,
          ),
        )
        .toBe(true);
      expect(
        await page.evaluate(
          () => (window as any).general.view.stats().instanceCount,
        ),
      ).toBe(2);
      await page.evaluate(() => (window as any).general.cancel());
      await expect
        .poll(() => page.evaluate(() => (window as any).general.lastError))
        .toContain("AbortError");
      await page.evaluate(() =>
        (window as any).general.probe.resumeInitialization("late failure"),
      );
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).general.probe.snapshot().live),
        )
        .toEqual(baseline.live);
    }
    await page.evaluate(
      (k) => (window as any).general.beginCandidate(k, "fail"),
      kind,
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).general.lastError))
      .toContain("injected");
    await page.evaluate(() =>
      (window as any).general.probe.resumeInitialization(),
    );
    expect(
      await page.evaluate(
        () => (window as any).general.view.stats().instanceCount,
      ),
    ).toBe(2);
    expect(
      pixels(
        await page.locator("#general").screenshot({
          style: "label, #debug { visibility: hidden !important; }",
        }),
      ),
    ).toBeGreaterThan(500);
    await page.evaluate(() => (window as any).general.release());
    expect(
      await page.evaluate(() => (window as any).general.probe.snapshot().live),
    ).toEqual({ packed: 0, ext: 0, mesh: 0 });
    expect(
      await page.evaluate(
        () => (window as any).general.view.stats().ownedBytes,
      ),
    ).toBe(0);
  });
test("ten activated rollback/commit cycles keep source and material ownership stable", async ({
  page,
}) => {
  await ready(page);
  const baseline = await page.evaluate(() =>
    (window as any).general.probe.snapshot(),
  );
  for (let i = 0; i < 10; i++)
    await page.evaluate(() => (window as any).general.rollbackCycle());
  const after = await page.evaluate(() =>
    (window as any).general.probe.snapshot(),
  );
  expect(after.live).toEqual(baseline.live);
  expect(after.programReferences).toBe(baseline.programReferences);
  await page.evaluate(() => (window as any).general.release());
  expect(
    await page.evaluate(() => (window as any).general.view.stats()),
  ).toEqual({
    sourceCount: 0,
    instanceCount: 0,
    activeSplats: 0,
    ownedBytes: 0,
  });
});

test("renderer accepts 121 Gaussian nodes and rejects the 122nd without losing the scene", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).general.nodeGrid(121));
  expect(
    await page.evaluate(() => (window as any).general.view.stats()),
  ).toMatchObject({ sourceCount: 1, instanceCount: 121, activeSplats: 121 });
  expect(
    pixels(
      await page
        .locator("#general")
        .screenshot({ style: "label, #debug {visibility:hidden!important}" }),
    ),
  ).toBeGreaterThan(1500);
  await expect(
    page.evaluate(() => (window as any).general.nodeGrid(122)),
  ).rejects.toThrow(/node budget/);
  expect(
    await page.evaluate(
      () => (window as any).general.view.stats().instanceCount,
    ),
  ).toBe(121);
  await page.evaluate(() => (window as any).general.release());
  expect(
    await page.evaluate(() => (window as any).general.view.stats().ownedBytes),
  ).toBe(0);
});

for (const empty of [false, true])
  test(`sort completion alone cannot commit a ${empty ? "empty" : "nonempty"} candidate before its draw`, async ({
    page,
  }) => {
    await ready(page);
    await page.evaluate(
      (empty) => (window as any).general.beginDelayedDisplay(empty),
      empty,
    );
    const before = await page
      .locator("#general")
      .screenshot({ style: "label, #debug {visibility:hidden!important}" });
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).general.delayedState().sorted),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => (window as any).general.delayedState()),
    ).toMatchObject({
      usable: false,
      wasDrawn: false,
      live: { packed: empty ? 1 : 2, ext: 0, mesh: empty ? 2 : 3 },
    });
    expect(
      await page.evaluate(() => (window as any).general.commitDelayed()),
    ).toBe(false);
    const between = await page
      .locator("#general")
      .screenshot({ style: "label, #debug {visibility:hidden!important}" });
    expect(PNG.sync.read(between).data.equals(PNG.sync.read(before).data)).toBe(
      true,
    );
    await page.evaluate(() => (window as any).general.drawDelayed());
    expect(
      await page.evaluate(() => (window as any).general.delayedState()),
    ).toMatchObject({ usable: true, wasDrawn: true });
    expect(
      await page.evaluate(() => (window as any).general.commitDelayed()),
    ).toBe(true);
    expect(
      await page.evaluate(() => (window as any).general.probe.snapshot().live),
    ).toEqual({ packed: empty ? 0 : 1, ext: 0, mesh: empty ? 0 : 1 });
    const after = await page
      .locator("#general")
      .screenshot({ style: "label, #debug {visibility:hidden!important}" });
    expect(PNG.sync.read(after).data.equals(PNG.sync.read(before).data)).toBe(
      false,
    );
    if (empty) expect(pixels(after)).toBe(0);
    else expect(pixels(after)).toBeGreaterThan(250);
    await page.evaluate(() => (window as any).general.release());
  });

test("padded renderer budget covers real targets and retains high-water allocations through disposal", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await page.evaluate(() => (window as any).general.nodeGrid(121));
  await page.evaluate(() =>
    (window as any).general.camera({
      position: [0.1, 0, 5],
      target: [0, 0, 0],
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).general.probe.snapshot().sorting),
    )
    .toBe(false);
  const large = await page.evaluate(() =>
    (window as any).general.resourceState(),
  );
  expect(large.version).toBe("2.3.1");
  expect(large.observed.configuration).toEqual({
    accumExtSplats: false,
    covSplats: false,
    enableLod: false,
    enableDriveLod: false,
    pagedExtSplats: false,
    hasTarget: false,
  });
  expect(large.stats).toMatchObject({
    sourceCount: 1,
    instanceCount: 121,
    activeSplats: 121,
    ownedBytes: 40173624,
  });
  expect(
    large.observed.accumulators.filter(
      (a: any) => a.target && a.maxSplats === 247808,
    ).length,
  ).toBeGreaterThanOrEqual(2);
  expect(large.observed.targetBytes).toBeGreaterThanOrEqual(9912320);
  expect(large.observed.orderingHighWater).toBe(262144);
  expect(large.observed.readbackBytes).toBe(991232);
  expect(
    large.observed.targetBytes +
      large.observed.orderingCpuBytes +
      large.observed.readbackBytes,
  ).toBeLessThan(large.budgetFor121.reservedBytes);
  await saveEvidence(testInfo, "spark-resource-121.png", {
    body: await page
      .locator("#general")
      .screenshot({ style: "label, #debug { visibility:hidden!important }" }),
    contentType: "image/png",
  });
  await page.evaluate(() => (window as any).general.nodeGrid(1));
  const small = await page.evaluate(() =>
    (window as any).general.resourceState(),
  );
  expect(small.stats.ownedBytes).toBe(large.stats.ownedBytes);
  expect(small.observed.orderingHighWater).toBe(262144);
  await page.evaluate(() => (window as any).general.nodeGrid(0));
  const empty = await page.evaluate(() =>
    (window as any).general.resourceState(),
  );
  expect(empty.stats).toEqual({
    sourceCount: 0,
    instanceCount: 0,
    activeSplats: 0,
    ownedBytes: 40108032,
  });
  expect(empty.observed.orderingHighWater).toBe(262144);
  await page.evaluate(() => (window as any).general.beginResourceDisposal());
  const retiring = await page.evaluate(() => ({
    state: (window as any).general.resourceState(),
    sorting: (window as any).general.probe.snapshot().sorting,
    done: (window as any).general.resourceDisposalDone,
  }));
  expect(retiring.done).toBe(false);
  expect(retiring.sorting).toBe(true);
  expect(retiring.state.stats.ownedBytes).toBe(40108032);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).general.resourceDisposalDone),
    )
    .toBe(true);
  const released = await page.evaluate(() =>
    (window as any).general.resourceState(),
  );
  expect(released.stats.ownedBytes).toBe(0);
  expect(released.observed).toMatchObject({
    targetBytes: 0,
    orderingCpuBytes: 0,
    uniformOrderingBytes: 0,
    readbackBytes: 0,
  });
  expect(
    released.observed.accumulators.every((a: any) => a.mappingNodes === 0),
  ).toBe(true);
  expect(errors).toEqual([]);
  await saveEvidence(testInfo, "spark-resource-evidence.json", {
    body: Buffer.from(
      JSON.stringify(
        {
          scope:
            "Application known allocations only; not performance, visual admission, private WASM heap or driver measurement",
          diagnostics: await page.evaluate(() =>
            (window as any).general.diagnostics(),
          ),
          large,
          small,
          empty,
          retiring,
          released,
          errors,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
});

for (const kind of ["packed", "ext", "mesh"] as const)
  test(`dispose keeps late ${kind} initialization reserved until its cleanup`, async ({
    page,
  }, testInfo) => {
    await ready(page);
    await page.evaluate(
      (kind) => (window as any).general.beginCandidate(kind, "pause"),
      kind,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).general.probe.snapshot().initializationHeld,
        ),
      )
      .toBe(true);
    await page.evaluate(() => (window as any).general.cancel());
    await expect
      .poll(() => page.evaluate(() => (window as any).general.lastError))
      .toContain("AbortError");
    await page.evaluate(() => (window as any).general.release());
    const retiring = await page.evaluate(() =>
      (window as any).general.resourceState(),
    );
    expect(retiring.stats.ownedBytes).toBeGreaterThanOrEqual(8 * 1024 ** 2);
    expect(retiring.observed.readbackBytes).toBeGreaterThan(0);
    await page.evaluate(() =>
      (window as any).general.probe.resumeInitialization("late rejection"),
    );
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).general.view.stats().ownedBytes),
      )
      .toBe(0);
    const released = await page.evaluate(() =>
      (window as any).general.resourceState(),
    );
    expect(released.observed).toMatchObject({
      targetBytes: 0,
      readbackBytes: 0,
      uniformOrderingBytes: 0,
    });
    expect(
      released.observed.accumulators.every((a: any) => a.mappingNodes === 0),
    ).toBe(true);
    await saveEvidence(testInfo, `spark-late-${kind}-evidence.json`, {
      body: Buffer.from(JSON.stringify({ retiring, released }, null, 2)),
      contentType: "application/json",
    });
  });
