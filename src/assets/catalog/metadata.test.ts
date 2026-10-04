import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as metadata from "./metadata";
import { assetCatalog, ASSET_CATALOG_VERSION } from "./entries";

const copy = () => structuredClone(assetCatalog[0]) as any;
test("catalog contains seven existing versioned assets with truthful origins and no snow placeholders", () => {
  expect(ASSET_CATALOG_VERSION).toBe("asset-catalog-v1");
  expect(assetCatalog).toHaveLength(7);
  expect(new Set(assetCatalog.map((a) => a.id)).size).toBe(7);
  expect(
    assetCatalog.every(
      (a) => a.biomes.length === 1 && a.biomes[0] === "wetland",
    ),
  ).toBe(true);
  const ground = assetCatalog.find((a) => a.id === "riverside-ground-v1")!;
  expect(ground).toMatchObject({
    origin: "captured",
    gaussian: { full: 64949, coarse: null, shBands: 3, sourceBytes: 6291456 },
    provenance: { author: "VeryOS", license: "CC-BY-4.0" },
    spatial: { unit: "display-unit", metricScale: false },
  });
  expect(ground.quality.limitations.join(" ")).toContain("拖尾");
  const source = JSON.parse(
    readFileSync("public/assets/riverside-ground-v1/SOURCE.json", "utf8"),
  );
  expect(ground.provenance.source).toBe(source.source);
  for (const evidence of ground.provenance.files) {
    const bytes = readFileSync(evidence.path);
    expect(bytes.byteLength).toBe(evidence.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      evidence.sha256,
    );
  }
  for (const a of assetCatalog.filter((a) => a.origin === "procedural")) {
    expect(a.gaussian).toEqual({
      full: 4096,
      coarse: 1024,
      shBands: 0,
      sourceBytes: 286720,
    });
    expect(a.provenance.license).toBe("project-internal");
    expect(a.provenance.licenseUrl).toBeNull();
    expect(readFileSync(a.provenance.source, "utf8").length).toBeGreaterThan(0);
  }
  expect(
    assetCatalog.filter((a) => a.quality.status === "legacy"),
  ).toHaveLength(3);
});
test.each([
  (a: any) => {
    a.extra = "unexpected";
  },
  (a: any) => {
    a.id = "../../file";
  },
  (a: any) => {
    a.spatial.dimensions[0] = NaN;
  },
  (a: any) => {
    a.spatial.dimensions[2] = -1;
  },
  (a: any) => {
    a.spatial.unit = "metre";
    a.spatial.metricScale = false;
  },
  (a: any) => {
    a.spatial.upAxis = "Z";
  },
  (a: any) => {
    a.gaussian.full = 250001;
  },
  (a: any) => {
    a.gaussian.coarse = a.gaussian.full + 1;
  },
  (a: any) => {
    a.gaussian.sourceBytes = 0;
  },
  (a: any) => {
    a.biomes = ["snow-mountain", "invented"];
  },
  (a: any) => {
    a.loader = "https://bad.invalid/script";
  },
  (a: any) => {
    a.quality.report = "../../secret";
  },
])("strict metadata rejects invalid contract #%#", (mutate) => {
  const value = copy();
  mutate(value);
  expect(() => metadata.parseAssetMetadata(value)).toThrow();
});
test("captured provenance cannot lose its license or evidence, or point at executable URLs", () => {
  const ground = structuredClone(
    assetCatalog.find((a) => a.origin === "captured")!,
  ) as any;
  for (const change of [
    { license: "project-internal" },
    { author: "" },
    { files: [] },
    { source: "javascript:alert(1)" },
    { licenseUrl: "https://user:secret@example.invalid/" },
    { licenseFile: null },
  ])
    expect(() =>
      metadata.parseAssetMetadata({
        ...ground,
        provenance: { ...ground.provenance, ...change },
      }),
    ).toThrow();
});
test("duplicate IDs and empty catalogs fail; returned catalog is deeply immutable", () => {
  expect(() => metadata.parseCatalog([])).toThrow();
  expect(() => metadata.parseCatalog([copy(), copy()])).toThrow(/重复/);
  expect(Object.isFrozen(assetCatalog)).toBe(true);
  expect(Object.isFrozen(assetCatalog[0].spatial.dimensions)).toBe(true);
  expect(() => {
    (assetCatalog[0].biomes as string[]).push("snow-mountain");
  }).toThrow();
});
