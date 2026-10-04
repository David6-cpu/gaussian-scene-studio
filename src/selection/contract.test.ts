import { expect, test } from "vitest";
import {
  parseAssetRequest,
  defaultAssetRequest,
  requirementsFor,
  candidateSnapshot,
  checkChoices,
  compileSelection,
  assertAssetPrompt,
} from "./contract";
import { buildScene } from "../build";
const choices = (plant = "river-low-grass-v2") => ({
  choices: [
    { key: "ground", assetId: "riverside-ground-v1" },
    { key: "rocks", assetId: "river-rock-v1" },
    { key: "plants", assetId: plant },
  ],
});
const confirmed = ["river-rock-v1", "river-low-grass-v2"];
test("fixed roles produce actual candidates and zero roles are omitted", () => {
  const r = parseAssetRequest(defaultAssetRequest);
  expect(requirementsFor(r).elements.map((e) => e.key)).toEqual([
    "ground",
    "rocks",
    "plants",
  ]);
  expect(candidateSnapshot(r).map((c) => c.assetIds)).toEqual([
    ["riverside-ground-v1"],
    ["river-rock-v1"],
    ["river-low-grass-v2"],
  ]);
  expect(
    candidateSnapshot({ ...r, rockCount: 0, plantKind: "none", plantCount: 0 }),
  ).toHaveLength(1);
});
test.each([
  { script: "x" },
  { rockCount: 21 },
  { plantCount: 20 },
  { seed: NaN },
  { waterLevel: 2 },
  { plantKind: "tree" },
  { plantKind: "none", plantCount: 2 },
  { plantKind: "reed", plantCount: 0 },
])("invalid request is rejected %j", (patch) => {
  expect(() =>
    parseAssetRequest({ ...defaultAssetRequest, ...patch }),
  ).toThrow();
});
test.each([
  { biome: "snow-mountain" },
  { biome: "unsupported" },
  { unit: "metre" },
  { groundOrigin: "procedural" },
  { plantOrigin: "captured" },
  { clarification: "需要树木素材" },
])("unavailable or unresolved demand has no substitute %j", (patch) => {
  expect(() =>
    candidateSnapshot(parseAssetRequest({ ...defaultAssetRequest, ...patch })),
  ).toThrow(/缺失|澄清|不支持/);
});
test.each(
  [
    [
      { key: "ground", assetId: "https://fake" },
      { key: "rocks", assetId: "river-rock-v1" },
      { key: "plants", assetId: "river-low-grass-v2" },
    ],
    [
      { key: "ground", assetId: "riverside-ground-v1" },
      { key: "rocks", assetId: "river-low-grass-v2" },
      { key: "plants", assetId: "river-rock-v1" },
    ],
    [
      { key: "ground", assetId: "riverside-ground-v1" },
      { key: "plants", assetId: "river-low-grass-v2" },
    ],
    [
      { key: "ground", assetId: "riverside-ground-v1" },
      { key: "rocks", assetId: "legacy-rock-v1" },
      { key: "plants", assetId: "river-low-grass-v2" },
    ],
  ].map((value) => ({ value })),
)("forged or mismatched selection rejected", ({ value }) =>
  expect(() => checkChoices(defaultAssetRequest, { choices: value })).toThrow(),
);
test("programmatic assets need exact human confirmation and IDs affect actual Gaussian arrays", () => {
  expect(() => compileSelection(defaultAssetRequest, choices(), [])).toThrow(
    /确认/,
  );
  const grass = buildScene(
    compileSelection(defaultAssetRequest, choices(), confirmed),
  );
  const reed = buildScene(
    compileSelection(
      { ...defaultAssetRequest, plantKind: "reed" },
      choices("river-reed-v1"),
      ["river-rock-v1", "river-reed-v1"],
    ),
  );
  expect(grass.recipe.algorithmVersion).toBe("f0-riverside-grass-v2");
  expect(reed.recipe.algorithmVersion).toBe("f0-riverside-reed-v1");
  expect(grass.scene.assets[1].lods.full.data).not.toEqual(
    reed.scene.assets[1].lods.full.data,
  );
  expect(grass.report.activeSplats).toBeLessThanOrEqual(250000);
  expect(() =>
    compileSelection(defaultAssetRequest, choices(), [...confirmed, "fake"]),
  ).toThrow();
});
test.each([
  "沙漠里三块石头",
  "森林有树木",
  "雪山河岸",
  "a snowfield",
  "6米见方湿地",
  "左侧石头右侧草",
  "湿地有小鹿",
])("unsupported explicit prompt needs clarification: %s", (s) =>
  expect(() => assertAssetPrompt(s)).toThrow(/澄清|缺失/),
);
test("bounded wetland prompt is allowed", () =>
  expect(() =>
    assertAssetPrompt("湿地，2组碎石、4丛低草，水位0，种子42。"),
  ).not.toThrow());
