import { describe, expect, it } from "vitest";
import { defaultRecipe } from "../recipe";
import { demoPlan, MODEL, LLAMA_MODEL, planScene } from "./service";
import { toRecipe, proposalFromRecipe } from "./contract";
import {
  confirmPlan,
  exportPlan,
  importPlan,
  recipeDigest,
  saveHistory,
  loadHistory,
  parseDraft,
  HISTORY_KEY,
  type PlanRecord,
} from "./history";
class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
describe("planning records", () => {
  it("reopens old riverbank null-water evidence without applying new live semantics", async () => {
    const raw = JSON.stringify({ ...proposalFromRecipe(defaultRecipe), waterLevel: null });
    const draft = await planScene("湿地", async () => ({ raw, model: MODEL, done: true, doneReason: "stop" }), new AbortController().signal);
    const archived = { ...draft, prompt: "河岸上放一些低矮草丛和石头" };
    const record = await confirmPlan(archived);
    const imported = await importPlan(exportPlan(record));
    expect(imported.draft.prompt).toBe(archived.prompt);
    expect(imported.recipe.waterLevel).toBeNull();
    expect(imported.draft.attempts[0].raw).toBe(raw);
    expect(imported.recipeHash).toBe(record.recipeHash);
  });
  it("roundtrips v3 backend evidence and rejects inconsistent source/backend claims", async () => {
    const draft = await planScene(
      "湿地",
      async () => ({
        raw: JSON.stringify(proposalFromRecipe(defaultRecipe)),
        model: LLAMA_MODEL,
        done: true,
        doneReason: "stop",
      }),
      new AbortController().signal,
      "llama.cpp",
    );
    const r = await confirmPlan(draft);
    expect(r.schemaVersion).toBe(3);
    expect((await importPlan(exportPlan(r))).draft).toMatchObject({
      source: "llama.cpp",
      backend: "llama.cpp",
    });
    for (const changed of [
      { ...r, draft: { ...r.draft, backend: "ollama" } },
      { ...r, draft: { ...r.draft, backend: null } },
      { ...r, schemaVersion: 1 },
      { ...r, draft: { ...r.draft, backend: "https://example.com" } },
    ])
      await expect(importPlan(JSON.stringify(changed))).rejects.toThrow();
    const { backend, ...missing } = r.draft;
    await expect(
      importPlan(JSON.stringify({ ...r, draft: missing })),
    ).rejects.toThrow();
    expect(() => parseDraft({ ...demoPlan(), backend: "llama.cpp" })).toThrow();
  });
  it("migrates exact v1 records without inventing fresh inference or changing recipe digests", async () => {
    for (const draft of [
      demoPlan(),
      await planScene(
        "湿地",
        async () => {
          throw Error("offline");
        },
        new AbortController().signal,
      ),
      await planScene(
        "湿地",
        async () => ({
          raw: JSON.stringify(proposalFromRecipe(defaultRecipe)),
          model: MODEL,
          done: true,
          doneReason: "stop",
        }),
        new AbortController().signal,
      ),
    ]) {
      const r = await confirmPlan(draft);
      const { backend, model, ...legacyDraft } = r.draft;
      const legacy = { ...r, schemaVersion: 1, draft: legacyDraft };
      const migrated = await importPlan(JSON.stringify(legacy));
      expect(migrated).toMatchObject({
        schemaVersion: 3,
        id: r.id,
        recipeHash: r.recipeHash,
        origin: "imported",
      });
      expect(migrated.draft.backend).toBe(
        draft.source === "demo" ? null : "ollama",
      );
      const storage = new MemoryStorage();
      storage.setItem(HISTORY_KEY, JSON.stringify([legacy]));
      expect((await loadHistory(storage)).records).toHaveLength(1);
      await expect(
        importPlan(
          JSON.stringify({
            ...legacy,
            draft: { ...legacyDraft, source: "llama.cpp" },
          }),
        ),
      ).rejects.toThrow();
    }
  });
  it("binds the exact final execution recipe, preserving visual edits and lineage", async () => {
    const draft = demoPlan();
    const first = await confirmPlan(draft, toRecipe(draft.proposal));
    const next = await confirmPlan(
      draft,
      { ...first.recipe, opacity: 0.8, seed: 123 },
      first.id,
    );
    expect(first.kind).toBe("direct");
    expect(next.kind).toBe("manual");
    expect(next.parentId).toBe(first.id);
    expect(next.recipe.opacity).toBe(0.8);
    expect(next.recipeHash).not.toBe(first.recipeHash);
    expect(next.proposal.seed).toBe(123);
  });
  it("uses canonical recipe parsing before SHA-256", async () => {
    expect(await recipeDigest(defaultRecipe)).toBe(
      await recipeDigest({
        ...defaultRecipe,
        requested: { reed: 10, rock: 10 },
      }),
    );
  });
  it("reopens as unverified historical provenance, never fresh inference", async () => {
    const draft = await planScene(
      "湿地",
      async () => ({
        raw: JSON.stringify(proposalFromRecipe(defaultRecipe)),
        model: MODEL,
        done: true,
        doneReason: "stop",
      }),
      new AbortController().signal,
    );
    const record = await confirmPlan(draft);
    const imported = await importPlan(exportPlan(record));
    expect(imported.origin).toBe("imported");
    expect(imported.draft.source).toBe("ollama");
    expect(imported.recipeHash).toBe(record.recipeHash);
    expect(imported.id).toBe(record.id);
  });
  it("rejects unknown authority fields, edited recipe/digest, mismatched proposal, invalid draft and huge files", async () => {
    const r = await confirmPlan(demoPlan());
    for (const changed of [
      { ...r, validation: "passed" },
      { ...r, recipe: { ...r.recipe, width: 100 } },
      { ...r, recipeHash: "0".repeat(64) },
      { ...r, proposal: { ...r.proposal, seed: 7 } },
      { ...r, draft: { ...r.draft, source: "ollama" } },
      { ...r, confirmedAt: "yesterday" },
    ])
      await expect(importPlan(JSON.stringify(changed))).rejects.toThrow();
    await expect(importPlan("x".repeat(1048577))).rejects.toThrow();
  });
  it("checks live draft consistency instead of trusting its source field", () => {
    expect(() => parseDraft({ ...demoPlan(), source: "ollama" })).toThrow();
    expect(() =>
      parseDraft({
        ...demoPlan(),
        attempts: [{ raw: "{}", error: null, model: MODEL, elapsedMs: 0 }],
      }),
    ).toThrow();
  });
  it("bounds local history to 20 and 1MiB, keeping newest entries", async () => {
    const storage = new MemoryStorage(),
      records: PlanRecord[] = [];
    for (let i = 0; i < 24; i++) records.push(await confirmPlan(demoPlan()));
    const saved = saveHistory(storage, records);
    expect(saved.records).toHaveLength(20);
    expect(saved.evicted).toEqual({ count: 4, countLimit: 4, byteLimit: 0 });
    expect(saved.notice).toContain("4 条");
    expect(saved.notice).toContain("20条");
    expect(saved.records[0].id).toBe(records[0].id);
    expect(
      new TextEncoder().encode(storage.getItem(HISTORY_KEY)!).length,
    ).toBeLessThanOrEqual(1048576);
    expect((await loadHistory(storage)).records).toHaveLength(20);
  });
  it("reports byte-budget eviction below20 and retains newest records without mutating originals", async () => {
    const draft = await planScene(
      "湿地",
      async () => ({
        raw: "x".repeat(65000),
        model: MODEL,
        done: true,
        doneReason: "stop",
      }),
      new AbortController().signal,
    );
    const records: PlanRecord[] = [];
    for (let i = 0; i < 10; i++) records.push(await confirmPlan(draft));
    const before = JSON.stringify(records),
      storage = new MemoryStorage();
    const saved = saveHistory(storage, records);
    expect(saved.records.length).toBeLessThan(10);
    const removed = 10 - saved.records.length;
    expect(saved.evicted).toEqual({
      count: removed,
      countLimit: 0,
      byteLimit: removed,
    });
    expect(saved.notice).toContain(`${removed} 条`);
    expect(saved.notice).toContain("1MiB");
    expect(saved.records.map((r) => r.id)).toEqual(
      records.slice(0, saved.records.length).map((r) => r.id),
    );
    expect(JSON.stringify(records)).toBe(before);
    expect((await loadHistory(storage)).records.map((r) => r.id)).toEqual(
      saved.records.map((r) => r.id),
    );
    expect((await importPlan(exportPlan(records.at(-1)!))).recipeHash).toBe(
      records.at(-1)!.recipeHash,
    );
    const failed = saveHistory(
      {
        getItem() {
          return null;
        },
        setItem() {
          throw Error("quota");
        },
      },
      records,
    );
    expect(failed.error).toContain("quota");
    expect(failed.notice).toBeNull();
    expect(failed.evicted.count).toBe(0);
  });
  it("has no eviction notice when every record fits", async () => {
    const saved = saveHistory(new MemoryStorage(), [
      await confirmPlan(demoPlan()),
    ]);
    expect(saved.notice).toBeNull();
    expect(saved.evicted.count).toBe(0);
  });
  it("reports storage denial/corruption without losing downloadable current record", async () => {
    const r = await confirmPlan(demoPlan());
    const saved = saveHistory(
      {
        setItem() {
          throw Error("quota");
        },
        getItem() {
          return null;
        },
      },
      [r],
    );
    expect(saved.error).toContain("quota");
    expect(exportPlan(r)).toContain(r.id);
    const corrupt = await loadHistory({
      getItem() {
        return '[{"validation":"passed"}]';
      },
      setItem() {},
    });
    expect(corrupt.records).toEqual([]);
    expect(corrupt.error).toBeTruthy();
  });
});
