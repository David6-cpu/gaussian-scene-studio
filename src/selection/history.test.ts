import { expect, test } from "vitest";
import {
  confirmAssetPlan,
  importAssetPlan,
  exportAssetPlan,
  loadAssetHistory,
  saveAssetHistory,
  ASSET_HISTORY_KEY,
} from "./history";
import {
  interpretRequest,
  selectAssets,
  parseRequirementEvidence,
} from "./service";
import { defaultAssetRequest } from "./contract";
import { LLAMA_SMALL_MODEL } from "../planner/service";
import { buildScene } from "../build";
const rawChoices = {
  choices: [
    { key: "ground", assetId: "riverside-ground-v1" },
    { key: "rocks", assetId: "river-rock-v1" },
    { key: "plants", assetId: "river-low-grass-v2" },
  ],
};
const reply = (v: unknown) => ({
  raw: JSON.stringify(v),
  model: LLAMA_SMALL_MODEL,
  done: true,
  doneReason: "stop",
});
async function evidence() {
  const first = await interpretRequest(
    "湿地，2组碎石和4丛低草",
    async () => reply(defaultAssetRequest),
    new AbortController().signal,
  );
  const second = await selectAssets(
    defaultAssetRequest,
    async () => reply(rawChoices),
    new AbortController().signal,
  );
  return { first, second };
}
async function plan() {
  const { first, second } = await evidence();
  return confirmAssetPlan(first, second, [
    "river-rock-v1",
    "river-low-grass-v2",
  ]);
}
test("versioned record reopens identical actual recipe and preserves raw evidence", async () => {
  const p = await plan(),
    back = await importAssetPlan(exportAssetPlan(p));
  expect(back.format).toBe("wetland-asset-plan");
  expect(back.schemaVersion).toBe(1);
  expect(back.origin).toBe("imported");
  expect(back.recipe).toEqual(p.recipe);
  expect(back.requirementsSource).toBe("model");
  expect(back.selection.raw).toBe(JSON.stringify(rawChoices));
  expect(buildScene(back.recipe).scene.assets[1].lods.full.data).toEqual(
    buildScene(p.recipe).scene.assets[1].lods.full.data,
  );
});

test("source clarification guard does not break previously confirmed ambiguous-source archives", async () => {
  const { second } = await evidence();
  const archivedFirst = parseRequirementEvidence({
    prompt: "湿地，不是不要实拍草，来源还没定。",
    request: defaultAssetRequest,
    raw: JSON.stringify(defaultAssetRequest),
    model: LLAMA_SMALL_MODEL,
    elapsedMs: 1,
  });
  const original = await confirmAssetPlan(archivedFirst, second, [
    "river-rock-v1",
    "river-low-grass-v2",
  ]);
  const imported = await importAssetPlan(exportAssetPlan(original));
  expect(imported.requirements).toEqual(archivedFirst);
  expect(imported.recipeHash).toBe(original.recipeHash);
  expect(imported.recipe).toEqual(original.recipe);
  expect(imported.schemaVersion).toBe(1);
  expect(imported.origin).toBe("imported");
});
test.each([
  "recipe",
  "hash",
  "metadata",
  "confirmed",
  "candidate",
  "raw",
  "kind",
])("tampered %s is rejected", async (field) => {
  const p: any = JSON.parse(exportAssetPlan(await plan()));
  if (field === "recipe") p.recipe.algorithmVersion = "f0-riverside-reed-v1";
  if (field === "hash") p.recipeHash = "0".repeat(64);
  if (field === "metadata") p.assets[0].provenance.author = "fake";
  if (field === "confirmed") p.confirmedProceduralIds = [];
  if (field === "candidate") p.selection.candidates = [];
  if (field === "raw") p.selection.raw = '{"choices":[]}';
  if (field === "kind") p.requirementsSource = "manual";
  await expect(importAssetPlan(JSON.stringify(p))).rejects.toThrow();
});
test("manual and edited requirements are labeled and never pretend to be model extraction", async () => {
  const { first, second } = await evidence();
  expect(
    (
      await confirmAssetPlan(null, second, [
        "river-rock-v1",
        "river-low-grass-v2",
      ])
    ).requirementsSource,
  ).toBe("manual");
  const different = await selectAssets(
    { ...defaultAssetRequest, seed: 99 },
    async () => reply(rawChoices),
    new AbortController().signal,
  );
  expect(
    (
      await confirmAssetPlan(first, different, [
        "river-rock-v1",
        "river-low-grass-v2",
      ])
    ).requirementsSource,
  ).toBe("edited");
});
test("new history has its own key and corrupt history is reported without writes", async () => {
  const map = new Map([
    ["wetland.plans.v1", "KEEP"],
    [ASSET_HISTORY_KEY, "broken"],
  ]);
  let writes = 0;
  const port = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes++;
      map.set(k, v);
    },
  };
  const loaded = await loadAssetHistory(port);
  expect(loaded.error).toBeTruthy();
  expect(writes).toBe(0);
  expect(map.get("wetland.plans.v1")).toBe("KEEP");
  map.delete(ASSET_HISTORY_KEY);
  const saved = saveAssetHistory(port, [await plan()]);
  expect(saved.error).toBeNull();
  expect(map.get("wetland.plans.v1")).toBe("KEEP");
  expect((await loadAssetHistory(port)).records).toHaveLength(1);
});
test("history limits and quota errors retain a downloadable record", async () => {
  const p = await plan();
  const port = {
    getItem: () => null,
    setItem: () => {
      throw Error("quota");
    },
  };
  const saved = saveAssetHistory(
    port,
    Array.from({ length: 21 }, () => p),
  );
  expect(saved.records).toHaveLength(20);
  expect(saved.notice).toContain("1");
  expect(saved.error).toContain("quota");
  expect(exportAssetPlan(saved.records[0])).toContain("wetland-asset-plan");
  await expect(importAssetPlan(" ".repeat(1048577))).rejects.toThrow(/1MiB/);
});
