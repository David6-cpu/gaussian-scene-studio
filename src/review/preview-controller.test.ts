import { expect, test } from "vitest";
import { BUILTIN_CONTEXT } from "../assets/catalog/context";
import { buildScene } from "../build";
import type { BuildResult } from "../gaussian/types";
import { reviewFixture } from "./fixtures.test-support";
import { compileReview } from "./draft";
import { createReviewRecord, type SceneReviewRecord } from "./history";
import {
  createPreviewController,
  type PreviewPorts,
  type StagedPreview,
} from "./preview-controller";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const review = (seed = 42) =>
  compileReview(reviewFixture({ seed, rockCount: 0 }), BUILTIN_CONTEXT);
function fixture(overrides: Partial<PreviewPorts> = {}) {
  const events: string[] = [];
  let usable = true,
    committed = 7;
  const ports: PreviewPorts = {
    build: async (recipe) => buildScene(recipe),
    stage: async (result) => ({
      commit: () => events.push(`commit:${result.recipe.seed}`),
      rollback: () => events.push(`rollback:${result.recipe.seed}`),
      isUsable: () => usable,
    }),
    record: createReviewRecord,
    publish: (result) => {
      committed = result.recipe.seed;
      events.push(`publish:${committed}`);
    },
    persist: async (record) => {
      events.push(`persist:${record.recipe.seed}`);
      return { error: null, notice: null };
    },
    ...overrides,
  };
  return {
    controller: createPreviewController(ports),
    events,
    ports,
    committed: () => committed,
    lose: () => {
      usable = false;
    },
  };
}
test("displaying and cancelling a preview do not publish or persist it", async () => {
  const f = fixture(),
    p = await f.controller.preview(review());
  expect(f.controller.getState().phase).toBe("preview");
  expect(f.events).toEqual([]);
  expect(f.committed()).toBe(7);
  f.controller.cancel();
  expect(f.events).toEqual(["rollback:42"]);
  expect(f.committed()).toBe(7);
  await expect(f.controller.use(p.ticket)).rejects.toThrow();
});
test("same-ticket repeated use shares one transaction and saves only after commit", async () => {
  const f = fixture(),
    p = await f.controller.preview(review());
  const first = f.controller.use(p.ticket),
    second = f.controller.use(p.ticket);
  expect(second).toBe(first);
  const saved = await first;
  expect(saved.record.recipe.seed).toBe(42);
  expect(f.events).toEqual(["commit:42", "publish:42", "persist:42"]);
  await expect(f.controller.use(p.ticket)).rejects.toThrow();
});
test.each(["cancel", "new-preview", "lost"])(
  "%s during async record preparation prevents stale commit and storage",
  async (action) => {
    const gate = deferred<SceneReviewRecord>();
    const f = fixture({ record: () => gate.promise }),
      original = review();
    const p = await f.controller.preview(original);
    const used = f.controller.use(p.ticket),
      rejected = expect(used).rejects.toThrow();
    if (action === "cancel") f.controller.cancel();
    if (action === "new-preview") await f.controller.preview(review(43));
    if (action === "lost") f.lose();
    gate.resolve(await createReviewRecord(original));
    await rejected;
    expect(f.events).not.toContain("commit:42");
    expect(f.events).not.toContain("persist:42");
    expect(f.committed()).toBe(7);
    if (action === "new-preview")
      expect(f.controller.getState().phase).toBe("preview");
  },
);
test("late build cannot stage over a newer preview", async () => {
  const gate = deferred<BuildResult>();
  const f = fixture({
    build: (recipe) =>
      recipe.seed === 42 ? gate.promise : Promise.resolve(buildScene(recipe)),
  });
  const a = f.controller.preview(review()),
    rejected = expect(a).rejects.toThrow();
  const b = await f.controller.preview(review(43));
  gate.resolve(buildScene(review().recipe));
  await rejected;
  await f.controller.use(b.ticket);
  expect(f.events).toEqual(["commit:43", "publish:43", "persist:43"]);
});
test("late GPU stage is released without clearing newer transaction ownership", async () => {
  const gate = deferred<StagedPreview>(),
    entered = deferred<void>(),
    released: string[] = [];
  const f = fixture({
    stage: async (result) => {
      if (result.recipe.seed === 42) {
        entered.resolve();
        return gate.promise;
      }
      return {
        commit: () => {},
        rollback: () => released.push("b"),
        isUsable: () => true,
      };
    },
  });
  const a = f.controller.preview(review()),
    rejected = expect(a).rejects.toThrow();
  await entered.promise;
  const b = await f.controller.preview(review(43));
  gate.resolve({
    commit: () => {
      throw Error("stale commit");
    },
    rollback: () => released.push("a"),
    isUsable: () => false,
  });
  await rejected;
  expect(released).toEqual(["a"]);
  expect(f.controller.getState().ticket).toBe(b.ticket);
  await f.controller.use(b.ticket);
  expect(f.committed()).toBe(43);
});
test("no usable display means use is refused", async () => {
  const f = fixture(),
    p = await f.controller.preview(review());
  f.lose();
  await expect(f.controller.use(p.ticket)).rejects.toThrow();
  expect(
    f.events.filter((e) => e.startsWith("commit") || e.startsWith("persist")),
  ).toEqual([]);
});
test("caller edits cannot mutate the review captured for a displayed candidate", async () => {
  const draft = structuredClone(review());
  const f = fixture(),
    p = await f.controller.preview(draft);
  draft.draft.originalRequest.seed = 999;
  draft.recipe.seed = 999;
  const saved = await f.controller.use(p.ticket);
  expect(saved.record.recipe.seed).toBe(42);
  expect(saved.record.draft.originalRequest.seed).toBe(42);
});
test("storage failure returns downloadable record and keeps the scene the user actually used", async () => {
  const f = fixture({
    persist: async () => {
      throw Error("quota");
    },
  });
  const p = await f.controller.preview(review());
  const saved = await f.controller.use(p.ticket);
  expect(saved.saveError).toContain("quota");
  expect(saved.record.recipeHash).toHaveLength(64);
  expect(f.committed()).toBe(42);
  expect(f.events).not.toContain("rollback:42");
});
test("later previews do not erase used records and persistence is ordered", async () => {
  const gate = deferred<{ error: null; notice: null }>(),
    entered = deferred<void>(),
    written: number[] = [];
  const f = fixture({
    persist: async (record) => {
      written.push(record.recipe.seed);
      if (record.recipe.seed === 42) {
        entered.resolve();
        return gate.promise;
      }
      return { error: null, notice: null };
    },
  });
  const a = await f.controller.preview(review()),
    usedA = f.controller.use(a.ticket);
  await entered.promise;
  const b = await f.controller.preview(review(43)),
    usedB = f.controller.use(b.ticket);
  gate.resolve({ error: null, notice: null });
  await Promise.all([usedA, usedB]);
  expect(written).toEqual([42, 43]);
  expect(f.committed()).toBe(43);
  expect(f.events).not.toContain("rollback:42");
});
