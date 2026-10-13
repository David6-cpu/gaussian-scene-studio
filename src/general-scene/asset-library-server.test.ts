import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generalFixture,
  constructedReview,
} from "../../tests/support/general-fixture.ts";
import { prepareAssetPackage } from "./asset-package.ts";
import { loadLibrary, registerAsset } from "./asset-library-server.ts";
import { loadAsset } from "./asset-loader.ts";
const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "general-assets-")));
  dirs.push(d);
  return d;
};
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);
test("offline registration copies package exclusively and detects same-name changed bytes", async () => {
  const f = await generalFixture();
  const root = join(temp(), "library");
  const index = await registerAsset({
    root,
    packageBytes: await prepareAssetPackage(f.manifest, f.members),
    review: constructedReview(f.manifest),
  });
  const lib = await loadLibrary(index);
  expect(lib.manifests[0].quality.status).toBe("candidate");
  await expect(
    registerAsset({
      root,
      packageBytes: await prepareAssetPackage(f.manifest, f.members),
      review: constructedReview(f.manifest),
    }),
  ).rejects.toThrow();
  await loadAsset(f.manifest, lib, new AbortController().signal);
  const entry = JSON.parse(readFileSync(index, "utf8")).entries[0];
  const p = join(root, entry.package),
    b = readFileSync(p);
  b[b.length - 1] ^= 1;
  writeFileSync(p, b);
  await expect(
    loadAsset(f.manifest, lib, new AbortController().signal),
  ).rejects.toThrow(/changed|digest/i);
});
test("unmatched review cannot admit accepted assets and creates no root", async () => {
  const f = await generalFixture();
  const r: any = constructedReview(f.manifest);
  r.asset.contentVersion = "wrong";
  const root = join(temp(), "library");
  await expect(
    registerAsset({
      root,
      packageBytes: await prepareAssetPackage(f.manifest, f.members),
      review: r,
    }),
  ).rejects.toThrow(/review/i);
});
test("constructed review cannot claim human acceptance", async () => {
  const f = await generalFixture();
  const r: any = constructedReview(f.manifest);
  r.quality.status = "accepted";
  await expect(
    registerAsset({
      root: join(temp(), "library"),
      packageBytes: await prepareAssetPackage(f.manifest, f.members),
      review: r,
    }),
  ).rejects.toThrow();
});
test("symlink escape and unsafe index package path are rejected", async () => {
  const f = await generalFixture();
  const root = join(temp(), "library"),
    index = await registerAsset({
      root,
      packageBytes: await prepareAssetPackage(f.manifest, f.members),
      review: constructedReview(f.manifest),
    });
  const i = JSON.parse(readFileSync(index, "utf8")),
    p = join(root, i.entries[0].package),
    outside = join(temp(), "outside.zip");
  writeFileSync(outside, readFileSync(p));
  rmSync(p);
  symlinkSync(outside, p);
  await expect(loadLibrary(index)).rejects.toThrow();
  i.entries[0].package = "../outside.zip";
  writeFileSync(index, JSON.stringify(i));
  await expect(loadLibrary(index)).rejects.toThrow();
});

test("registered library preserves strictly verified surface styles", async () => {
  const { createCatalogView, styleContentVersion } =
    await import("./asset-library.ts");
  const { manifestFixture } = await import("./test-fixtures.ts");
  const f = await generalFixture(),
    root = join(temp(), "library"),
    index = await registerAsset({
      root,
      packageBytes: await prepareAssetPackage(f.manifest, f.members),
      review: constructedReview(f.manifest),
    });
  const m = manifestFixture("patch"),
    s: any = {
      id: "constructed-style",
      contentVersion: "pending",
      parameters: { roughness: 0.5 },
      quality: m.quality,
      provenance: m.provenance,
    };
  s.contentVersion = await styleContentVersion(s);
  const i = JSON.parse(readFileSync(index, "utf8"));
  i.styles = [s];
  writeFileSync(index, JSON.stringify(i));
  expect((await loadLibrary(index)).styles[0]).toEqual(s);
  i.styles[0].parameters.roughness = 0.9;
  writeFileSync(index, JSON.stringify(i));
  await expect(loadLibrary(index)).rejects.toThrow(/identity/i);
});

test("registration snapshots review before asynchronous verification", async () => {
  const f = await generalFixture();
  const review: any = constructedReview(f.manifest),
    root = join(temp(), "library");
  const pending = registerAsset({
    root,
    packageBytes: await prepareAssetPackage(f.manifest, f.members),
    review,
  });
  review.asset.contentVersion = "changed-after-start";
  const library = await loadLibrary(await pending);
  expect(library.manifests[0].contentVersion).toBe(f.manifest.contentVersion);
});

test("registration rejects owned input plus snapshot exceeding CPU cap before copying", async () => {
  const bytes = new Uint8Array(64 * 1024 ** 2),
    Original = Uint8Array;
  const copies = vi
    .spyOn(globalThis, "Uint8Array")
    .mockImplementation(function (...args: any[]) {
      return Reflect.construct(Original, args);
    });
  Object.defineProperty(copies, "prototype", { value: Original.prototype });
  try {
    await expect(
      registerAsset({
        root: join(temp(), "library"),
        packageBytes: bytes,
        review: {},
      }),
    ).rejects.toThrow(/budget/i);
    expect(
      (copies.mock.calls as unknown[][]).some((args) => args[0] === bytes),
    ).toBe(false);
  } finally {
    copies.mockRestore();
  }
});

async function compressedLargeSh3() {
  const { zipSync } = await import("fflate");
  const { canonicalJson, jsonDigest } =
    await import("../io/prepared-ground.ts");
  const { assetContentVersion } = await import("./asset-package.ts");
  const f = await generalFixture({ count: 250000, sh3: true });
  const m = structuredClone(f.manifest);
  const coarse = m.files
    .filter((file) => file.path.includes("-full-"))
    .map((file) => {
      const path = file.path.replace("-full-", "-coarse-");
      f.members.set(path, f.members.get(file.path)!);
      return { ...file, path };
    });
  const sourceBytes = [...m.files, ...coarse].reduce(
    (sum, file) => sum + file.bytes,
    0,
  );
  const manifest = {
    ...m,
    files: [...m.files, ...coarse],
    gaussian: {
      ...m.gaussian,
      coarse: { ...m.gaussian.full, sha256: await jsonDigest(coarse) },
    },
    resources: {
      decodedBytes: sourceBytes,
      cpuSourceBytes: sourceBytes,
      uploadBytes: sourceBytes,
    },
  };
  manifest.contentVersion = await assetContentVersion(manifest);
  return {
    manifest,
    bytes: zipSync(
      {
        ...Object.fromEntries(f.members),
        "manifest.json": new TextEncoder().encode(canonicalJson(manifest)),
      },
      { level: 6 },
    ),
  };
}

test("server loading full/coarse 250k SH3 does not decode a nested asset for every member", async () => {
  const f = await compressedLargeSh3();
  const index = await registerAsset({
    root: join(temp(), "library"),
    packageBytes: f.bytes,
    review: constructedReview(f.manifest),
  });
  const library = await loadLibrary(index);
  const Original = Uint32Array;
  let arrays = 0;
  const allocations = vi
    .spyOn(globalThis, "Uint32Array")
    .mockImplementation(function (...args: any[]) {
      if (args[0] === 251904 * 4 && ++arrays > 12)
        throw Error("nested full-asset decode exceeds outer ownership budget");
      return Reflect.construct(Original, args);
    });
  Object.defineProperty(allocations, "prototype", {
    value: Original.prototype,
  });
  try {
    const loaded = await loadAsset(
      f.manifest,
      library,
      new AbortController().signal,
    );
    expect([loaded.full.count, loaded.coarse?.count]).toEqual([250000, 250000]);
    expect(arrays).toBe(12);
  } finally {
    allocations.mockRestore();
  }
}, 60000);

test("registration reserves its input and snapshot while checking the old library", async () => {
  const old = await compressedLargeSh3();
  const root = join(temp(), "library");
  const index = await registerAsset({
    root,
    packageBytes: old.bytes,
    review: constructedReview(old.manifest),
  });
  const before = readFileSync(index),
    names = readdirSync(root).sort();
  const f = await generalFixture({ count: 250000 });
  const { assetContentVersion } = await import("./asset-package.ts");
  const id = "constructed-second";
  const manifest = {
    ...f.manifest,
    id,
    files: f.manifest.files.map((file) => ({
      ...file,
      path: file.path.replace(f.manifest.id, id),
    })),
  };
  manifest.contentVersion = await assetContentVersion(manifest);
  const members = new Map(
    [...f.members].map(([name, bytes]) => [
      name.replace(f.manifest.id, id),
      bytes,
    ]),
  );
  const packageBytes = await prepareAssetPackage(manifest, members);
  const Original = Uint32Array;
  let oldArrays = 0;
  const allocations = vi
    .spyOn(globalThis, "Uint32Array")
    .mockImplementation(function (...args: any[]) {
      if (args[0] === 251904 * 4) oldArrays++;
      return Reflect.construct(Original, args);
    });
  Object.defineProperty(allocations, "prototype", {
    value: Original.prototype,
  });
  try {
    await expect(
      registerAsset({
        root,
        packageBytes,
        review: constructedReview(manifest),
      }),
    ).rejects.toThrow(/budget/i);
    expect(oldArrays).toBe(0);
  } finally {
    allocations.mockRestore();
  }
  expect(readFileSync(index)).toEqual(before);
  expect(readdirSync(root).sort()).toEqual(names);
}, 60000);

async function styleFixture(id: string) {
  const { manifestFixture } = await import("./test-fixtures.ts");
  const { styleContentVersion } = await import("./asset-library.ts");
  const { parseAssetManifest } = await import("./asset-manifest.ts");
  const m = parseAssetManifest(manifestFixture("patch"));
  const style = {
    id,
    contentVersion: "pending",
    parameters: { roughness: 0.5 },
    quality: { ...m.quality, limitations: [] as string[] },
    provenance: m.provenance,
  };
  style.contentVersion = await styleContentVersion(style);
  return style;
}

test("registration rejects a style ID collision without publishing or damaging the existing index", async () => {
  const f = await generalFixture();
  const style = await styleFixture(f.manifest.id);
  const root = temp(),
    index = join(root, "index.json");
  const before = JSON.stringify({
    format: "general-scene-library",
    version: 1,
    entries: [],
    styles: [style],
  });
  writeFileSync(index, before);
  expect((await loadLibrary(index)).styles).toEqual([style]);
  await expect(
    registerAsset({
      root,
      packageBytes: await prepareAssetPackage(f.manifest, f.members),
      review: constructedReview(f.manifest),
    }),
  ).rejects.toThrow(/catalog.*ID/i);
  expect(readFileSync(index, "utf8")).toBe(before);
  expect((await loadLibrary(index)).styles).toEqual([style]);
  expect(readdirSync(root)).toEqual(["index.json"]);
});

test("registration checks complete catalog JSON size before writing a smaller valid index", async () => {
  const { canonicalJson } = await import("../io/prepared-ground.ts");
  const { GENERAL_LIMITS } = await import("./core.ts");
  const f = await generalFixture();
  const review = constructedReview(f.manifest);
  const entry = {
    package: `${f.manifest.id}-${f.manifest.contentVersion}.zip`,
    packageSha256: "0".repeat(64),
    review,
  };
  const styles = await Promise.all(
    Array.from({ length: 64 }, (_, i) =>
      styleFixture(`constructed-style-${i}`),
    ),
  );
  const view = { manifests: [], styles };
  const manifestSize = canonicalJson(f.manifest).length,
    entrySize = canonicalJson(entry).length;
  expect(manifestSize).toBeGreaterThan(entrySize + 200);
  const target =
    GENERAL_LIMITS.maxJsonBytes - Math.floor((manifestSize + entrySize) / 2);
  let remaining = target - canonicalJson(view).length;
  for (const style of styles) {
    for (let n = 0; n < 32 && remaining > 3; n++) {
      const overhead = n === 0 ? 2 : 3,
        length = Math.min(1000, remaining - overhead);
      style.quality.limitations.push("x".repeat(length));
      remaining -= length + overhead;
    }
  }
  expect(remaining).toBeLessThanOrEqual(3);
  const initial = {
    format: "general-scene-library",
    version: 1,
    entries: [] as unknown[],
    styles,
  };
  expect(canonicalJson({ ...initial, entries: [entry] }).length).toBeLessThan(
    GENERAL_LIMITS.maxJsonBytes,
  );
  expect(
    canonicalJson({ manifests: [f.manifest], styles }).length,
  ).toBeGreaterThan(GENERAL_LIMITS.maxJsonBytes);
  const root = temp(),
    index = join(root, "index.json"),
    before = canonicalJson(initial);
  writeFileSync(index, before);
  expect((await loadLibrary(index)).styles.length).toBe(64);
  await expect(
    registerAsset({
      root,
      packageBytes: await prepareAssetPackage(f.manifest, f.members),
      review,
    }),
  ).rejects.toThrow(/catalog JSON/i);
  expect(readFileSync(index, "utf8")).toBe(before);
  expect((await loadLibrary(index)).styles.length).toBe(64);
  expect(readdirSync(root)).toEqual(["index.json"]);
}, 60000);
