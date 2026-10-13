import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareTrial,
  submitTrial,
  pollTrial,
  downloadTrial,
} from "../../scripts/worldlabs/trial.mjs";
import { REQUEST_SHA } from "../../scripts/worldlabs/request.mjs";
import { simulatedOperation } from "../../scripts/worldlabs/test-support.mjs";
import { environmentSpz } from "../../tests/support/environment-fixture";
import { importEnvironment } from "./asset";

test("simulated provider download transfers to the real importer as a three-point fixture, still visual-pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wetland-transfer-test-"));
  try {
    await prepareTrial(dir);
    const response = (value: unknown) => new Response(JSON.stringify(value));
    await submitTrial(dir, {
      approvePaidOnce: true,
      requestSha: REQUEST_SHA,
      priceDate: "2026-10-09",
      now: new Date("2026-10-09T12:00:00Z"),
      key: "offline-test-key",
      fetchImpl: async () => response({ operation_id: "op-1", done: false }),
    });
    await pollTrial(dir, {
      key: "offline-test-key",
      fetchImpl: async () => response(simulatedOperation()),
    });
    await downloadTrial(dir, {
      fetchImpl: async () =>
        new Response(environmentSpz(3, 3) as Uint8Array<ArrayBuffer>),
    });
    const asset = await importEnvironment(
      await readFile(join(dir, "world.json")),
      await readFile(join(dir, "environment-100k.spz")),
      await readFile(join(dir, "request-record.json")),
    );
    expect(asset.splats).toMatchObject({ count: 3, version: 3, shDegree: 3 });
    expect(asset.source).toMatchObject({
      operationId: "op-1",
      generationStatus: "completed",
      recaption: true,
      seed: null,
    });
    expect(asset.transform).toMatchObject({
      scale: 2,
      offset: 0.5,
      flipY: true,
    });
    expect(asset.quality).toBe("visual-pending");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
