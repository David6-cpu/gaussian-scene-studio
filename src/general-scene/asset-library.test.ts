import { expect, test } from "vitest";
import { generalFixture } from "../../tests/support/general-fixture.ts";
import {
  makeAssetLibrary,
  createCatalogView,
  verifyCatalogView,
} from "./asset-library.ts";
test("catalog is an immutable JSON snapshot with exact ID/version/member resolver", async () => {
  const f = await generalFixture();
  const view = await createCatalogView([f.manifest], []);
  let calls = 0;
  const library = makeAssetLibrary(view, async (_ref, name) => {
    calls++;
    return f.members.get(name)!;
  });
  expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  expect(Object.isFrozen(library.manifests[0])).toBe(true);
  const signal = new AbortController().signal;
  await expect(
    library.resolveMember(
      { ...f.manifest, contentVersion: "changed" },
      "license.txt",
      signal,
    ),
  ).rejects.toThrow();
  await expect(
    library.resolveMember(f.manifest, "../private", signal),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  expect(
    await library.resolveMember(f.manifest, "license.txt", signal),
  ).toEqual(f.members.get("license.txt"));
  await verifyCatalogView(view);
});
test("duplicate IDs and tampered digest rejected", async () => {
  const f = await generalFixture();
  await expect(
    createCatalogView([f.manifest, f.manifest], []),
  ).rejects.toThrow();
  const view = await createCatalogView([f.manifest], []);
  await expect(
    verifyCatalogView({ ...view, digest: "0".repeat(64) }),
  ).rejects.toThrow();
});

test("style identity binds parameters but not reviews and nonempty styles survive catalog", async () => {
  const { styleContentVersion, styleIdentityProjection } =
    await import("./asset-library.ts");
  const { manifestFixture } = await import("./test-fixtures.ts");
  const m = manifestFixture("patch");
  const s: any = {
    id: "constructed-style",
    contentVersion: "pending",
    parameters: { roughness: 0.5 },
    quality: m.quality,
    provenance: m.provenance,
  };
  s.contentVersion = await styleContentVersion(s);
  const view = await createCatalogView([], [s]);
  expect(view.styles[0].id).toBe(s.id);
  expect(styleIdentityProjection(s)).toEqual({
    projectionVersion: 1,
    id: s.id,
    parameters: s.parameters,
    provenance: s.provenance,
  });
  s.quality.limitations.push("Review only");
  expect(await styleContentVersion(s)).toBe(view.styles[0].contentVersion);
  s.parameters.roughness = 0.6;
  await expect(createCatalogView([], [s])).rejects.toThrow(/identity/i);
});
