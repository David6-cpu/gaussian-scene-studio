import { expect, test } from "vitest";
import { assetCatalog } from "./entries";
import {
  preparedFixture,
  preparedInput,
} from "../../../tests/support/prepared-fixture";
export const reviewFor = (version: string) => ({
  contentVersion: version,
  licenseChecked: true,
  decision: "trial" as const,
  limitations: ["Workflow test only"],
  recordReference: "docs/validation/riverside-integration.md",
});
test("default context preserves the exact builtin catalog", async () => {
  const { makeCatalogContext, BUILTIN_CONTEXT } = await import("./context");
  expect(await makeCatalogContext(null)).toEqual(BUILTIN_CONTEXT);
  expect(BUILTIN_CONTEXT.entries).toEqual(assetCatalog);
  expect(BUILTIN_CONTEXT.catalogVersion).toBe("asset-catalog-v1");
});
test("reviewed content is frozen and fingerprint bound", async () => {
  const { makeCatalogContext, parseCatalogContext, resolvePreparedDefinition } =
    await import("./context");
  const { asset } = await preparedFixture(),
    ref = {
      id: asset.definition.metadata.id,
      contentVersion: asset.definition.metadata.contentVersion,
    };
  const ctx = await makeCatalogContext(
    asset,
    reviewFor(ref.contentVersion),
    "prepared-ground-only",
  );
  expect(
    ctx.entries.filter((a) => a.category === "ground").map((a) => a.id),
  ).toEqual([ref.id]);
  expect(await parseCatalogContext(JSON.parse(JSON.stringify(ctx)))).toEqual(
    ctx,
  );
  expect(resolvePreparedDefinition(ctx, ref)).toEqual(asset.definition);
  expect(() =>
    resolvePreparedDefinition(ctx, { ...ref, contentVersion: "wrong" }),
  ).toThrow();
  const changed = JSON.parse(JSON.stringify(ctx));
  changed.prepared.purpose = "candidate";
  await expect(parseCatalogContext(changed)).rejects.toThrow();
});
test("duplicate identities and unreviewed content cannot enter candidates", async () => {
  const { makeCatalogContext } = await import("./context"),
    { asset } = await preparedFixture();
  for (const review of [
    undefined,
    {
      ...reviewFor(asset.definition.metadata.contentVersion),
      decision: "pending",
    },
    {
      ...reviewFor(asset.definition.metadata.contentVersion),
      decision: "rejected",
    },
    {
      ...reviewFor(asset.definition.metadata.contentVersion),
      licenseChecked: false,
    },
    { ...reviewFor("wrong") },
  ])
    await expect(makeCatalogContext(asset, review as any)).rejects.toThrow();
  const input = await preparedInput(),
    id = "riverside-ground-v1";
  input.metadata = {
    ...input.metadata,
    id,
    provenance: {
      ...input.metadata.provenance,
      licenseFile: `public/assets/local-ground/${id}/LICENSE.txt`,
      files: input.metadata.provenance.files.map((f) => ({
        ...f,
        path: f.path.replace("test-prepared-ground", id),
      })),
    },
  };
  const { prepareGroundPackage, readPreparedGround } =
    await import("../../io/prepared-ground");
  const dupe = await readPreparedGround(await prepareGroundPackage(input));
  await expect(
    makeCatalogContext(
      dupe,
      reviewFor(dupe.definition.metadata.contentVersion),
    ),
  ).rejects.toThrow(/duplicate|重复/i);
});
