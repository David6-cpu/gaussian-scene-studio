import { expect, test } from "vitest";
import { BUILTIN_CONTEXT as context } from "../assets/catalog/context";
import { compileReview } from "./draft";
import { reviewFixture } from "./fixtures.test-support";
import { LLAMA_SMALL_MODEL } from "../planner/service";
import {
  REVIEW_HISTORY_KEY,
  createReviewRecord,
  importReviewRecord,
  loadReviewHistory,
  appendReviewRecord,
  type HistoryLock,
} from "./history";
const make = (seed = 42) =>
  createReviewRecord(
    compileReview(reviewFixture({ seed, rockCount: 0 }), context),
  );
class Storage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
function serializedLock(): HistoryLock {
  let tail: Promise<unknown> = Promise.resolve();
  return (job) => {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  };
}
test("record creation is pure and import derives the same recipe while marking import", async () => {
  const record = await make();
  const imported = await importReviewRecord(JSON.stringify(record), context);
  expect(record.origin).toBe("local");
  expect(imported.origin).toBe("imported");
  expect(imported.recipe).toEqual(record.recipe);
  expect(imported.recipeHash).toBe(record.recipeHash);
  expect(imported.draft.selection?.kind).toBe("manual");
  expect(imported.draft.requirements).toBeNull();
});
test.each([
  "recipe",
  "hash",
  "effective",
  "confirmation",
  "proof",
  "parent",
  "extra",
  "raw",
])("rejects forged %s without trusting stored summaries", async (kind) => {
  const r = structuredClone(await make());
  if (kind === "recipe") r.recipe.seed++;
  if (kind === "hash") r.recipeHash = "0".repeat(64);
  if (kind === "effective") r.effectiveRequest.seed++;
  if (kind === "confirmation") r.draft.confirmedProceduralIds = [];
  if (kind === "proof") (r.draft.selection as any).raw = "fake";
  if (kind === "parent") r.parentId = "old-format:record";
  if (kind === "extra") (r as any).approved = true;
  if (kind === "raw")
    r.draft.requirements = {
      prompt: r.draft.prompt,
      request: r.draft.originalRequest,
      raw: JSON.stringify({ ...r.draft.originalRequest, seed: 99 }),
      model: LLAMA_SMALL_MODEL,
      elapsedMs: 1,
    };
  await expect(
    importReviewRecord(JSON.stringify(r), context),
  ).rejects.toThrow();
});
test.each(["corrupt-json", "corrupt-record", "quota", "oversize", "lock"])(
  "%s preserves every old byte and offers a record to download",
  async (kind) => {
    const storage = new Storage(),
      record = await make();
    const old =
      kind === "corrupt-json"
        ? "{"
        : kind === "corrupt-record"
          ? JSON.stringify([{ ...record, recipeHash: "bad" }])
          : kind === "oversize"
            ? " ".repeat(1048577)
            : "[]";
    storage.values.set(REVIEW_HISTORY_KEY, old);
    for (const key of [
      "wetland.plans.v1",
      "wetland.assetPlans.v1",
      "wetland.assetPlans.v2",
    ])
      storage.values.set(key, "old bytes: " + key);
    const before = [...storage.values];
    if (kind === "quota")
      storage.setItem = () => {
        throw Error("QuotaExceededError");
      };
    const result = await appendReviewRecord(
      storage,
      record,
      context,
      kind === "lock"
        ? async () => {
            throw Error("Web Locks unavailable");
          }
        : serializedLock(),
    );
    expect(result.error).toMatch(/未保存|保存失败/);
    expect([...storage.values]).toEqual(before);
    expect(record.recipeHash).toHaveLength(64);
  },
);
test("an external write during asynchronous validation is not overwritten", async () => {
  const storage = new Storage(),
    original = await make(),
    next = await make(43);
  storage.setItem(REVIEW_HISTORY_KEY, JSON.stringify([original]));
  const read = storage.getItem.bind(storage);
  let changed = false;
  storage.getItem = (key) => {
    const value = read(key);
    if (!changed) {
      changed = true;
      queueMicrotask(() => storage.values.set(key, "external value"));
    }
    return value;
  };
  expect(
    (await appendReviewRecord(storage, next, context, serializedLock())).error,
  ).toMatch(/变化|冲突/);
  expect(read(REVIEW_HISTORY_KEY)).toBe("external value");
});
test("same-origin writers merge in order; duplicate use does not append twice", async () => {
  const storage = new Storage(),
    a = await make(),
    b = await make(43),
    lock = serializedLock();
  const results = await Promise.all([
    appendReviewRecord(storage, a, context, lock),
    appendReviewRecord(storage, b, context, lock),
  ]);
  expect(results.every((r) => r.error === null)).toBe(true);
  expect(
    (await loadReviewHistory(storage, context)).records.map((r) => r.id),
  ).toEqual([b.id, a.id]);
  expect(
    (await appendReviewRecord(storage, a, context, lock)).records,
  ).toHaveLength(2);
  const before = storage.getItem(REVIEW_HISTORY_KEY);
  expect(
    (await appendReviewRecord(storage, { ...b, id: a.id }, context, lock))
      .error,
  ).toMatch(/冲突|重复/);
  expect(storage.getItem(REVIEW_HISTORY_KEY)).toBe(before);
});
test("twenty saved records remain intact when a twenty-first cannot be saved", async () => {
  const storage = new Storage(),
    record = await make();
  const records = Array.from({ length: 20 }, (_, i) => ({
    ...record,
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  }));
  storage.setItem(REVIEW_HISTORY_KEY, JSON.stringify(records));
  const before = storage.getItem(REVIEW_HISTORY_KEY);
  const result = await appendReviewRecord(
    storage,
    record,
    context,
    serializedLock(),
  );
  expect(result.error).toMatch(/20/);
  expect(storage.getItem(REVIEW_HISTORY_KEY)).toBe(before);
});
