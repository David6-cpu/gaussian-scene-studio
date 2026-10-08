import { expect, test } from "vitest";
import { BUILTIN_CONTEXT as context } from "../assets/catalog/context";
import { defaultReviewRequestV2 } from "./requirements";
import {
  createReviewDraftV2,
  editReviewDraftV2,
  resolveReviewRequestV2,
  setReviewSelectionV2,
  compileReviewV2,
} from "./draft";
import {
  createReviewRecordV2,
  importReviewRecordV2,
  appendReviewRecordV2,
  loadReviewHistoryV2,
  REVIEW_HISTORY_KEY_V2,
} from "./history";
import { importReviewRecord } from "../review/versions";
import { createReviewRecord as createV1 } from "../review/history";
import { compileReview } from "../review/draft";
import { reviewFixture } from "../review/fixtures.test-support";
async function make() {
  let draft = createReviewDraftV2(
    "河岸",
    {
      ...defaultReviewRequestV2,
      rockCount: 0,
      plantCount: 0,
      plantKind: "none",
      water: { mode: "river", explicitLevel: null },
    },
    null,
  );
  draft = editReviewDraftV2(draft, { water: "off" });
  const request = resolveReviewRequestV2(draft);
  draft = setReviewSelectionV2(
    draft,
    {
      kind: "manual",
      request,
      choices: [{ key: "ground", assetId: "riverside-ground-v1" }],
      catalogVersion: context.catalogVersion,
    },
    context,
  );
  return createReviewRecordV2(compileReviewV2(draft, context));
}
class Storage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
const lock = async <T>(job: () => Promise<T>) => job();
test("v2 stores original river, manual off and resolution, leaving v1 bytes unchanged", async () => {
  const old = await createV1(
    compileReview(reviewFixture({ waterLevel: null, rockCount: 0 }), context),
  );
  const bytes = JSON.stringify(old);
  const imported = await importReviewRecord(bytes, context);
  expect(imported.schemaVersion).toBe(1);
  expect(imported.recipe.waterLevel).toBeNull();
  const storage = new Storage();
  storage.setItem("wetland.sceneReviews.v1", JSON.stringify([old]));
  const before = storage.getItem("wetland.sceneReviews.v1");
  const record = await make();
  expect(
    (await appendReviewRecordV2(storage, record, context, lock)).error,
  ).toBeNull();
  const loaded = await loadReviewHistoryV2(storage, context);
  expect(loaded.records[0].draft.originalRequest.water.mode).toBe("river");
  expect(loaded.records[0].draft.edits.water).toBe("off");
  expect(loaded.records[0].waterResolution.source).toBe("user-choice");
  expect(storage.getItem("wetland.sceneReviews.v1")).toBe(before);
  expect(
    (await importReviewRecordV2(JSON.stringify(record), context)).recipeHash,
  ).toBe(record.recipeHash);
});
test.each(["resolution", "raw", "edit", "hash"])(
  "rejects forged v2 %s",
  async (kind) => {
    const record = structuredClone(await make());
    if (kind === "resolution") record.waterResolution.waterLevel = 0;
    if (kind === "edit") record.draft.edits.water = "keep";
    if (kind === "hash") record.recipeHash = "0".repeat(64);
    if (kind === "raw")
      (record.draft as any).requirements = {
        schemaVersion: 2,
        prompt: "河岸",
        request: record.draft.originalRequest,
        raw: "{}",
        model: "qwen2.5-3b-instruct-q4_k_m",
        elapsedMs: 1,
      };
    await expect(
      importReviewRecordV2(JSON.stringify(record), context),
    ).rejects.toThrow();
  },
);
test.each(["corrupt", "quota", "capacity", "oversize", "concurrent"])(
  "v2 %s preserves previous bytes",
  async (kind) => {
    const storage = new Storage(),
      record = await make();
    if (kind === "corrupt") storage.setItem(REVIEW_HISTORY_KEY_V2, "{");
    if (kind === "oversize")
      storage.setItem(REVIEW_HISTORY_KEY_V2, " ".repeat(1048577));
    if (kind === "capacity")
      storage.setItem(
        REVIEW_HISTORY_KEY_V2,
        JSON.stringify(
          Array.from({ length: 20 }, () => ({
            ...record,
            id: crypto.randomUUID(),
          })),
        ),
      );
    if (kind === "quota")
      storage.setItem = () => {
        throw Error("QuotaExceeded");
      };
    const before = storage.getItem(REVIEW_HISTORY_KEY_V2);
    if (kind === "concurrent") {
      const original = storage.getItem.bind(storage);
      let calls = 0;
      storage.getItem = (key) => {
        const value = original(key);
        if (!calls++)
          queueMicrotask(() => storage.values.set(key, "external bytes"));
        return value;
      };
    }
    const saved = await appendReviewRecordV2(storage, record, context, lock);
    expect(saved.error).not.toBeNull();
    expect(storage.getItem(REVIEW_HISTORY_KEY_V2)).toBe(
      kind === "concurrent" ? "external bytes" : before,
    );
  },
);
test("same-origin locked v2 writers merge and repeated use stays idempotent", async () => {
  const storage = new Storage(),
    a = await make(),
    b = await make();
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>) => {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  };
  const results = await Promise.all([
    appendReviewRecordV2(storage, a, context, serial),
    appendReviewRecordV2(storage, b, context, serial),
  ]);
  expect(results.every((r) => !r.error)).toBe(true);
  expect(
    (await appendReviewRecordV2(storage, a, context, serial)).records,
  ).toHaveLength(2);
  expect(
    (await loadReviewHistoryV2(storage, context)).records
      .map((r) => r.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
});
