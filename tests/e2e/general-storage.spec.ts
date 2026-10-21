import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
const call = (page: Page, action: string, options: unknown = {}) =>
  page.evaluate(
    ({ action, options }) => (window as any).general.storage(action, options),
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
test.beforeEach(async ({ page }) => {
  await ready(page);
});
test("native IDB publication, dedupe and checkout survive refresh boundaries", async ({
  page,
}) => {
  expect(
    await page.evaluate(() => typeof (window as any).general.storage),
  ).toBe("function");
  const first = await call(page, "seed"),
    before = await call(page, "inspect");
  await call(page, "stage");
  expect((await call(page, "missing-stage")).error).toMatch(/staging/);
  await refresh(page);
  expect(await call(page, "open")).toEqual(first);
  expect((await call(page, "commit")).duplicate).toBe(false);
  await refresh(page);
  expect((await call(page, "open")).revisionId).toBe("storage-new");
  expect((await call(page, "duplicate")).duplicate).toBe(true);
  const saved = await call(page, "inspect");
  expect(saved.revisions).toHaveLength(2);
  expect(saved.operations).toHaveLength(2);
  expect(saved.blobs).toEqual(before.blobs);
  expect(saved.manifests).toEqual(before.manifests);
  expect((await call(page, "stale")).error).toMatch(/stale/);
  expect((await call(page, "conflict")).error).toMatch(/content|conflict/);
  expect((await call(page, "checkout")).duplicate).toBe(false);
  await refresh(page);
  expect((await call(page, "checkout")).duplicate).toBe(true);
  expect(await call(page, "open")).toEqual(first);
});
test("offline native restore preserves all result/state hashes, catalog and actual draw without generation", async ({
  page,
  context,
}) => {
  const first = await call(page, "seed");
  await refresh(page);
  await call(page, "inspect");
  await context.setOffline(true);
  const out = await call(page, "reopen");
  for (const key of [
    "digest",
    "state",
    "terrain",
    "instances",
    "owners",
    "geometryDigest",
  ])
    expect(out[key]).toBe(first[key]);
  expect(out.generationCalls).toBe(0);
  expect(out.drawn).toBeGreaterThan(0);
  expect(out.unrelatedUnavailable).toBe(true);
  expect(out.catalogDigest).toMatch(/^[a-f0-9]{64}$/);
  console.info(
    "T10_OFFLINE_EVIDENCE",
    JSON.stringify({ before: first, after: out }),
  );
  await context.setOffline(false);
});
for (const [kind, store] of [
  ["abort-revision", "revisions"],
  ["abort-pointer", "scenes"],
  ["quota", "revisions"],
])
  test(`native ${kind} preserves previous committed pointer and receipt`, async ({
    page,
  }) => {
    const first = await call(page, "seed"),
      out = await call(page, "fault", { kind, store });
    expect(out.injected).toBe(true);
    expect(out.error).toMatch(/Abort|Quota/);
    expect(out.receipt).toBeNull();
    expect(out.current).toEqual(first);
    expect(out.records.operations).toHaveLength(1);
    expect(
      out.records.revisions.filter((r: any) => r.status === "committed"),
    ).toHaveLength(1);
    await refresh(page);
    expect(await call(page, "open")).toEqual(first);
  });
test("abort after native transaction complete reports the actual saved receipt", async ({
  page,
}) => {
  await call(page, "seed");
  const out = await call(page, "fault", {
    kind: "after-complete",
    store: "scenes",
  });
  expect(out.injected).toBe(true);
  expect(out.error).toBe("");
  expect(out.receipt.duplicate).toBe(false);
  expect(out.current.revisionId).toBe("storage-fault-after-complete");
  await refresh(page);
  expect((await call(page, "open")).revisionId).toBe(out.current.revisionId);
});
for (const remove of [false, true])
  test(`duplicate operation rejects ${remove ? "missing" : "altered"} committed revision`, async ({
    page,
  }) => {
    await call(page, "seed");
    await call(page, "stage");
    await call(page, "commit");
    await refresh(page);
    await call(page, "corrupt-revision", { revisionId: "storage-new", remove });
    await expect(call(page, "duplicate")).rejects.toThrow(/Duplicate|differs/);
  });
test("20 native scenes remain intact when publication of scene 21 is rejected", async ({
  page,
}) => {
  test.setTimeout(60000);
  const first = await call(page, "seed"),
    out = await call(page, "limits");
  expect(out.error).toMatch(/20/);
  expect(out.list).toHaveLength(20);
  expect(out.records.scenes).toHaveLength(20);
  expect(await call(page, "open")).toEqual(first);
});
test("256MiB real native Blob boundary reuses identical data and rejects additional unique bytes", async ({
  page,
}) => {
  test.setTimeout(60000);
  const first = await call(page, "seed"),
    records = await call(page, "inspect");
  const size =
      256 * 1024 ** 2 -
      records.blobs.reduce((n: number, b: any) => n + b.size, 0),
    unit = Buffer.alloc(1024 ** 2),
    hash = createHash("sha256");
  for (let left = size; left > 0; left -= unit.length)
    hash.update(unit.subarray(0, Math.min(left, unit.length)));
  expect(await call(page, "fill", { size, hash: hash.digest("hex") })).toBe(
    size,
  );
  const out = await call(page, "blob-limit");
  expect(out.error).toMatch(/256MiB/);
  expect(out.current).toEqual(first);
  expect(out.records.blobs.reduce((n: number, b: any) => n + b.size, 0)).toBe(
    256 * 1024 ** 2,
  );
});

test("all restore entry points reject known memory peaks before Blob materialization", async ({
  page,
}) => {
  await call(page, "seed");
  const out = await call(page, "budget");
  expect(out.errors).toHaveLength(3);
  expect(out.errors.every((e: string) => /budget/.test(e))).toBe(true);
  expect(out.reads).toBe(0);
});
test("native stored payload SHA is checked before restored results are accepted", async ({
  page,
}) => {
  await call(page, "seed");
  expect(await call(page, "corrupt-blob")).toMatch(/blob digest mismatch/);
});
