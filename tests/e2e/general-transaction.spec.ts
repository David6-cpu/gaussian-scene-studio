import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";

const diagnosticUrl = (url: string) =>
  url.startsWith("data:")
    ? `data:[length=${url.length},sha256=${createHash("sha256").update(url).digest("hex")}]`
    : url;
const call = (page: Page, action: string, options: unknown = {}) =>
  page.evaluate(
    ({ action, options }) =>
      (window as any).general.transaction(action, options),
    { action, options },
  );
async function ready(page: Page) {
  await page.goto("/tests/general-harness.html");
  await page.waitForFunction(() => (window as any).general?.ready);
}
async function refresh(page: Page) {
  await page.reload();
  await page.waitForFunction(() => (window as any).general?.ready);
}
async function attach(info: TestInfo, name: string, value: unknown) {
  await info.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}
const committed = (records: any) =>
  records.revisions.filter((r: any) => r.status === "committed");

test.beforeEach(async ({ page }) => {
  await ready(page);
});

test.afterEach(async ({ page }, info) => {
  if (info.status !== "passed") return;
  await attach(info, "final-native-observations", await call(page, "inspect"));
  await info.attach("final-actual-canvas", {
    body: await page.locator("#general").screenshot(),
    contentType: "image/png",
  });
});

test("transaction harness exposes the real controller boundary", async ({
  page,
}) => {
  expect(
    await page.evaluate(() => typeof (window as any).general.transaction),
  ).toBe("function");
});

test("native staging before commit survives refresh with the previous pointer, camera and history", async ({
  page,
}) => {
  const first = await call(page, "seed");
  const candidate = await call(page, "preview");
  const held = await call(page, "stage-hold");
  expect(held.stage.revisionId).toBe(candidate.revisionId);
  expect(
    held.records.revisions.find(
      (r: any) => r.revisionId === candidate.revisionId,
    ).status,
  ).toBe("staging");
  expect(held.records.scenes[0].currentRevisionId).toBe(first.revisionId);
  expect(committed(held.records)).toHaveLength(1);
  await refresh(page);
  const reopened = await call(page, "reopen", { sceneId: first.sceneId });
  expect(reopened.revisionId).toBe(first.revisionId);
  expect(reopened.digest).toBe(first.digest);
  expect(reopened.camera).toEqual(first.camera);
  expect(reopened.drawnNodes).toBeGreaterThan(0);
  expect(reopened.counts.build).toBe(0);
  expect(reopened.stats.sourceCount).toBe(first.stats.sourceCount);
});

for (const kind of ["quota", "abort-commit"])
  test(`native ${kind} before publication rolls back candidate and preserves current`, async ({
    page,
  }) => {
    const first = await call(page, "seed");
    const candidate = await call(page, "preview");
    const out = await call(page, "fault", { kind });
    expect(out.injected).toBe(true);
    expect(out.result.ok).toBe(false);
    expect(out.current.revisionId).toBe(first.revisionId);
    expect(out.current.digest).toBe(first.digest);
    expect(out.camera).toEqual(first.camera);
    expect(committed(out.records)).toHaveLength(1);
    expect(out.records.operations).toHaveLength(1);
    expect(out.records.scenes[0].currentRevisionId).not.toBe(
      candidate.revisionId,
    );
    expect(out.stats.sourceCount).toBe(first.stats.sourceCount);
    await refresh(page);
    expect(
      (await call(page, "reopen", { sceneId: first.sceneId })).revisionId,
    ).toBe(first.revisionId);
  });

for (const fault of ["gpu", "cancel"] as const)
  test(`native transaction complete followed by ${fault} alone preserves the saved receipt and restores`, async ({
    page,
  }) => {
    const first = await call(page, "seed");
    const candidate = await call(page, "preview");
    const out = await call(page, "fault", { kind: `after-complete-${fault}` });
    console.info("T12_POST_COMPLETE_FAULT", JSON.stringify(out));
    expect(out.injected).toBe(true);
    expect(out.nativeComplete).toBe(true);
    expect(out.result.ok).toBe(true);
    expect(out.result.value.revisionId).toBe(candidate.revisionId);
    expect(out.result.value.displayStatus).toBe("recovering");
    expect(out.state.lastSave.revisionId).toBe(candidate.revisionId);
    expect(out.current.revisionId).toBe(candidate.revisionId);
    expect(out.records.scenes[0].currentRevisionId).toBe(candidate.revisionId);
    expect(committed(out.records)).toHaveLength(2);
    expect(out.records.operations).toHaveLength(2);
    let reopened;
    if (fault === "gpu") {
      expect(out.activity.available).toBe(false);
      expect(out.counts.replace).toBe(0);
      // Stay in this page: only the controller's replacement host may recover it.
      reopened = await call(page, "reopen", { sceneId: first.sceneId });
      expect(reopened.counts.replace).toBe(1);
      expect(reopened.counts.build).toBe(candidate.counts.build);
      expect(reopened.counts.resolve).toBe(candidate.counts.resolve);
      expect(reopened.counts.planner).toBe(candidate.counts.planner);
      expect(reopened.drawSerial).toBeGreaterThan(out.drawSerial);
      expect(
        reopened.drawnIds.every(
          (id: string) => !candidate.drawnIds.includes(id),
        ),
      ).toBe(true);
      expect(reopened.activity.available).toBe(true);
    } else {
      await refresh(page);
      reopened = await call(page, "reopen", { sceneId: first.sceneId });
      expect(reopened.counts.build).toBe(0);
      expect(reopened.counts.resolve).toBe(0);
    }
    expect(reopened.revisionId).toBe(candidate.revisionId);
    expect(reopened.digest).toBe(candidate.digest);
    expect(reopened.stats.sourceCount).toBe(candidate.renderSourceCount);
    expect(reopened.drawnNodes).toBeGreaterThan(0);
    expect(reopened.drawnNodes).toBe(reopened.stats.instanceCount);
    console.info(
      "T12_NATIVE_COMPLETE_EVIDENCE",
      JSON.stringify({ first, candidate, out, reopened }),
    );
  });

test("preview cancellation restores the parent's current user camera and actual draw without changing saved data", async ({
  page,
}) => {
  const first = await call(page, "seed");
  const userCamera = { position: [8, 6, 7], target: [0.4, 0.1, -0.3] };
  const moved = await call(page, "camera", { camera: userCamera });
  expect(moved.camera).toEqual(userCamera);
  expect(moved.camera).not.toEqual(first.storedCamera);
  expect(moved.current.digest).toBe(first.digest);
  await call(page, "preview");
  const candidateCamera = { position: [6, 5, 4], target: [0.2, 0.1, 0] };
  await call(page, "camera", { camera: candidateCamera });
  const cancelled = await call(page, "cancel");
  expect(cancelled.immediate.phase).toBe("idle");
  expect(cancelled.cancelMs).toBeLessThan(1000);
  const restored = await call(page, "settle", { drawnIds: moved.drawnIds });
  expect(restored.camera).toEqual(userCamera);
  expect(restored.camera).not.toEqual(first.storedCamera);
  expect(restored.current.revisionId).toBe(first.revisionId);
  expect(restored.current.digest).toBe(first.digest);
  expect(restored.current.storedCamera).toEqual(first.storedCamera);
  expect(restored.stats.sourceCount).toBe(first.stats.sourceCount);
  expect(restored.drawnIds.slice().sort()).toEqual(
    moved.drawnIds.slice().sort(),
  );
  expect(restored.drawSerial).toBeGreaterThan(moved.drawSerial);
  expect(restored.drawnNodes).toBeGreaterThan(0);
  expect(restored.drawnNodes).toBe(restored.stats.instanceCount);
  expect(restored.counts.replace).toBe(0);
  expect(committed(restored.records)).toHaveLength(1);
  expect(restored.records.operations).toHaveLength(1);
});

test("a candidate with no actual draw cannot be used or published", async ({
  page,
}) => {
  const first = await call(page, "seed");
  const waiting = await call(page, "preview-undrawn");
  expect(waiting.waitingForDisplay).toBe(true);
  expect(waiting.usable).toBe(false);
  const denied = await call(page, "use");
  expect(denied.ok).toBe(false);
  const cancelled = await call(page, "cancel");
  expect(cancelled.cancelMs).toBeLessThan(1000);
  expect(cancelled.immediate.phase).toBe("idle");
  const out = await call(page, "settle");
  expect(out.current.revisionId).toBe(first.revisionId);
  expect(out.camera).toEqual(first.camera);
  expect(committed(out.records)).toHaveLength(1);
  expect(out.stats.sourceCount).toBe(first.stats.sourceCount);
});

test("duplicate use commits one native revision and reopened results never rebuild", async ({
  page,
}) => {
  const first = await call(page, "seed");
  const candidate = await call(page, "preview");
  const out = await call(page, "double-use");
  expect(out.results.every((r: any) => r.ok)).toBe(true);
  expect(out.results.map((r: any) => r.value.revisionId)).toEqual([
    candidate.revisionId,
    candidate.revisionId,
  ]);
  expect(committed(out.records)).toHaveLength(2);
  expect(out.records.operations).toHaveLength(2);
  expect(out.counts.commit).toBe(2);
  await refresh(page);
  const reopened = await call(page, "reopen", { sceneId: first.sceneId });
  expect(reopened.digest).toBe(candidate.digest);
  expect(reopened.counts.build).toBe(0);
  expect(reopened.counts.resolve).toBe(0);
  expect(reopened.drawnNodes).toBeGreaterThan(0);
});

test("cancelled late GPU initialization keeps resources accounted until settlement", async ({
  page,
}) => {
  const first = await call(page, "seed");
  const held = await call(page, "preview-late-initialization");
  expect(held.initializationHeld).toBe(true);
  const out = await call(page, "cancel");
  expect(out.immediate.phase).toBe("idle");
  expect(out.cancelMs).toBeLessThan(1000);
  expect(out.residency.settled).toBe(false);
  expect(out.residency.extraBytes).toBeGreaterThan(first.residency.extraBytes);
  const drained = await call(page, "release-initialization");
  expect(drained.current.revisionId).toBe(first.revisionId);
  expect(drained.camera).toEqual(first.camera);
  expect(committed(drained.records)).toHaveLength(1);
  expect(drained.stats.sourceCount).toBe(first.stats.sourceCount);
  expect(drained.residency.settled).toBe(true);
  expect(drained.probe.live).toEqual(first.probe.live);
});

test("cancel during real native staging remains idle while unfinished ownership fences reopen", async ({
  page,
}) => {
  const first = await call(page, "seed");
  await call(page, "preview");
  await call(page, "stage-hold");
  const cancelled = await call(page, "cancel");
  expect(cancelled.immediate.phase).toBe("idle");
  expect(cancelled.cancelMs).toBeLessThan(1000);
  expect(cancelled.residency.settled).toBe(false);
  const blocked = await call(page, "attempt-reopen", {
    sceneId: first.sceneId,
  });
  expect(blocked.ok).toBe(false);
  const out = await call(page, "release-stage");
  expect(out.current.revisionId).toBe(first.revisionId);
  expect(out.current.digest).toBe(first.digest);
  expect(out.camera).toEqual(first.camera);
  expect(out.residency.settled).toBe(true);
  expect(committed(out.records)).toHaveLength(1);
  expect(out.records.operations).toHaveLength(1);
  expect(
    out.records.revisions.filter((r: any) => r.status === "staging"),
  ).toHaveLength(0);
});

test("duplicate planning clicks attach to one constructed planner request", async ({
  page,
}, info) => {
  const out = await call(page, "double-plan");
  expect(out.samePromise).toBe(true);
  expect(out.during.counts.planner).toBe(1);
  expect(out.counts.planner).toBe(1);
  expect(out.results[0]).toEqual(out.results[1]);
  expect(out.counts.build).toBe(0);
  expect(out.records.operations).toHaveLength(0);
  expect(out.records.revisions).toHaveLength(0);
  expect(out.phases).not.toContain("parsing");
  expect(out.phases).not.toContain("querying");
  expect(out.phases).not.toContain("planning");
  await attach(info, "duplicate-constructed-plan", out);
});

test("native failed checkout preserves the child pointer, user camera and actual drawn child", async ({
  page,
}, info) => {
  const parent = await call(page, "seed");
  const child = await call(page, "preview");
  expect((await call(page, "use")).ok).toBe(true);
  const userCamera = { position: [8, 6, 7], target: [0.4, 0.1, -0.3] };
  const moved = await call(page, "camera", { camera: userCamera });
  const beforePng = await page.locator("#general").screenshot();
  const out = await call(page, "undo-abort");
  const afterPng = await page.locator("#general").screenshot();
  expect(out.injected).toBe(true);
  expect(out.attemptedPointer).toBe(parent.revisionId);
  expect(out.result.ok).toBe(false);
  expect(out.current.revisionId).toBe(child.revisionId);
  expect(out.current.digest).toBe(child.digest);
  expect(out.state.current.revisionId).toBe(child.revisionId);
  expect(out.records.scenes[0].currentRevisionId).toBe(child.revisionId);
  expect(out.camera).toEqual(userCamera);
  expect(out.drawnIds.slice().sort()).toEqual(moved.drawnIds.slice().sort());
  expect(out.drawSerial).toBeGreaterThan(moved.drawSerial);
  expect(out.drawnNodes).toBeGreaterThan(0);
  expect(out.drawnNodes).toBe(out.stats.instanceCount);
  expect(out.stats.sourceCount).toBe(moved.stats.sourceCount);
  expect(out.probe.live).toEqual(moved.probe.live);
  expect(committed(out.records)).toHaveLength(2);
  expect(out.records.operations).toHaveLength(2);
  expect(afterPng.equals(beforePng)).toBe(true);
  await attach(info, "failed-native-checkout", {
    parent,
    child,
    moved,
    out,
    pixelBytesEqual: afterPng.equals(beforePng),
  });
  await info.attach("child-before-undo", {
    body: beforePng,
    contentType: "image/png",
  });
  await info.attach("child-after-failed-undo", {
    body: afterPng,
    contentType: "image/png",
  });
  await refresh(page);
  const reopened = await call(page, "reopen", { sceneId: child.sceneId });
  expect(reopened.revisionId).toBe(child.revisionId);
  expect(reopened.digest).toBe(child.digest);
  expect(reopened.counts.build).toBe(0);
});

test("import requires a native saved baseline before editing and edits original cached versions offline", async ({
  page,
  context,
}, info) => {
  const network: { event: string; url: string; error?: string | null }[] = [];
  context.on("requestfailed", (request) =>
    network.push({
      event: "requestfailed",
      url: diagnosticUrl(request.url()),
      error: request.failure()?.errorText,
    }),
  );
  page.on("worker", (worker) =>
    network.push({ event: "worker", url: diagnosticUrl(worker.url()) }),
  );
  const original = await call(page, "seed");
  const exported = await call(page, "export", { mode: "embedded" });
  const imported = await call(page, "import", { bytes: exported.bytes });
  expect(imported.state.phase).toBe("previewing");
  expect(imported.current.revisionId).toBe(original.revisionId);
  expect(imported.candidate.sceneId).not.toBe(original.sceneId);
  expect(imported.candidate.revisionId).not.toBe(original.revisionId);
  expect(imported.candidate.geometryDigest).toBe(original.geometryDigest);
  expect(imported.candidate.stateDigest).toBe(original.stateDigest);
  expect(imported.candidate.assets).toEqual(original.assets);
  expect(imported.counts.build).toBe(original.counts.build);
  expect(committed(imported.records)).toHaveLength(1);
  const rejected = await call(page, "attempt-import-edit");
  expect(rejected.result.ok).toBe(false);
  expect(rejected.state.phase).toBe("previewing");
  expect(rejected.state.candidate.revisionId).toBe(
    imported.candidate.revisionId,
  );
  expect(rejected.drawnIds.slice().sort()).toEqual(
    imported.drawnIds.slice().sort(),
  );
  expect(rejected.stats.sourceCount).toBe(imported.stats.sourceCount);
  expect(rejected.records.operations).toHaveLength(1);
  const saved = await call(page, "use");
  expect(saved.ok).toBe(true);
  expect(saved.value.revisionId).toBe(imported.candidate.revisionId);
  const beforeOffline = await call(page, "offline-library");
  expect(committed(beforeOffline.records)).toHaveLength(2);
  expect(beforeOffline.records.scenes).toHaveLength(2);
  await attach(info, "import-before-offline", {
    original,
    imported,
    rejected,
    saved,
    beforeOffline,
  });
  // The app shell and the real worker were already loaded online. No cold-start claim.
  await context.setOffline(true);
  let reopened,
    cancelledCandidate,
    cancelled,
    restoredAfterCancel,
    edited,
    committedEdit,
    offlineExport;
  try {
    reopened = await call(page, "reopen", {
      sceneId: imported.candidate.sceneId,
    });
    expect(reopened.geometryDigest).toBe(original.geometryDigest);
    expect(reopened.assets).toEqual(original.assets);
    expect(reopened.catalogDigest).toBe(original.catalogDigest);
    cancelledCandidate = await call(page, "patch");
    expect(cancelledCandidate.candidate.geometryDigest).not.toBe(
      original.geometryDigest,
    );
    cancelled = await call(page, "cancel");
    expect(cancelled.immediate.phase).toBe("idle");
    expect(cancelled.cancelMs).toBeLessThan(1000);
    restoredAfterCancel = await call(page, "settle", {
      drawnIds: reopened.drawnIds,
    });
    expect(restoredAfterCancel.current.revisionId).toBe(
      imported.candidate.revisionId,
    );
    expect(restoredAfterCancel.current.digest).toBe(imported.candidate.digest);
    expect(restoredAfterCancel.current.geometryDigest).toBe(
      original.geometryDigest,
    );
    expect(restoredAfterCancel.current.stateDigest).toBe(original.stateDigest);
    expect(restoredAfterCancel.camera).toEqual(reopened.camera);
    expect(restoredAfterCancel.drawnIds.slice().sort()).toEqual(
      reopened.drawnIds.slice().sort(),
    );
    expect(restoredAfterCancel.stats.sourceCount).toBe(
      reopened.stats.sourceCount,
    );
    expect(restoredAfterCancel.residency.settled).toBe(true);
    expect(
      restoredAfterCancel.records.scenes.find(
        (s: any) => s.sceneId === imported.candidate.sceneId,
      ).currentRevisionId,
    ).toBe(imported.candidate.revisionId);
    expect(committed(restoredAfterCancel.records)).toHaveLength(2);
    expect(restoredAfterCancel.records.operations).toHaveLength(2);
    // The cancelled worker generations are gone; the same controller must create
    // fresh actual workers and finish the next edit while still truly offline.
    edited = await call(page, "patch");
    expect(edited.current.revisionId).toBe(imported.candidate.revisionId);
    expect(edited.candidate.assets).toEqual(original.assets);
    expect(edited.candidate.catalogDigest).toBe(original.catalogDigest);
    expect(edited.candidate.geometryDigest).not.toBe(original.geometryDigest);
    committedEdit = await call(page, "use");
    expect(committedEdit.ok).toBe(true);
    offlineExport = await call(page, "export", { mode: "embedded" });
    expect(offlineExport.bytes.length).toBeGreaterThan(0);
    expect(offlineExport.current.revisionId).toBe(edited.candidate.revisionId);
    expect(offlineExport.counts.liveLibrary).toBe(
      beforeOffline.counts.liveLibrary,
    );
    expect(offlineExport.counts.planner).toBe(beforeOffline.counts.planner);
    expect(offlineExport.counts.build).toBe(beforeOffline.counts.build + 2);
    expect(committed(offlineExport.records)).toHaveLength(3);
    expect(offlineExport.records.operations).toHaveLength(3);
    expect(offlineExport.drawnNodes).toBeGreaterThan(0);
    expect(offlineExport.drawnNodes).toBe(offlineExport.stats.instanceCount);
  } finally {
    await context.setOffline(false);
    await attach(info, "offline-attempt-observations", {
      network,
      reopened,
      cancelledCandidate,
      cancelled,
      restoredAfterCancel,
      edited,
      committedEdit,
      observed: await call(page, "inspect"),
    });
  }
  await info.attach("offline-original-version-edited.zip", {
    body: Buffer.from(offlineExport.bytes),
    contentType: "application/zip",
  });
  const { bytes: _originalBytes, ...exportSummary } = exported;
  const { bytes: _offlineBytes, ...offlineExportSummary } = offlineExport;
  await attach(info, "native-import-and-offline-edit", {
    original,
    exportSummary,
    imported,
    rejected,
    saved,
    beforeOffline,
    reopened,
    cancelledCandidate,
    cancelled,
    restoredAfterCancel,
    edited,
    committedEdit,
    offlineExportSummary,
  });
  await refresh(page);
  const final = await call(page, "reopen", {
    sceneId: imported.candidate.sceneId,
  });
  expect(final.revisionId).toBe(edited.candidate.revisionId);
  expect(final.digest).toBe(edited.candidate.digest);
  expect(final.counts.build).toBe(0);
  expect(final.counts.resolve).toBe(0);
});

test("actual worker completion and immediate cancellation release original Blob URLs and preserve the parent", async ({
  page,
}, info) => {
  const first = await call(page, "seed");
  const moved = await call(page, "camera", {
    camera: { position: [8, 6, 7], target: [0.4, 0.1, -0.3] },
  });
  const parentPng = await page.locator("#general").screenshot();
  for (const earlyCancel of [false, true]) {
    const out = await call(page, "worker-lifetime", { earlyCancel });
    const png = await page.locator("#general").screenshot();
    // Attach before asserting so an actual leaking URL remains reviewable on RED.
    await attach(
      info,
      earlyCancel ? "worker-early-cancel" : "worker-completed-control",
      { ...out, parentPngEqual: png.equals(parentPng) },
    );
    await info.attach(
      earlyCancel
        ? "parent-after-early-worker-cancel"
        : "parent-after-worker-control",
      { body: png, contentType: "image/png" },
    );
    expect(out.completed).toBe(!earlyCancel);
    expect(out.events.filter((e: any) => e.kind === "created")).toHaveLength(
      earlyCancel ? 1 : 2,
    );
    expect(out.events.filter((e: any) => e.kind === "posted")).toHaveLength(
      earlyCancel ? 1 : 2,
    );
    expect(out.events.filter((e: any) => e.kind === "terminated")).toHaveLength(
      earlyCancel ? 1 : 2,
    );
    if (earlyCancel) {
      expect(out.failure).toMatch(/cancel/i);
      expect(out.cancelMs).toBeLessThan(1000);
      expect(out.cancelState.phase).toBe("idle");
    }
    expect(out.residency.settled).toBe(true);
    expect(out.state.current.revisionId).toBe(first.revisionId);
    expect(out.current.digest).toBe(first.digest);
    expect(out.current.geometryDigest).toBe(first.geometryDigest);
    expect(out.current.stateDigest).toBe(first.stateDigest);
    expect(out.camera).toEqual(moved.camera);
    expect(out.drawnIds.slice().sort()).toEqual(moved.drawnIds.slice().sort());
    expect(out.stats.sourceCount).toBe(moved.stats.sourceCount);
    expect(out.probe.live).toEqual(moved.probe.live);
    expect(out.records.scenes[0].currentRevisionId).toBe(first.revisionId);
    expect(committed(out.records)).toHaveLength(1);
    expect(out.records.operations).toHaveLength(1);
    expect(png.equals(parentPng)).toBe(true);
    const workerBlobUrls = out.workerUrls.filter((url: string) =>
      url.startsWith("blob:"),
    );
    expect(
      out.probes
        .map((p: any) => p.url)
        .slice()
        .sort(),
    ).toEqual(workerBlobUrls.slice().sort());
    expect(out.probes.filter((p: any) => p.readable)).toEqual([]);
  }
});
