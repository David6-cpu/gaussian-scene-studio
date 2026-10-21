import { preparedSceneFixture } from "../../tests/support/prepared-scene";
import {
  parsePreparedDefinition,
  preparedContentVersion,
} from "../io/prepared-ground";
import { buildPreparedScene } from "../prepared-scene";
import * as legacyDecoder from "../io/prepared-scene-bundle";
import { packBundle } from "../io/archive";
import { copyLegacyScene } from "./migration";
import { sha256 } from "../io/hash";
import { beforeAll, expect, test, vi } from "vitest";
import { zipSync, unzipSync } from "fflate";
import {
  buildFixture,
  bindBuildProperty,
} from "../../tests/support/general-build-fixture";
import { compileScene, resolvePlan, buildOwnedBytes } from "./compile";
import { documentDigest } from "./canonical";
import {
  makeAssetLibrary,
  createCatalogView,
  styleContentVersion,
} from "./asset-library";
import { assetContentVersion } from "./asset-package";
import { loadAsset } from "./asset-loader";
import { parsePlanDraft } from "./contracts";
import {
  encodeGeneralArchive,
  decodeGeneralArchive,
  validateSnapshot,
  prepareScene,
  restoreDocument,
} from "./archive";
import type { EditableSnapshot } from "./contracts";
import { GENERAL_LIMITS as L, type Result } from "./core";
const take = <T>(r: Result<T>): T => {
  if (!r.ok) throw Error(JSON.stringify(r.issues));
  return r.value;
};
let f: Awaited<ReturnType<typeof buildFixture>>,
  snapshot: EditableSnapshot,
  bytes: Uint8Array;
const context = (n = 0) => ({
  signal: new AbortController().signal,
  resources: { retainedBytes: n },
});
const io = () => ({
  ...context(
    buildOwnedBytes({ snapshot, assets: f.assets, packages: f.packages }),
  ),
  library: f.library,
});
beforeAll(async () => {
  f = await buildFixture({
    river: true,
    slope: 2,
    unusedVariant: true,
    categories: ["rock", "grass"],
  });
  // Explicit isolated redistribution fixture; never modifies or admits the actual catalog.
  const replacements = new Map<string, string>(),
    manifests: any[] = structuredClone([...f.library.manifests]),
    styles: any[] = structuredClone([...f.library.styles]);
  for (const m of [...manifests, ...styles]) {
    const old = m.contentVersion;
    m.provenance.author = "Constructed contributor " + m.id;
    m.provenance.license.attribution =
      "Constructed isolated attribution " + m.id;
    m.provenance.license.id = "constructed-export-test";
    m.provenance.license.redistributable = true;
    m.provenance.license.redistributionBasis =
      "Permission for these isolated constructed test bytes only";
    if ("kind" in m) {
      const license = new TextEncoder().encode(
        "Constructed fixture license: redistribution of these test bytes is permitted. No real asset rights.\n",
      );
      f.packages
        .find((p) => p.manifest.id === m.id)!
        .members.set("license.txt", license);
      const file = m.files.find((x: any) => x.path === "license.txt");
      file.bytes = license.length;
      file.sha256 = await sha256(license);
      m.resources.cpuSourceBytes = m.files.reduce(
        (n: number, x: any) => n + x.bytes,
        0,
      );
      m.quality.humanReview.files = m.files.map((x: any) => ({
        path: x.path,
        sha256: x.sha256,
      }));
      m.contentVersion = await assetContentVersion(m);
    } else m.contentVersion = await styleContentVersion(m);
    m.quality.humanReview.asset.contentVersion = m.contentVersion;
    if (!("kind" in m))
      m.quality.humanReview.files[0].sha256 = m.contentVersion.slice(7);
    replacements.set(old, m.contentVersion);
    replacements.set(old.slice(7), m.contentVersion.slice(7));
  }
  const view = await createCatalogView(manifests, styles);
  replacements.set(f.library.digest, view.digest);
  const replace = (v: any): any =>
    typeof v === "string"
      ? (replacements.get(v) ?? v)
      : Array.isArray(v)
        ? v.map(replace)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, replace(x)]),
            )
          : v;
  f.draft = parsePlanDraft(replace(f.draft));
  f.library = makeAssetLibrary(view, async (ref, name) =>
    f.packages.find((p) => p.manifest.id === ref.id)!.members.get(name)!,
  );
  f.assets = await Promise.all(
    manifests.map((m) => loadAsset(m, f.library, context().signal)),
  );
  const resolved = take(
    await resolvePlan(
      f.draft,
      f.state,
      f.library,
      f.context.signal,
      f.context.resources,
    ),
  );
  snapshot = take(
    await compileScene(
      resolved,
      f.state,
      f.assets.filter((a) => !a.manifest.id.endsWith("-variant")),
      f.context,
    ),
  ).snapshot;
  bytes = await encodeGeneralArchive(
    snapshot,
    f.assets.filter((a) =>
      snapshot.assets.some((s) => s.assetRef.id === a.manifest.id),
    ),
    "embedded",
    io(),
  );
}, 30000);
function alter(edit: (m: any, files: Record<string, Uint8Array>) => void) {
  const files = unzipSync(bytes),
    m = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  edit(m, files);
  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(m));
  return zipSync(files, { level: 0 });
}
test("embedded river roundtrip preserves full document, pre-water base, owners and original catalog", async () => {
  const absent = makeAssetLibrary(
    {
      digest: f.library.digest,
      manifests: f.library.manifests,
      styles: f.library.styles,
    },
    async () => {
      throw Error("No external source");
    },
  );
  const out = take(
    await decodeGeneralArchive(bytes, absent, context(bytes.length)),
  );
  expect(out.editable).toBe(true);
  expect(out.missingRefs).toEqual([]);
  expect(await documentDigest(out.snapshot)).toBe(
    await documentDigest(snapshot),
  );
  expect(out.library?.digest).toBe(f.library.digest);
  expect(out.library?.manifests.length).toBe(f.library.manifests.length);
  expect(
    out.snapshot.assets.map((a) => a.manifest.provenance.license.attribution),
  ).toEqual(
    snapshot.assets.map((a) => a.manifest.provenance.license.attribution),
  );
  expect(
    new Set(
      snapshot.assets.map((a) => a.manifest.provenance.license.attribution),
    ).size,
  ).toBe(2);
  const packed = JSON.parse(
    new TextDecoder().decode(unzipSync(bytes)["manifest.json"]),
  );
  const shared = snapshot.assets.map(
    (a) => a.manifest.files.find((x) => x.path.endsWith(".f32"))!.sha256,
  );
  expect(shared[0]).toBe(shared[1]);
  expect(packed.blobs.filter((b: any) => b.hash === shared[0])).toHaveLength(1);
  expect(out.historyNotice).toMatch(/此前撤销历史/);
  const s = out.snapshot as EditableSnapshot;
  expect(s.terrain.heightModel.kind).toBe("water-profile");
  if (s.terrain.heightModel.kind === "water-profile")
    expect(s.terrain.heightModel.baseHeights.buffer).not.toBe(
      s.terrain.heights.buffer,
    );
  expect(out.ownership.ownedBytes).toBeGreaterThan(0);
  const ref = s.assets[0].assetRef,
    original = await out.library!.resolveMember(
      ref,
      "license.txt",
      context().signal,
    );
  expect(original.length).toBeGreaterThan(0);
  out.ownership.dispose();
  expect(out.ownership.ownedBytes).toBe(0);
  await expect(
    out.library!.resolveMember(ref, "license.txt", context().signal),
  ).rejects.toThrow(/disposed|释放/);
  expect(await documentDigest(out.snapshot)).toBe(
    await documentDigest(snapshot),
  );
});
test("reference export never fetches sources; unavailable exact dependencies remain readonly", async () => {
  const resolve = vi.fn(async () => {
    throw Error("missing exact source");
  });
  const library = makeAssetLibrary(
    {
      digest: f.library.digest,
      manifests: f.library.manifests,
      styles: f.library.styles,
    },
    resolve,
  );
  const ref = await encodeGeneralArchive(snapshot, [], "reference", {
    ...io(),
    library,
  });
  expect(resolve).not.toHaveBeenCalled();
  const out = take(
    await decodeGeneralArchive(ref, library, context(ref.length)),
  );
  expect(out.editable).toBe(false);
  expect(out.snapshot.capability).toBe("editable");
  expect(out.missingRefs[0]).toMatchObject({
    id: snapshot.assets[0].assetRef.id,
    contentVersion: snapshot.assets[0].assetRef.contentVersion,
    digest: snapshot.assets[0].digest,
  });
  out.ownership.dispose();
});
test.each(["future", "digest", "catalog", "missing", "extra", "overlap"])(
  "rejects archive %s before acceptance",
  async (kind) => {
    const bad = alter((m, files) => {
      if (kind === "future") m.formatVersion = 999;
      if (kind === "digest") m.document.digest = "0".repeat(64);
      if (kind === "catalog") m.catalog.digest = "0".repeat(64);
      if (kind === "missing") delete files["payload.bin"];
      if (kind === "extra") files["extra.bin"] = new Uint8Array([1]);
      if (kind === "overlap") m.blobs[1].offset = m.blobs[0].offset;
    });
    expect(
      (await decodeGeneralArchive(bad, f.library, context(bad.length))).ok,
    ).toBe(false);
  },
);
test("rejects a changed payload even with valid ZIP CRC", async () => {
  const bad = alter((_m, files) => {
    files["payload.bin"][0] ^= 1;
  });
  expect(
    (await decodeGeneralArchive(bad, f.library, context(bad.length))).ok,
  ).toBe(false);
});
test("path traversal, 129 files, JSON overflow and expansion bomb are rejected", async () => {
  const cases = [
    zipSync({
      "../outside.bin": new Uint8Array([1]),
      "manifest.json": new Uint8Array([123, 125]),
    }),
    zipSync(
      Object.fromEntries(
        Array.from({ length: 129 }, (_, i) => [
          `file-${i}.bin`,
          new Uint8Array(1),
        ]),
      ),
    ),
    zipSync({
      "manifest.json": new TextEncoder().encode(" ".repeat(L.maxJsonBytes + 1)),
    }),
    zipSync(
      {
        "manifest.json": new TextEncoder().encode("{}"),
        "payload.bin": new Uint8Array(L.maxExpandedPackageBytes + 1),
      },
      { level: 9 },
    ),
  ];
  for (const b of cases)
    expect(
      (await decodeGeneralArchive(b, f.library, context(b.length))).ok,
    ).toBe(false);
});
test("cancellation and unknown caller memory cannot allocate an imported candidate", async () => {
  const abort = new AbortController();
  abort.abort();
  expect(
    (
      await decodeGeneralArchive(bytes, f.library, {
        signal: abort.signal,
        resources: { retainedBytes: bytes.length },
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await decodeGeneralArchive(
        bytes,
        f.library,
        context(L.maxTransitionBytes),
      )
    ).ok,
  ).toBe(false);
  expect(
    (await decodeGeneralArchive(bytes, f.library, undefined as any)).ok,
  ).toBe(false);
});
test("snapshot capture precedes asynchronous source reads", async () => {
  const mutable = structuredClone(snapshot),
    before = await documentDigest(mutable);
  let first = true;
  const library = makeAssetLibrary(
    {
      digest: f.library.digest,
      manifests: f.library.manifests,
      styles: f.library.styles,
    },
    async (ref, name, signal) => {
      if (first) {
        first = false;
        mutable.terrain.heights[0] += 0.01;
        (mutable.camera as any).position = [1, 2, 3];
      }
      return f.library.resolveMember(ref, name, signal);
    },
  );
  const b = await encodeGeneralArchive(
    mutable,
    f.assets.filter((a) =>
      snapshot.assets.some((s) => s.assetRef.id === a.manifest.id),
    ),
    "embedded",
    { ...io(), library },
  );
  const out = take(await decodeGeneralArchive(b, f.library, context(b.length)));
  expect(await documentDigest(out.snapshot)).toBe(before);
  out.ownership.dispose();
});

test("project-internal rights reject embedded and explicitly allow reference export", async () => {
  const local = await buildFixture(),
    r = take(
      await resolvePlan(
        local.draft,
        local.state,
        local.library,
        local.context.signal,
        local.context.resources,
      ),
    );
  const s = take(
    await compileScene(r, local.state, local.assets, local.context),
  ).snapshot;
  const c = {
    ...context(buildOwnedBytes({ s, local })),
    library: local.library,
  };
  await expect(
    encodeGeneralArchive(s, local.assets, "embedded", c),
  ).rejects.toThrow(/reference|引用/);
  expect(
    (await encodeGeneralArchive(s, [], "reference", c)).length,
  ).toBeGreaterThan(0);
});

test("embedded has no external-library requirement; absent reference source stays readonly", async () => {
  const embedded = take(
    await decodeGeneralArchive(bytes, null, context(bytes.length)),
  );
  expect(embedded.editable).toBe(true);
  embedded.ownership.dispose();
  const ref = await encodeGeneralArchive(snapshot, [], "reference", io()),
    missing = take(await decodeGeneralArchive(ref, null, context(ref.length)));
  expect(missing.editable).toBe(false);
  expect(missing.missingRefs).toHaveLength(snapshot.assets.length);
  missing.ownership.dispose();
});
test("duplicate ZIP paths and unknown snapshot schema cannot be accepted", async () => {
  const files = unzipSync(bytes);
  files["payload.ban"] = files["payload.bin"];
  const duplicate = zipSync(files, { level: 0 }),
    needle = new TextEncoder().encode("payload.ban");
  for (let i = 0; i <= duplicate.length - needle.length; i++)
    if (needle.every((v, j) => duplicate[i + j] === v)) duplicate[i + 9] = 105;
  expect(
    (await decodeGeneralArchive(duplicate, null, context(duplicate.length))).ok,
  ).toBe(false);
  const future = alter((m) => {
    m.document.snapshot.schemaVersion = 99;
  });
  expect(
    (await decodeGeneralArchive(future, null, context(future.length))).ok,
  ).toBe(false);
});
test("exact 2MiB manifest is accepted while one more byte is rejected", async () => {
  const files = unzipSync(bytes),
    raw = files["manifest.json"],
    padded = new Uint8Array(L.maxJsonBytes);
  padded.fill(32);
  padded.set(raw);
  files["manifest.json"] = padded;
  const at = zipSync(files, { level: 0 }),
    out = take(await decodeGeneralArchive(at, null, context(at.length)));
  expect(out.editable).toBe(true);
  out.ownership.dispose();
  files["manifest.json"] = new Uint8Array(L.maxJsonBytes + 1);
  const over = zipSync(files, { level: 0 });
  expect(
    (await decodeGeneralArchive(over, null, context(over.length))).ok,
  ).toBe(false);
});
test("100 terrain tile ownership records fit the fixed two-member archive", async () => {
  const seed = await buildFixture(),
    wide = await bindBuildProperty({
      ...seed.draft,
      domain: { ...seed.draft.domain, width: 10, depth: 10 },
    }),
    r = take(
      await resolvePlan(
        wide.draft,
        wide.state,
        wide.library,
        wide.context.signal,
        wide.context.resources,
      ),
    );
  const s = take(
    await compileScene(r, wide.state, wide.assets, wide.context),
  ).snapshot;
  expect(s.terrain.tiles).toHaveLength(100);
  const b = await encodeGeneralArchive(s, [], "reference", {
    ...context(buildOwnedBytes({ s, wide })),
    library: wide.library,
  });
  expect(Object.keys(unzipSync(b))).toHaveLength(2);
  const restored = take(
    await decodeGeneralArchive(b, wide.library, context(b.length)),
  );
  expect(await documentDigest(restored.snapshot)).toBe(await documentDigest(s));
  restored.ownership.dispose();
});

test("legacy integrity validates the original decoder, not just a matching SHA", async () => {
  const original = new TextEncoder().encode(
    "This is not a valid wetland ZIP package.",
  );
  const value = {
    capability: "legacy-readonly",
    originVersion: "wetland-f0-v3",
    original: { bytes: original, digest: await sha256(original) },
  } as any;
  await expect(
    validateSnapshot(value, context(original.length)),
  ).rejects.toThrow(/ZIP|stored|budget/);
});

test("nested IO candidate bytes cannot disappear into the external transition ledger", async () => {
  const held = 120 * 1024 ** 2,
    c = { ...context(held), candidateBytes: held },
    clone = vi.spyOn(globalThis, "structuredClone");
  try {
    await expect(
      encodeGeneralArchive(snapshot, [], "reference", {
        ...c,
        library: f.library,
      }),
    ).rejects.toThrow(/budget/);
    expect(clone).not.toHaveBeenCalled();
  } finally {
    clone.mockRestore();
  }
  const imported = await decodeGeneralArchive(bytes, null, c);
  expect(imported.ok).toBe(false);
  if (!imported.ok) expect(imported.issues[0].message).toMatch(/budget/);
});

test("legal 238000-point v3 is rejected before nested decoder allocations in prepare, encode and restore", async () => {
  const fixture = await preparedSceneFixture(),
    count = 238000,
    capacity = Math.ceil(count / 2048) * 2048,
    d: any = structuredClone(fixture.asset.definition),
    arrays: any = {};
  for (const key of Object.keys(fixture.asset.arrays)) {
    const a = new Uint32Array(capacity * 4),
      point = fixture.asset.arrays[
        key as keyof typeof fixture.asset.arrays
      ].slice(0, 4);
    for (let i = 0; i < count; i++) a.set(point, i * 4);
    arrays[key] = a;
    const file = d.metadata.provenance.files.find((p: any) =>
      p.path.endsWith("/" + key + ".u32"),
    );
    file.bytes = a.byteLength;
    file.sha256 = await sha256(new Uint8Array(a.buffer));
  }
  d.count = count;
  d.capacity = capacity;
  d.metadata.gaussian.full = count;
  d.metadata.gaussian.sourceBytes = capacity * 96;
  d.metadata.contentVersion = await preparedContentVersion(d);
  const definition = await parsePreparedDefinition(d),
    recipe: any = {
      ...fixture.result.recipe,
      ground: {
        id: definition.metadata.id,
        contentVersion: definition.metadata.contentVersion,
      },
      requested: { rock: 0, reed: 0 },
    },
    scene = buildPreparedScene(recipe, definition);
  scene.scene.ground!.arrays = arrays;
  const bundle = await legacyDecoder.encodeSceneBundle(scene),
    original = packBundle(bundle),
    copy = take(
      await copyLegacyScene(
        original,
        context(buildOwnedBytes({ fixture, arrays, scene, bundle, original })),
      ),
    );
  if (copy.capability !== "legacy-readonly")
    throw Error("Expected actual legacy copy");
  const owned = buildOwnedBytes({
      fixture,
      arrays,
      scene,
      bundle,
      original,
      copy,
    }),
    ctx = { ...context(owned), library: null };
  const doc = {
    snapshot: { ...copy, original: { ...copy.original, bytes: null } },
    buffers: [
      {
        path: ["original", "bytes"],
        format: "u8" as const,
        length: copy.original.bytes.length,
        hash: copy.original.digest,
      },
    ],
    digest: await documentDigest(copy),
    resultBytes: copy.original.bytes.length,
  };
  const decode = vi.spyOn(legacyDecoder, "decodeSceneBundle");
  try {
    await expect(prepareScene(copy, ctx, false)).rejects.toThrow(/budget/);
    await expect(
      encodeGeneralArchive(copy, [], "embedded", ctx),
    ).rejects.toThrow(/budget/);
    await expect(
      restoreDocument(
        doc,
        new Map([[copy.original.digest, copy.original.bytes]]),
        ctx,
      ),
    ).rejects.toThrow(/budget/);
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
  expect(await sha256(original)).toBe(copy.original.digest);
}, 30000);
test("ordinary original v3 still roundtrips as validated readonly without an external catalog", async () => {
  const fixture = await preparedSceneFixture(),
    bundle = await legacyDecoder.encodeSceneBundle(fixture.result),
    original = packBundle(bundle),
    copy = take(
      await copyLegacyScene(
        original,
        context(buildOwnedBytes({ fixture, bundle, original })),
      ),
    );
  const encoded = await encodeGeneralArchive(copy, [], "embedded", {
    ...context(buildOwnedBytes({ fixture, bundle, original, copy })),
    library: null,
  });
  const restored = take(
    await decodeGeneralArchive(
      encoded,
      null,
      context(buildOwnedBytes({ fixture, bundle, original, copy, encoded })),
    ),
  );
  expect(restored.snapshot.capability).toBe("legacy-readonly");
  expect(restored.editable).toBe(false);
  expect(await documentDigest(restored.snapshot)).toBe(
    await documentDigest(copy),
  );
});
