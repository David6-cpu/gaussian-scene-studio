import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildScene } from "../../build";
import { parseRecipe, riversideRecipe } from "../../recipe";
import { assetCatalog } from "./entries";
import { makeCatalogAssets, wetlandBinding } from "./wetland";
import type { AssetMetadata } from "./metadata";
import type { F0Recipe, AssetCounts } from "../../gaussian/types";

const captured: {
  sourceCommit: string;
  cases: {
    recipe: F0Recipe;
    sceneSHA256: string;
    heightfieldSHA256: string;
    counts: { uniqueSourceSplats: number; activeSplats: number };
    accepted: AssetCounts;
    shortfall: AssetCounts;
    rejections: Record<string, number>;
  }[];
} = JSON.parse(
  readFileSync("tests/fixtures/pre-catalog-scenes.json", "utf8"),
);
const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, v) =>
        ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v,
      ),
    )
    .digest("hex");
test.each(captured.cases)(
  "catalog integration preserves pre-catalog scene $recipe.algorithmVersion / seed $recipe.seed",
  (c) => {
    const r = buildScene(parseRecipe(c.recipe));
    expect(hash(r.scene)).toBe(c.sceneSHA256);
    expect(hash(r.heightfield)).toBe(c.heightfieldSHA256);
    expect(r.report).toMatchObject({
      ...c.counts,
      accepted: c.accepted,
      shortfall: c.shortfall,
      rejections: c.rejections,
    });
    expect(makeCatalogAssets(r.recipe)).toEqual(r.scene.assets);
  },
);
test("wetland binding keeps legacy slots but identifies actual grass independently", () => {
  expect(wetlandBinding("f0-riverside-grass-v2")).toEqual({
    ground: "riverside-ground-v1",
    rock: "river-rock-v1",
    reed: "river-low-grass-v2",
  });
  expect(wetlandBinding("f0-riverside-reed-v1").reed).toBe("river-reed-v1");
  expect(wetlandBinding("f0-v1")).toEqual({
    ground: null,
    rock: "legacy-rock-v1",
    reed: "legacy-plant-v1",
  });
  expect(() => wetlandBinding("snow-scene" as any)).toThrow();
});
test("missing, mismatched or inaccurate metadata cannot silently replace an old asset", () => {
  const recipe = {
    ...riversideRecipe,
    algorithmVersion: "f0-riverside-grass-v2" as const,
  };
  expect(() =>
    makeCatalogAssets(
      recipe,
      assetCatalog.filter((a) => a.id !== "river-low-grass-v2"),
    ),
  ).toThrow(/缺失/);
  const inaccurate = assetCatalog.map((a) =>
    a.id === "river-rock-v1"
      ? { ...a, gaussian: { ...a.gaussian, full: 1024 } }
      : a,
  );
  expect(() => makeCatalogAssets(recipe, inaccurate)).toThrow(/点数/);
  const wrongLoader = assetCatalog.map((a) =>
    a.id === "river-rock-v1" ? { ...a, loader: "legacy-rock-v1" } : a,
  ) as AssetMetadata[];
  expect(() => makeCatalogAssets(recipe, wrongLoader)).toThrow(/加载器/);
});
