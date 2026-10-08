import { expect, test } from "vitest";
import { preparedFixture } from "../tests/support/prepared-fixture";
import { makeCatalogContext, BUILTIN_CONTEXT } from "./assets/catalog/context";
import {
  candidateSnapshot,
  checkChoices,
  compileSelection,
  defaultAssetRequest,
  proceduralIds,
} from "./selection/contract";
import { selectAssets, parseChoiceEvidence } from "./selection/service";
import { LLAMA_SMALL_MODEL } from "./planner/service";
const setup = async () => {
  const { asset } = await preparedFixture();
  const context = await makeCatalogContext(
    asset,
    {
      contentVersion: asset.definition.metadata.contentVersion,
      licenseChecked: true,
      decision: "trial",
      limitations: ["fixture"],
      recordReference: "docs/validation/test.md",
    },
    "prepared-ground-only",
  );
  const choices = {
    choices: candidateSnapshot(defaultAssetRequest, context).map((c) => ({
      key: c.key,
      assetId: c.assetIds[0],
    })),
  };
  return { asset, context, choices };
};
test("prepared choice builds the selected identity deterministically", async () => {
  const { buildSelectedScene } = await import("./prepared-scene");
  const { asset, context, choices } = await setup();
  const recipe = compileSelection(
    defaultAssetRequest,
    choices,
    proceduralIds(choices.choices, context),
    context,
  );
  expect(recipe.schemaVersion).toBe(2);
  const a = buildSelectedScene(recipe, context),
    b = buildSelectedScene(recipe, context);
  expect(a.scene.ground?.id).toBe(asset.definition.metadata.id);
  expect(a.scene.ground?.count).toBe(2);
  expect(a.scene.instances).toEqual(b.scene.instances);
  expect(a.heightfield.heights).toEqual(b.heightfield.heights);
  expect(a.scene.terrain.count).toBe(0);
  expect(() => buildSelectedScene(recipe, BUILTIN_CONTEXT)).toThrow();
  expect(() =>
    buildSelectedScene(
      {
        ...recipe,
        ground: {
          id: asset.definition.metadata.id,
          contentVersion: "sha256-" + "0".repeat(64),
        },
      } as any,
      context,
    ),
  ).toThrow();
});
test("server choice schema and independent validator use the same frozen context", async () => {
  const { context, choices } = await setup();
  expect(() =>
    checkChoices(
      defaultAssetRequest,
      { choices: [{ key: "ground", assetId: "fabricated" }] },
      context,
    ),
  ).toThrow();
  const evidence = await selectAssets(
    defaultAssetRequest,
    async (stage, payload, schema) => {
      expect(JSON.stringify(schema)).toContain("test-prepared-ground");
      expect(JSON.stringify(schema)).not.toContain("riverside-ground-v1");
      return {
        raw: JSON.stringify(choices),
        model: LLAMA_SMALL_MODEL,
        done: true,
        doneReason: "stop",
      };
    },
    new AbortController().signal,
    context,
  );
  expect(parseChoiceEvidence(evidence, context)).toEqual(evidence);
  expect(() => parseChoiceEvidence(evidence)).toThrow();
  expect(() =>
    parseChoiceEvidence({ ...evidence, candidates: [] }, context),
  ).toThrow();
});
test("recipe shape, replacement identity and combined active budget are enforced", async () => {
  const { buildPreparedScene, parsePreparedRecipe } =
    await import("./prepared-scene");
  const { asset, context, choices } = await setup();
  const r = compileSelection(
    defaultAssetRequest,
    choices,
    proceduralIds(choices.choices, context),
    context,
  ) as any;
  for (const change of [
    { width: 10 },
    { schemaVersion: 999 },
    { plantKind: "tree" },
    { ground: { id: "missing", contentVersion: r.ground.contentVersion } },
  ])
    expect(() =>
      buildPreparedScene({ ...r, ...change }, asset.definition),
    ).toThrow();
  const d = structuredClone(asset.definition);
  d.count = 250000;
  d.capacity = 251904;
  d.metadata = {
    ...d.metadata,
    gaussian: {
      ...d.metadata.gaussian,
      full: 250000,
      sourceBytes: 251904 * 96,
    },
  };
  expect(() =>
    buildPreparedScene(parsePreparedRecipe({ ...r, waterLevel: null }), d),
  ).toThrow(/250000/);
});
