import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildScene } from "../build";
import { parseRecipe } from "../recipe";
import type { F0Recipe, AssetCounts } from "../gaussian/types";

// Reuse the original captured goldens; never update them for general-scene work.
const captured: {
  cases: {
    recipe: F0Recipe;
    sceneSHA256: string;
    heightfieldSHA256: string;
    counts: { uniqueSourceSplats: number; activeSplats: number };
    accepted: AssetCounts;
    shortfall: AssetCounts;
    rejections: Record<string, number>;
  }[];
} = JSON.parse(readFileSync("tests/fixtures/pre-catalog-scenes.json", "utf8"));
const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, v) =>
        ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v,
      ),
    )
    .digest("hex");
test.each(captured.cases)(
  "general contracts preserve legacy $recipe.algorithmVersion seed $recipe.seed",
  (c) => {
    const result = buildScene(parseRecipe(c.recipe));
    expect(hash(result.scene)).toBe(c.sceneSHA256);
    expect(hash(result.heightfield)).toBe(c.heightfieldSHA256);
    expect(result.report).toMatchObject({
      ...c.counts,
      accepted: c.accepted,
      shortfall: c.shortfall,
      rejections: c.rejections,
    });
  },
);
