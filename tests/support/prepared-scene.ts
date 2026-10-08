import { preparedFixture } from "./prepared-fixture";
import { makeCatalogContext } from "../../src/assets/catalog/context";
import {
  defaultAssetRequest,
  compileSelection,
  proceduralIds,
} from "../../src/selection/contract";
import { selectAssets } from "../../src/selection/service";
import { LLAMA_SMALL_MODEL } from "../../src/planner/service";
import { buildSelectedScene } from "../../src/prepared-scene";
export async function preparedSceneFixture() {
  const f = await preparedFixture(),
    d = f.asset.definition;
  const context = await makeCatalogContext(
    f.asset,
    {
      contentVersion: d.metadata.contentVersion,
      licenseChecked: true,
      decision: "trial",
      limitations: ["synthetic test"],
      recordReference: "docs/validation/test.md",
    },
    "prepared-ground-only",
  );
  const choices = [
    { key: "ground", assetId: d.metadata.id },
    { key: "rocks", assetId: "river-rock-v1" },
    { key: "plants", assetId: "river-low-grass-v2" },
  ];
  const selection = await selectAssets(
    defaultAssetRequest,
    async () => ({
      raw: JSON.stringify({ choices }),
      model: LLAMA_SMALL_MODEL,
      done: true,
      doneReason: "stop",
    }),
    new AbortController().signal,
    context,
  );
  const ids = proceduralIds(choices, context),
    recipe = compileSelection(defaultAssetRequest, { choices }, ids, context),
    result = buildSelectedScene(recipe, context);
  result.scene.ground!.arrays = f.asset.arrays;
  return { ...f, context, selection, ids, result };
}
