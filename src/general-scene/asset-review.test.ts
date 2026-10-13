import { expect, test } from "vitest";
import { makeReviewPacket, reviewViews } from "./asset-review";
import { worldPoint } from "./render/types";
import { parseAssetManifest } from "./asset-manifest";
import type { LoadedAsset } from "./asset-loader";
import { manifestFixture } from "./test-fixtures";
test("inspection packet preserves immutable manifest and applies normalization only to raw render frame", () => {
  const m = parseAssetManifest(manifestFixture());
  const asset: LoadedAsset = {
    manifest: m,
    full: { kind: "float14", count: 1, data: new Float32Array(14) },
    coarse: null,
    patch: null,
  };
  const before = JSON.stringify(m);
  const p = makeReviewPacket(asset, "full");
  expect(p.instances).toHaveLength(1);
  expect(
    worldPoint(
      p.instances[0].anchor,
      p.instances[0].anchor,
      p.instances[0].transform,
    ),
  ).toEqual([0, 0, 0]);
  expect(reviewViews(m).map((v) => v.name)).toEqual([
    "front",
    "back",
    "top",
    "low",
    "minimum-distance",
  ]);
  expect(JSON.stringify(m)).toBe(before);
});
