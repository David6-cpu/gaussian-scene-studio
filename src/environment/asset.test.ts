import { test, expect } from "vitest";
import { gzipSync, gunzipSync } from "fflate";
import {
  environmentSpz,
  environmentWorld,
  jsonBytes,
} from "../../tests/support/environment-fixture";
import { inspectSpz } from "./spz";
import {
  importEnvironment,
  validateAsset,
  environmentTransform,
} from "./asset";
test.each([2, 3])("validates SPZ v%d actual header and SH", (version) => {
  expect(inspectSpz(environmentSpz(version, 3))).toMatchObject({
    version,
    count: 3,
    shDegree: 3,
  });
});
test("rejects corrupt, truncated, unsupported and inflated headers before decoding", () => {
  const raw = gunzipSync(environmentSpz());
  for (const [offset, value] of [
    [4, 4],
    [8, 250001],
    [8, 0],
  ]) {
    const b = raw.slice();
    new DataView(b.buffer).setUint32(offset, value, true);
    expect(() => inspectSpz(gzipSync(b))).toThrow();
  }
  expect(() => inspectSpz(gzipSync(raw.slice(0, -1)))).toThrow();
  const corrupt = environmentSpz();
  corrupt[corrupt.length - 8] ^= 1;
  expect(() => inspectSpz(corrupt)).toThrow(/CRC|完整/);
  expect(() => inspectSpz(environmentSpz().slice(0, -1))).toThrow();
  expect(() => inspectSpz(new Uint8Array(64 * 1024 ** 2 + 1))).toThrow();
});
test("preserves stable identity, missing generation evidence and explicit false flip", async () => {
  const a = await importEnvironment(
    jsonBytes(environmentWorld()),
    environmentSpz(),
  );
  const b = await importEnvironment(
    jsonBytes(environmentWorld()),
    environmentSpz(),
  );
  expect(a.id).toBe(b.id);
  expect(a.source.generationStatus).toBe("unknown");
  expect(environmentTransform(a)).toEqual({
    scale: 2,
    offset: 0.5,
    flipY: true,
  });
  const c = await importEnvironment(
    jsonBytes(environmentWorld(false)),
    environmentSpz(),
  );
  expect(c.id).not.toBe(a.id);
  expect(environmentTransform(c).flipY).toBe(false);
  expect(await validateAsset(a)).toEqual(a);
});
test("missing metric metadata and explicitly unfinished generations cannot become previews", async () => {
  const world = environmentWorld();
  await expect(
    importEnvironment(jsonBytes({ ...world, assets: {} }), environmentSpz()),
  ).rejects.toThrow();
  await expect(
    importEnvironment(
      jsonBytes({ done: false, response: world }),
      environmentSpz(),
    ),
  ).rejects.toThrow(/完成/);
  await expect(
    importEnvironment(
      jsonBytes(world),
      environmentSpz(),
      jsonBytes({ status: "failed" }),
    ),
  ).rejects.toThrow(/完成/);
});
test("evidence keeps known controls without persisting arbitrary secrets or image bytes", async () => {
  const a = await importEnvironment(
    jsonBytes(environmentWorld()),
    environmentSpz(),
    jsonBytes({
      status: "completed",
      request_id: "operation-1",
      api_key: "super-secret",
      request: {
        seed: 42,
        world_prompt: {
          type: "text",
          text_prompt: "河岸",
          disable_recaption: true,
          data_base64: "SECRET-IMAGE",
        },
      },
    }),
  );
  expect(a.source).toMatchObject({
    generationStatus: "completed",
    seed: 42,
    recaption: true,
    prompt: "河岸",
  });
  expect(JSON.stringify(a)).not.toMatch(
    /super-secret|SECRET-IMAGE|api_key|data_base64/,
  );
  await expect(
    validateAsset({ ...a, transform: { ...a.transform, scale: 4 } }),
  ).rejects.toThrow(/摘要|身份/);
});
