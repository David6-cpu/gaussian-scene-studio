import { test, expect, type Page } from "@playwright/test";
import {
  environmentSpz,
  environmentWorld,
  jsonBytes,
} from "../support/environment-fixture";
import {
  createWorkbenchFixture,
  observeWorkbenchErrors,
  installWorkbenchFixture,
  installWorkbenchDrawObservation,
  readWorkbenchDatabase,
  workbenchPrompts,
} from "../support/general-workbench-fixture";

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

async function holdRecovery(page: Page) {
  await page.goto("/tests/harness.html?workbench=1&advanced");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.evaluate(() => {
    const ext = document
      .querySelector("canvas")!
      .getContext("webgl2")!
      .getExtension("WEBGL_lose_context")!;
    (window as any).recoveryLoss = ext;
    ext.loseContext();
  });
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "context-lost",
  );
  await page.evaluate(() => {
    window.sparkProbe.pauseInitialization("packed");
    (window as any).recoveryLoss.restoreContext();
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.sparkProbe.snapshot().initializationHeld),
    )
    .toBe(true);
  await page.evaluate(() => {
    const v = (window as any).workbench.view,
      prepare = v.prepareScene.bind(v);
    (window as any).recoveryTrace = { calls: 0, prepared: false, swaps: [] };
    v.prepareScene = async (...args: any[]) => {
      (window as any).recoveryTrace.calls++;
      const swap = await prepare(...args);
      (window as any).recoveryTrace.prepared = true;
      for (const name of ["activate", "rollback", "commit"] as const) {
        const original = swap[name].bind(swap);
        swap[name] = (...methodArgs: any[]) => {
          const result = original(...methodArgs);
          (window as any).recoveryTrace.swaps.push({name, time: performance.now()});
          return result;
        };
      }
      return swap;
    };
  });
}

test("cancelled recovery cannot start a late scene transaction", async ({
  page,
}) => {
  await holdRecovery(page);
  await page.locator("#cancel").click();
  await page.evaluate(() => window.sparkProbe.resumeInitialization());
  await expect
    .poll(() => page.evaluate(() => window.sparkProbe.snapshot().live.packed))
    .toBe(0);
  expect(await page.evaluate(() => (window as any).recoveryTrace.calls)).toBe(
    0,
  );
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "cancelled",
  );
});

async function actualLegacyFrames(page: Page, count = 2) {
  const frame = await page.evaluate(() => (window as any).workbench.observe().legacyFrames);
  await expect.poll(() => page.evaluate(() => (window as any).workbench.observe().legacyFrames)).toBeGreaterThanOrEqual(frame + count);
}
async function stableLegacyCamera(page: Page) {
  // OrbitControls updates only through the actual main render loop. Capture the
  // exact settled value rather than a pre-update top-view value or an epsilon.
  await actualLegacyFrames(page);
  const camera = await page.evaluate(() => (window as any).workbench.view.getCamera());
  await actualLegacyFrames(page);
  expect(await page.evaluate(() => (window as any).workbench.view.getCamera())).toEqual(camera);
  return camera;
}
async function heldRecoveryOwnership(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).workbench.general.diagnostics().lease.queued)).toBeGreaterThan(0);
  const observed = await page.evaluate(() => {
    const w = (window as any).workbench, residency = w.view.residency();
    return { trace: (window as any).recoveryTrace,
      initializationHeld: window.sparkProbe.snapshot().initializationHeld,
      lease: w.general.diagnostics().lease,
      residency: {settled: residency.settled, extraBytes: residency.extraBytes,
        bufferBytes: residency.buffers.reduce((n: number, b: ArrayBuffer) => n + b.byteLength, 0)} };
  });
  expect(observed.initializationHeld).toBe(true);
  expect(observed.trace.calls).toBe(0);
  expect(observed.trace.prepared).toBe(false);
  expect(observed.trace.swaps).toEqual([]);
  expect(observed.lease.running).toBe("legacy");
  expect(observed.residency.settled).toBe(false);
  expect(observed.residency.bufferBytes + observed.residency.extraBytes).toBeGreaterThan(0);
  await expect(page.locator("#status")).not.toHaveAttribute("data-state", "ready");
  return observed;
}

test("late recovery cannot roll back a newer activated scene", async ({ page }, info) => {
  await holdRecovery(page);
  await page.evaluate(() => {
    const v = (window as any).workbench.view;
    (window as any).originalDisplayed = v.isCurrentSceneDisplayed.bind(v);
    v.isCurrentSceneDisplayed = () => false;
  });
  await page.locator("#seed").fill("842");
  await page.locator("#generate").click();
  // The real old initializer holds the sole lease. A newer allocation cannot
  // finish first; prove serialization before releasing that actual initializer.
  const held = await heldRecoveryOwnership(page);
  await page.evaluate(() => window.sparkProbe.resumeInitialization());
  await expect.poll(() => page.evaluate(() => (window as any).recoveryTrace.prepared)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).recoveryTrace.swaps.map((s: any) => s.name))).toEqual(["activate"]);
  expect(await page.evaluate(() => (window as any).recoveryTrace.calls)).toBe(1);
  await page.evaluate(() => {
    (window as any).workbench.view.isCurrentSceneDisplayed = (window as any).originalDisplayed;
  });
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "842");
  await actualLegacyFrames(page, 3);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "842");
  const final = await page.evaluate(() => ({trace: (window as any).recoveryTrace, recipe: (window as any).workbench.result.recipe}));
  expect(final.trace.calls).toBe(1);
  expect(final.trace.swaps.map((s: any) => s.name)).toEqual(["activate", "commit"]);
  expect(final.recipe.seed).toBe(842);
  await info.attach("actual-held-recovery-and-new-swap", {body:JSON.stringify({held, final}),contentType:"application/json"});
});

test("obsolete recovery rejection cannot replace the newer success status", async ({ page }, info) => {
  await holdRecovery(page);
  await page.locator("#seed").fill("843");
  await page.locator("#generate").click();
  const held = await heldRecoveryOwnership(page);
  await page.evaluate(() => window.sparkProbe.resumeInitialization("injected obsolete recovery failure"));
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "843");
  await actualLegacyFrames(page, 3);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "843");
  const final = await page.evaluate(() => ({trace: (window as any).recoveryTrace, recipe: (window as any).workbench.result.recipe}));
  expect(final.trace.calls).toBe(1);
  expect(final.trace.swaps.map((s: any) => s.name)).toEqual(["activate", "commit"]);
  expect(final.recipe.seed).toBe(843);
  await info.attach("actual-held-rejection-and-new-swap", {body:JSON.stringify({held, final}),contentType:"application/json"});
});

async function prepareNaturalPreview(page: Page) {
  await page.locator("#general-prompt").fill(workbenchPrompts.dry);
  await page.locator("#general-plan").click();
  await expect(page.locator("#general-status")).toHaveAttribute(
    "data-phase",
    "awaiting-review",
  );
  await finishNaturalPreview(page);
}
async function finishNaturalPreview(page: Page) {
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
}
const ownership = (page: Page) =>
  page.evaluate(() => ({
    legacy: (window as any).workbench.observe(),
    general: (window as any).workbench.general.diagnostics(),
    draws: (window as any).generalWorkbenchDrawObservation.snapshot(),
  }));

for (const completion of ["success", "failure"] as const) {
  test(`late old recovery ${completion} cannot reclaim natural-scene RAF or actual drawing`, async ({
    page,
  }, info) => {
    await installWorkbenchFixture(page, await createWorkbenchFixture());
    await installWorkbenchDrawObservation(page);
    await holdRecovery(page);
    await page.locator("#general-prompt").fill(workbenchPrompts.dry);
    await page.locator("#general-plan").click();
    await expect(page.locator("body")).toHaveClass(/general-mode/);
    await page.evaluate(
      (error) => window.sparkProbe.resumeInitialization(error),
      completion === "failure"
        ? "Constructed obsolete old recovery failure"
        : undefined,
    );
    await expect(page.locator("#general-status")).toHaveAttribute(
      "data-phase",
      "awaiting-review",
    );
    await finishNaturalPreview(page);
    const before = await ownership(page);
    expect(before.legacy.mode).toBe("general");
    expect(before.legacy.legacyRafActive).toBe(false);
    expect(before.general.rafActive).toBe(true);
    expect(before.draws.counts["general-scene-canvas"]).toBeGreaterThan(0);
    await page.waitForTimeout(200);
    const after = await ownership(page);
    expect(after.legacy.legacyFrames).toBe(before.legacy.legacyFrames);
    expect(after.draws.counts["湿地高斯场景"]).toBe(
      before.draws.counts["湿地高斯场景"],
    );
    expect(after.draws.counts["general-scene-canvas"]).toBeGreaterThan(
      before.draws.counts["general-scene-canvas"],
    );
    expect(await page.evaluate(() => (window as any).recoveryTrace.calls)).toBe(
      0,
    );
    await expect(page.locator("#scene-title")).toContainText("自然场景");
    expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
    await info.attach("actual-cross-mode-draw-ownership", {
      body: JSON.stringify({ completion, before, after }, null, 2),
      contentType: "application/json",
    });
  });
}

test("return from unsaved natural preview restores the original legacy scene and camera with one renderer loop", async ({
  page,
}, info) => {
  await installWorkbenchFixture(page, await createWorkbenchFixture());
  await installWorkbenchDrawObservation(page);
  await page.goto("/tests/harness.html?workbench=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator('.camera-bar [data-camera="top"]').click();
  await stableLegacyCamera(page);
  const original = await page.evaluate(() => ({
    recipe: (window as any).workbench.result.recipe,
    camera: (window as any).workbench.view.getCamera(),
    title: document.querySelector("#scene-title")!.textContent,
  }));
  await prepareNaturalPreview(page);
  await page.locator("#general-leave").click();
  await expect(page.locator("#general-scene-canvas")).toBeHidden();
  await expect
    .poll(async () => (await ownership(page)).general.residency.settled)
    .toBe(true);
  const before = await ownership(page);
  expect(before.general.rafActive).toBe(false);
  expect(before.legacy.legacyRafActive).toBe(true);
  const restored = await page.evaluate(() => ({
    recipe: (window as any).workbench.result.recipe,
    camera: (window as any).workbench.view.getCamera(),
    title: document.querySelector("#scene-title")!.textContent,
  }));
  expect(restored).toEqual(original);
  await page.waitForTimeout(200);
  const after = await ownership(page);
  expect(after.draws.counts["general-scene-canvas"]).toBe(
    before.draws.counts["general-scene-canvas"],
  );
  expect(after.draws.counts["湿地高斯场景"]).toBeGreaterThan(
    before.draws.counts["湿地高斯场景"],
  );
  expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
  await info.attach("restored-legacy-owner", {
    body: JSON.stringify({ original, restored, before, after }, null, 2),
    contentType: "application/json",
  });
});

test("mode switch at native commit completion retains the actual save receipt without drawing over legacy", async ({
  page,
}, info) => {
  await installWorkbenchFixture(page, await createWorkbenchFixture());
  await installWorkbenchDrawObservation(page);
  await page.goto("/tests/harness.html?workbench=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await prepareNaturalPreview(page);
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    (window as any).generalCommitSwitch = {
      armed: true,
      nativeComplete: false,
    };
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = original.apply(this, args);
      if (
        this.name === "gaussian-general-scenes" &&
        transaction.mode === "readwrite" &&
        ["scenes", "revisions", "operations"].every((name) =>
          transaction.objectStoreNames.contains(name),
        )
      ) {
        IDBDatabase.prototype.transaction = original;
        transaction.addEventListener(
          "complete",
          () => {
            const observed = (window as any).generalCommitSwitch;
            observed.nativeComplete = true;
            const state = (
              window as any
            ).workbench.general.panelPorts.controller.getState();
            observed.phaseBefore = state.phase;
            observed.finalizationBefore = state.finalization;
            document
              .querySelector<HTMLButtonElement>("#general-leave")!
              .click();
          },
          { once: true },
        );
      }
      return transaction;
    };
  });
  await page.locator("#general-use").click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).generalCommitSwitch.nativeComplete),
    )
    .toBe(true);
  await expect(page.locator("#general-saved")).toContainText("已保存");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).workbench.general.panelPorts.controller.getState()
            .finalization.kind,
      ),
    )
    .toBe("none");
  const result = await page.evaluate(() => ({
    state: (window as any).workbench.general.panelPorts.controller.getState(),
    switch: (window as any).generalCommitSwitch,
  }));
  expect(result.switch.phaseBefore).toBe("saving");
  expect(result.state.lastSave).not.toBeNull();
  expect(result.state.current.revisionId).toBe(
    result.state.lastSave.revisionId,
  );
  const database = await readWorkbenchDatabase(page);
  expect(database.scenes).toHaveLength(1);
  expect(database.revisions).toHaveLength(1);
  expect(database.operations).toHaveLength(1);
  expect(database.revisions[0]).toEqual(
    expect.objectContaining({
      status: "committed",
      revisionId: result.state.lastSave.revisionId,
    }),
  );
  const before = await ownership(page);
  expect(before.legacy.mode).toBe("legacy");
  expect(before.legacy.legacyRafActive).toBe(true);
  expect(before.general.rafActive).toBe(false);
  await page.waitForTimeout(200);
  const after = await ownership(page);
  expect(after.draws.counts["general-scene-canvas"]).toBe(
    before.draws.counts["general-scene-canvas"],
  );
  expect(after.draws.counts["湿地高斯场景"]).toBeGreaterThan(
    before.draws.counts["湿地高斯场景"],
  );
  await info.attach("native-commit-mode-switch", {
    body: JSON.stringify({ result, database, before, after }, null, 2),
    contentType: "application/json",
  });
});

for (const completion of ["success", "failure"] as const) {
  test(`legacy initial catalog ${completion} holds ownership until settled then permits ordinary manual planning`, async ({
    page,
  }, info) => {
    await installWorkbenchFixture(page, await createWorkbenchFixture());
    await installWorkbenchDrawObservation(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/planner/assets/catalog", async (route) => {
      requested = true;
      if (completion === "failure") {
        await held;
        await route.fulfill({
          status: 503,
          body: "Constructed initial legacy catalog outage",
        });
      } else {
        const actual = await route.fetch();
        await held;
        await route.fulfill({ response: actual });
      }
    });
    await page.goto("/tests/harness.html?workbench=1", { waitUntil: "commit" });
    await expect.poll(() => requested).toBe(true);
    // An empty description is now rejected before mode entry, so fill it to
    // exercise the initialization guard itself.
    await page.locator("#general-prompt").fill(workbenchPrompts.dry);
    await page.locator("#general-manual").click();
    await expect(page.locator("#general-message")).toContainText(
      /等待|稍后|初始化/,
    );
    await expect(page.locator("body")).not.toHaveClass(/general-mode/);
    expect(
      await page.evaluate(
        () =>
          (window as any).generalWorkbenchDrawObservation.snapshot().counts[
            "general-scene-canvas"
          ] ?? 0,
      ),
    ).toBe(0);
    release();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      completion === "success" ? "ready" : "error",
    );
    await page.waitForFunction(() => Boolean((window as any).workbench));
    await page.locator("#general-prompt").fill(workbenchPrompts.dry);
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
    await finishNaturalPreview(page);
    const before = await ownership(page);
    expect(before.legacy.mode).toBe("general");
    expect(before.legacy.legacyRafActive).toBe(false);
    expect(before.general.rafActive).toBe(true);
    await page.waitForTimeout(200);
    const after = await ownership(page);
    expect(after.legacy.legacyFrames).toBe(before.legacy.legacyFrames);
    expect(after.draws.counts["general-scene-canvas"]).toBeGreaterThan(
      before.draws.counts["general-scene-canvas"] ?? 0,
    );
    expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
    await info.attach("actual-initialization-ownership", {
      body: JSON.stringify({ completion, before, after }),
      contentType: "application/json",
    });
  });
}

test("saved local environment and natural preview switch without concurrent drawing or losing the original camera", async ({
  page,
}, info) => {
  await installWorkbenchFixture(page, await createWorkbenchFixture());
  await installWorkbenchDrawObservation(page);
  await page.goto("/tests/harness.html?workbench=1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator('.camera-bar [data-camera="top"]').click();
  const camera = await stableLegacyCamera(page);
  await page.locator("#environment-details > summary").click();
  await page
    .locator("#environment-world-file")
    .setInputFiles({
      name: "constructed-world.json",
      mimeType: "application/json",
      buffer: Buffer.from(jsonBytes(environmentWorld())),
    });
  await page
    .locator("#environment-spz-file")
    .setInputFiles({
      name: "constructed.spz",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(environmentSpz()),
    });
  await page.locator("#environment-import").click();
  await expect(page.locator("#environment-status")).toContainText("预览就绪");
  await page.locator("#environment-save").click();
  await expect(page.locator("#environment-status")).toContainText("已保存");
  await expect(page.locator("#environment-list button")).toHaveCount(1);
  await prepareNaturalPreview(page);
  await expect(page.locator("#environment-canvas")).toBeHidden();
  const generalBefore = await ownership(page);
  expect(generalBefore.legacy.mode).toBe("general");
  expect(generalBefore.legacy.legacyRafActive).toBe(false);
  await page.waitForTimeout(200);
  const generalAfter = await ownership(page);
  expect(generalAfter.draws.counts["environment-canvas"]).toBe(
    generalBefore.draws.counts["environment-canvas"],
  );
  expect(generalAfter.draws.counts["general-scene-canvas"]).toBeGreaterThan(
    generalBefore.draws.counts["general-scene-canvas"] ?? 0,
  );
  await page.locator("#environment-list button").click();
  await expect(page.locator("#environment-status")).toContainText("预览就绪");
  await expect(page.locator("#general-scene-canvas")).toBeHidden();
  const environmentBefore = await ownership(page);
  expect(environmentBefore.legacy.mode).toBe("environment");
  expect(environmentBefore.general.rafActive).toBe(false);
  await page.waitForTimeout(200);
  const environmentAfter = await ownership(page);
  expect(environmentAfter.draws.counts["general-scene-canvas"]).toBe(
    environmentBefore.draws.counts["general-scene-canvas"],
  );
  expect(environmentAfter.draws.counts["environment-canvas"]).toBeGreaterThan(
    environmentBefore.draws.counts["environment-canvas"] ?? 0,
  );
  await page.locator("#environment-return").click();
  expect(
    await page.evaluate(() => (window as any).workbench.view.getCamera()),
  ).toEqual(camera);
  expect((await readWorkbenchDatabase(page)).scenes).toHaveLength(0);
  await info.attach("actual-environment-general-ownership", {
    body: JSON.stringify({
      camera,
      generalBefore,
      generalAfter,
      environmentBefore,
      environmentAfter,
    }),
    contentType: "application/json",
  });
});
