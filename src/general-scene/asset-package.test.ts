import { describe, expect, test, vi } from "vitest";
import { generalFixture } from "../../tests/support/general-fixture.ts";
import {
  assetContentVersion,
  assetIdentityProjection,
  prepareAssetPackage,
  readAssetPackage,
} from "./asset-package.ts";
import { parseAssetManifest } from "./asset-manifest.ts";
import { zipSync } from "fflate";
describe("versioned asset package", () => {
  test("constructed float14 package round trips bytes and license", async () => {
    const f = await generalFixture({ coarse: true });
    const p = await readAssetPackage(
      await prepareAssetPackage(f.manifest, f.members),
    );
    expect(p.manifest).toEqual(f.manifest);
    expect(p.members).toEqual(f.members);
    expect(p.manifest.tags).toContain("constructed");
  });
  test("identity projection v1 includes geometry and license but excludes all review conclusions", async () => {
    const f = await generalFixture();
    const m: any = structuredClone(f.manifest);
    expect(assetIdentityProjection(f.manifest)).toHaveProperty(
      "projectionVersion",
      1,
    );
    m.quality.limitations.push("Review-only change");
    m.gaussian.full.quality = {
      status: "failed",
      report: "docs/constructed-failed.md",
    };
    expect(await assetContentVersion(parseAssetManifest(m))).toBe(
      f.manifest.contentVersion,
    );
    m.object.anchor[1] = 0.1;
    expect(await assetContentVersion(parseAssetManifest(m))).not.toBe(
      f.manifest.contentVersion,
    );
    m.object.anchor[1] = 0;
    m.coordinates.sourceToCanonical.scale = 2;
    expect(await assetContentVersion(parseAssetManifest(m))).not.toBe(
      f.manifest.contentVersion,
    );
  });
  test.each([
    "bytes",
    "digest",
    "license",
    "unknown-member",
    "path",
    "identity",
  ])("rejects %s mismatch", async (kind) => {
    const f = await generalFixture();
    const m: any = structuredClone(f.manifest);
    if (kind === "bytes") f.members.set(`${m.id}-full.f32`, new Uint8Array(1));
    if (kind === "digest") f.members.get(`${m.id}-full.f32`)![0] ^= 1;
    if (kind === "license") f.members.delete("license.txt");
    if (kind === "unknown-member")
      f.members.set("extra.bin", new Uint8Array(1));
    if (kind === "path") m.files[0].path = "../license.txt";
    if (kind === "identity") m.coordinates.sourceToCanonical.scale = 2;
    await expect(prepareAssetPackage(m, f.members)).rejects.toThrow();
  });
  test("rejects legacy Riverside archive instead of treating it as new material", async () => {
    const bytes = zipSync({
      "manifest.json": new TextEncoder().encode(
        JSON.stringify({ format: "wetland-prepared-ground", version: 1 }),
      ),
    });
    await expect(readAssetPackage(bytes)).rejects.toThrow();
  });
});

test("rejects an undeclared actual buffer before snapshot copying", async () => {
  const f = await generalFixture();
  const unlisted = new Uint8Array(1024);
  f.members.set("unlisted.bin", unlisted);
  const OriginalUint8Array = Uint8Array;
  const copies = vi
    .spyOn(globalThis, "Uint8Array")
    .mockImplementation(function (...args: any[]) {
      return Reflect.construct(OriginalUint8Array, args);
    });
  Object.defineProperty(copies, "prototype", {
    value: OriginalUint8Array.prototype,
  });
  try {
    await expect(prepareAssetPackage(f.manifest, f.members)).rejects.toThrow(
      /undeclared|member/i,
    );
    expect(
      (copies.mock.calls as unknown[][]).some((args) => args[0] === unlisted),
    ).toBe(false);
  } finally {
    copies.mockRestore();
  }
});
