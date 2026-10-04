import { expect, test } from "vitest";
import { assetCatalog } from "./entries";
import {
  parseRequirements,
  queryAssets,
  validateAssetSelection,
  type SceneRequirements,
} from "./query";

const needs = (
  changes: Partial<SceneRequirements> = {},
): SceneRequirements => ({
  biome: "wetland",
  unit: "display-unit",
  elements: [
    { key: "ground", category: "ground", count: 1, origin: "captured" },
    { key: "rocks", category: "rock", count: 2, origin: "either" },
    { key: "plants", category: "grass", count: 6, origin: "either" },
  ],
  ...changes,
});
const choices = [
  { key: "ground", assetId: "riverside-ground-v1" },
  { key: "rocks", assetId: "river-rock-v1" },
  { key: "plants", assetId: "river-low-grass-v2" },
];
test("queries are stable across catalog order and include only eligible IDs", () => {
  const result = queryAssets(needs());
  expect(result).toEqual(queryAssets(needs(), [...assetCatalog].reverse()));
  expect(result.missing).toEqual([]);
  expect(
    result.candidates.map((c) => ({
      key: c.key,
      ids: c.assets.map((a) => a.id),
    })),
  ).toEqual([
    { key: "ground", ids: ["riverside-ground-v1"] },
    { key: "rocks", ids: ["river-rock-v1"] },
    { key: "plants", ids: ["river-low-grass-v2"] },
  ]);
  expect(result.candidates[2].assets[0].origin).toBe("procedural");
});
test("snow environment is actually missing and captured grass is not replaced by procedural grass", () => {
  const snow = queryAssets(needs({ biome: "snow-mountain" }));
  expect(snow.candidates.every((c) => !c.assets.length)).toBe(true);
  expect(snow.missing.map((m) => m.key)).toEqual(["ground", "rocks", "plants"]);
  expect(snow.missing.every((m) => m.reason === "unavailable")).toBe(true);
  const captured = queryAssets(
    needs({
      elements: [
        { key: "plants", category: "grass", count: 6, origin: "captured" },
      ],
    }),
  );
  expect(captured.candidates[0].assets).toEqual([]);
  expect(captured.missing[0]).toMatchObject({
    key: "plants",
    reason: "unavailable",
  });
});
test("uncalibrated display units do not satisfy metric requirements", () => {
  expect(
    queryAssets(needs({ unit: "metre" })).missing.map((m) => m.reason),
  ).toEqual(["unit", "unit", "unit"]);
});
test("individual asset budget uses requested instances and highest available LOD", () => {
  const q = queryAssets(needs(), assetCatalog, 20000);
  expect(q.missing.map((m) => ({ key: m.key, reason: m.reason }))).toEqual([
    { key: "ground", reason: "budget" },
    { key: "plants", reason: "budget" },
  ]);
  expect(q.candidates[1].assets[0].id).toBe("river-rock-v1");
  expect(() => queryAssets(needs(), assetCatalog, 250001)).toThrow();
});
test("selection requires explicit per-ID procedural acceptance and reports complete worst-case cost", () => {
  expect(() => validateAssetSelection(needs(), choices)).toThrow(/程序.*确认/);
  expect(() =>
    validateAssetSelection(needs(), choices, assetCatalog, {
      confirmedProceduralIds: ["river-rock-v1"],
    }),
  ).toThrow(/程序.*确认/);
  const result = validateAssetSelection(needs(), choices, assetCatalog, {
    confirmedProceduralIds: ["river-rock-v1", "river-low-grass-v2"],
    reservedSplats: 978,
  });
  expect(result.activeSplats).toBe(98695);
  expect(
    result.selected.map((s) => ({
      key: s.key,
      assetId: s.asset.id,
      count: s.count,
    })),
  ).toEqual(choices.map((c, i) => ({ ...c, count: [1, 2, 6][i] })));
  expect(result.warnings.join(" ")).toContain("程序");
  expect(() =>
    validateAssetSelection(needs(), choices, assetCatalog, {
      confirmedProceduralIds: ["river-rock-v1", "river-low-grass-v2"],
      budget: 90000,
    }),
  ).toThrow(/合计/);
  expect(() =>
    validateAssetSelection(needs(), choices, assetCatalog, {
      confirmedProceduralIds: ["river-rock-v1", "river-low-grass-v2"],
      reservedSplats: 250000,
    }),
  ).toThrow(/合计/);
});
test.each(
  [
    [choices[0], choices[1]],
    [choices[0], choices[1], { key: "plants", assetId: "imaginary-tree-v1" }],
    [choices[0], choices[1], { key: "plants", assetId: "legacy-plant-v1" }],
    [choices[0], choices[0], choices[2]],
    [
      choices[0],
      choices[1],
      { key: "plants", assetId: "river-low-grass-v2", count: 200 },
    ],
  ].map((selection) => ({ selection })),
)(
  "untrusted asset choices are checked against recomputed candidates #%#",
  ({ selection }) => {
    expect(() =>
      validateAssetSelection(needs(), selection, assetCatalog, {
        confirmedProceduralIds: ["river-rock-v1", "river-low-grass-v2"],
      }),
    ).toThrow();
  },
);
test("cross-biome choice cannot borrow a compatible-looking wetland rock", () => {
  expect(() =>
    validateAssetSelection(needs({ biome: "snow-mountain" }), choices),
  ).toThrow(/缺失/);
});
test.each([
  { ...needs(), extra: true },
  { ...needs(), biome: "invented" },
  { ...needs(), elements: [] },
  { ...needs(), elements: [...needs().elements, needs().elements[0]] },
  {
    ...needs(),
    elements: [
      { key: "trees", category: "grass", count: 21, origin: "either" },
    ],
  },
  {
    ...needs(),
    elements: [
      { key: "ground", category: "ground", count: 2, origin: "captured" },
    ],
  },
  {
    ...needs(),
    elements: [
      { key: "plants", category: "grass", count: 0, origin: "either" },
    ],
  },
])(
  "invalid structured requirements fail rather than silently narrowing #%#",
  (value) => {
    expect(() => parseRequirements(value)).toThrow();
  },
);
