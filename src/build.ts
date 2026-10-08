import type { F0Recipe, BuildResult } from "./gaussian/types";
import { parseRecipe, isRiverside, isRiverbank, riverPlantKind } from "./recipe";
import { sampleRiverbankWater, riverbankSurface } from "./terrain/riverbank-water";
import { makeHeightField } from "./terrain/heightfield";
import { sampleTerrain } from "./terrain/sampling";
import { makeCatalogAssets, makeCatalogGround } from "./assets/catalog/wetland";
import { placeAssets } from "./assets/placement";
import {
  riversideHeightField,
  RIVERSIDE_BYTES,
} from "./terrain/riverside";
import {
  assertSceneBudget,
  sourceBuffers,
  countSplats,
} from "./gaussian/validate";
export function buildScene(input: F0Recipe): BuildResult {
  const start = performance.now(),
    recipe = parseRecipe(input),
    riverside = isRiverside(recipe.algorithmVersion),
    heightfield = riverside ? riversideHeightField() : makeHeightField(recipe),
    t1 = performance.now();
  const riverWater = isRiverbank(recipe.algorithmVersion)
      ? sampleRiverbankWater(heightfield, { ...recipe, algorithmVersion: recipe.algorithmVersion }) : null,
    terrain = riverWater ? { terrain: { count: 0, data: new Float32Array() }, water: riverWater.buffer } : sampleTerrain(heightfield, recipe),
    t2 = performance.now(),
    assets = makeCatalogAssets(recipe),
    t3 = performance.now();
  const placed = placeAssets(heightfield, recipe, assets, riverWater ? riverbankSurface(riverWater, riverPlantKind(recipe.algorithmVersion) === "reed") : undefined),
    t4 = performance.now(),
    scene = {
      ...terrain,
      assets,
      instances: placed.instances,
      ...(riverside
        ? {
            terrain: { count: 0, data: new Float32Array() },
            ground: makeCatalogGround(recipe),
          }
        : {}),
    };
  assertSceneBudget(scene);
  const accepted = { rock: 0, reed: 0 };
  for (const i of scene.instances) accepted[i.assetId]++;
  return {
    recipe,
    scene,
    heightfield,
    report: {
      algorithmVersion: recipe.algorithmVersion,
      requested: { ...recipe.requested },
      accepted,
      shortfall: placed.shortfall,
      rejections: placed.rejections,
      stageMs: {
        heightfield: t1 - start,
        sampling: t2 - t1,
        assets: t3 - t2,
        placement: t4 - t3,
        total: performance.now() - start,
      },
      ...countSplats(scene),
      cpuBufferBytes:
        sourceBuffers(scene).reduce((s, b) => s + b.data.byteLength, 0) +
        heightfield.heights.byteLength +
        (riverside ? RIVERSIDE_BYTES : 0),
    },
  };
}
