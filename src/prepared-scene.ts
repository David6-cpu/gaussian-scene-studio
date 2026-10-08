import { record, oneOf } from "./data-validation";
import { identifier } from "./assets/catalog/metadata";
import { parseRecipe, defaultRecipe } from "./recipe";
import type {
  F0Recipe,
  PreparedGroundRecipe,
  PreparedBuildResult,
  SceneRecipe,
  SceneBuildResult,
  BuiltScene,
} from "./gaussian/types";
import type { PreparedGroundDefinition } from "./io/prepared-ground";
import {
  resolvePreparedDefinition,
  type CatalogContext,
} from "./assets/catalog/context";
import { buildScene } from "./build";
import { sampleTerrain } from "./terrain/sampling";
import { makeRiverProps } from "./assets/river-props";
import { placeAssets } from "./assets/placement";
import {
  assertSceneBudget,
  sourceBuffers,
  countSplats,
} from "./gaussian/validate";
export function parsePreparedRecipe(value: unknown): PreparedGroundRecipe {
  const r = record(value, [
    ...Object.keys(defaultRecipe),
    "ground",
    "plantKind",
  ]);
  oneOf(r.schemaVersion, [2]);
  oneOf(r.algorithmVersion, ["f0-prepared-ground-v1"]);
  const ref = record(r.ground, ["id", "contentVersion"]),
    id = identifier(ref.id);
  if (
    typeof ref.contentVersion !== "string" ||
    !/^sha256-[a-f0-9]{64}$/.test(ref.contentVersion)
  )
    throw Error("Invalid prepared content version");
  const { ground, plantKind, schemaVersion, algorithmVersion, ...common } = r;
  const base = parseRecipe({
    ...common,
    schemaVersion: 1,
    algorithmVersion: "f0-riverside-grass-v2",
  });
  return {
    ...base,
    schemaVersion: 2,
    algorithmVersion: "f0-prepared-ground-v1",
    ground: { id, contentVersion: ref.contentVersion },
    plantKind: oneOf(plantKind, ["low-grass", "reed"] as const),
  };
}
/** Internal reuse of existing placement rules; never persisted as the selected recipe. */
function placementRecipe(r: PreparedGroundRecipe): F0Recipe {
  const { ground, plantKind, ...common } = r;
  return {
    ...common,
    schemaVersion: 1,
    algorithmVersion:
      plantKind === "reed" ? "f0-riverside-reed-v1" : "f0-riverside-grass-v2",
  };
}
export function buildPreparedScene(
  input: PreparedGroundRecipe,
  d: PreparedGroundDefinition,
): PreparedBuildResult {
  const start = performance.now(),
    recipe = parsePreparedRecipe(input);
  if (
    recipe.ground.id !== d.metadata.id ||
    recipe.ground.contentVersion !== d.metadata.contentVersion
  )
    throw Error("Prepared identity mismatch");
  const p = d.heightProxy;
  if (
    p.width !== 4 ||
    p.depth !== 4 ||
    p.spacing !== 0.1 ||
    p.nx !== 41 ||
    p.nz !== 41 ||
    p.heights.length !== 1681 ||
    p.heights.some((v) => !Number.isFinite(v))
  )
    throw Error("Invalid prepared height proxy");
  const heightfield = { ...p, heights: Float32Array.from(p.heights) },
    t1 = performance.now(),
    r = placementRecipe(recipe);
  const { water } = sampleTerrain(heightfield, r),
    t2 = performance.now(),
    assets = makeRiverProps(recipe.seed, recipe.plantKind),
    t3 = performance.now(),
    placed = placeAssets(heightfield, r, assets),
    t4 = performance.now();
  const scene: BuiltScene = {
    terrain: { count: 0, data: new Float32Array() },
    water,
    assets,
    instances: placed.instances,
    ground: {
      kind: "prepared",
      definition: d,
      id: d.metadata.id,
      count: d.count,
      position: [
        d.display.position[0],
        d.display.position[1],
        d.display.position[2],
      ],
      rotation: [
        d.display.quaternionXYZW[0],
        d.display.quaternionXYZW[1],
        d.display.quaternionXYZW[2],
        d.display.quaternionXYZW[3],
      ],
      scale: d.display.uniformScale,
    },
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
        d.capacity * 96,
    },
  };
}
export function buildSelectedScene(
  recipe: SceneRecipe,
  context: CatalogContext,
): SceneBuildResult {
  return recipe.schemaVersion === 2
    ? buildPreparedScene(
        recipe,
        resolvePreparedDefinition(context, recipe.ground),
      )
    : buildScene(recipe);
}
