import { test, expect } from "@playwright/test";
for (const name of ["flat", "slope", "river"] as const)
  test(`actual module Worker compiles and displays constructed ${name}`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/tests/general-harness.html");
    await page.waitForFunction(() => (window as any).general?.ready);
    const a = await page.evaluate(
      (name) => (window as any).general.buildCase(name),
      name,
    );
    await info.attach(`${name}-worker-result`, {
      body: JSON.stringify(a, null, 2),
      contentType: "application/json",
    });
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(a.count).toBe(3);
    expect(a.stats.activeSplats).toBe(a.usage.worstSplats);
    expect(a.surfaceSupport).toEqual(a.reopenedSupport);
    expect(a.usage.candidateCpuBytes).toBeLessThanOrEqual(128 * 1024 ** 2);
    expect(a.usage.transitionBytes).toBeLessThanOrEqual(256 * 1024 ** 2);
    expect(a.visual).toBe("pending");
    expect(a.ledger.preparePeak).toBeLessThanOrEqual(256 * 1024 ** 2);
    expect(errors).toEqual([]);
    const b = await page.evaluate(
      (name) => (window as any).general.buildCase(name),
      name,
    );
    await info.attach(`${name}-repeat-worker-result`, {
      body: JSON.stringify(b, null, 2),
      contentType: "application/json",
    });
    await info.attach(`${name}-constructed-display`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await info.attach(`${name}-environment`, {
      body: JSON.stringify(
        await page.evaluate(() => (window as any).general.diagnostics()),
      ),
      contentType: "application/json",
    });
    expect(b.ok, JSON.stringify(b)).toBe(true);
    expect(b.ledger.beforeResolve).toBeGreaterThan(a.ledger.beforeResolve);
    expect(b.ledger.preparePeak).toBeLessThanOrEqual(256 * 1024 ** 2);
    expect(b.geometryDigest).toBe(a.geometryDigest);
    expect(b.sourceDigest).toBe(a.sourceDigest);
    await page.evaluate(() => (window as any).general.release());
  });

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
test("immutable thirty property cases use actual Worker bindings and repeatable results", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const file = readFileSync("tests/fixtures/general-scene-properties.json"),
    frozen = JSON.parse(file.toString()),
    evidence: any[] = [];
  expect(createHash("sha256").update(file).digest("hex")).toBe(
    "b84ea33fa39701c5504abf7f915ea7c2f89375611f0e92eb7c629987c3a4c838",
  );
  await page.goto("/tests/general-harness.html");
  await page.waitForFunction(() => (window as any).general?.ready);
  for (const c of [...frozen.cases, ...frozen.negativeCases]) {
    const a = await page.evaluate(
        (d) => (window as any).general.buildProperty(d),
        c.structuredDraft,
      ),
      b = await page.evaluate(
        (d) => (window as any).general.buildProperty(d),
        c.structuredDraft,
      );
    evidence.push({
      id: c.id,
      originalInputJsonSha256: createHash("sha256")
        .update(JSON.stringify(c.structuredDraft))
        .digest("hex"),
      expected: c.expectedInvariants ?? {
        gate: c.expectedGate,
        outcome: c.expectedOutcome,
      },
      first: a,
      repeat: b,
    });
    expect(b.ok, JSON.stringify({ id: c.id, a, b })).toBe(a.ok);
    if (a.ok) {
      expect(b.geometryDigest).toBe(a.geometryDigest);
      expect(a.count + a.shortfall).toBe(a.requested);
      expect(a.usage.worstSplats).toBeLessThanOrEqual(250000);
      expect(a.usage.candidateCpuBytes).toBeLessThanOrEqual(128 * 1024 ** 2);
      expect(a.usage.transitionBytes).toBeLessThanOrEqual(256 * 1024 ** 2);
    } else {
      expect(b.stage).toBe(a.stage);
      expect(b.issues ?? b.message).toEqual(a.issues ?? a.message);
      expect(
        (a.issues ?? []).some((i: any) =>
          [
            "semantic",
            "confirmation",
            "asset-admission",
            "asset-integrity",
            "build-version",
          ].includes(i.code),
        ),
        JSON.stringify(a),
      ).toBe(false);
    }
    if (c.expectedOutcome === "reject") {
      expect(a.ok).toBe(false);
      if (c.expectedGate === "contract") expect(a.stage).toBe("contract");
      else if (c.expectedGate === "water-preflight") {
        expect(a.stage).toBe("preflight");
        expect(a.issues.some((i: any) => i.code.startsWith("water-"))).toBe(
          true,
        );
      } else if (c.expectedGate === "placement") {
        expect(a.stage).toBe("compile");
        expect(a.issues.some((i: any) => i.code === "quantity")).toBe(true);
        expect(a.issues.some((i: any) => i.code === "slope")).toBe(true);
      } else throw Error("Unmapped frozen expectedGate: " + c.expectedGate);
    }
  }
  await info.attach("frozen-property-matrix", {
    body: JSON.stringify(
      {
        originalFileSha256: createHash("sha256").update(file).digest("hex"),
        provenance: "constructed-only; no real scene acceptance",
        evidence,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(evidence.slice(0, 30).some((x) => x.first.ok)).toBe(true);
});
test("real Worker cancellation terminates and the same client can compile again", async ({
  page,
}, info) => {
  await page.goto("/tests/general-harness.html");
  await page.waitForFunction(() => (window as any).general?.ready);
  const result = await page.evaluate(() =>
    (window as any).general.workerFault("cancel"),
  );
  expect(result.result.ok).toBe(false);
  expect(result.result.issues[0].code).toBe("cancelled");
  expect(result.observed).toEqual({ created: 1, posted: 1, terminated: 1 });
  expect(result.callerSourceBytes).toBeGreaterThan(0);
  const retry = await page.evaluate(() =>
    (window as any).general.workerFaultRetry(),
  );
  expect(retry.ok, JSON.stringify(retry)).toBe(true);
  await info.attach("actual-worker-cancel", {
    body: JSON.stringify({ result, retry }),
    contentType: "application/json",
  });
});
test("real Worker held at module fetch reaches hard timeout and the same client recovers", async ({
  page,
  context,
}, info) => {
  let release!: () => void,
    intercepted = 0;
  const gate = new Promise<void>((r) => (release = r));
  await context.route(/build\.worker-[^/]+\.js(?:\?.*)?$/, async (route) => {
    intercepted++;
    await gate;
    try {
      await route.continue();
    } catch {
      /* terminated Worker may already have cancelled the request */
    }
  });
  try {
    await page.goto("/tests/general-harness.html");
    await page.waitForFunction(() => (window as any).general?.ready);
    const result = await page.evaluate(() =>
      (window as any).general.workerFault("timeout"),
    );
    expect(intercepted).toBeGreaterThan(0);
    expect(result.result.ok).toBe(false);
    expect(result.result.issues[0].code).toBe("timeout");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(9900);
    expect(result.observed).toEqual({ created: 1, posted: 1, terminated: 1 });
    release();
    await context.unrouteAll({ behavior: "wait" });
    const retry = await page.evaluate(() =>
      (window as any).general.workerFaultRetry(),
    );
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    await info.attach("actual-worker-timeout", {
      body: JSON.stringify({ result, retry, intercepted }),
      contentType: "application/json",
    });
  } finally {
    release();
    await context.unrouteAll({ behavior: "wait" });
  }
});
