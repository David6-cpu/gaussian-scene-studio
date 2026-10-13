import { expect, test, vi } from "vitest";
import { generalFixture } from "../../tests/support/general-fixture.ts";
import { makeAssetLibrary, createCatalogView } from "./asset-library.ts";
import { loadAsset } from "./asset-loader.ts";
async function setup(options = {}) {
  const f = await generalFixture(options);
  const view = await createCatalogView([f.manifest], []);
  return {
    ...f,
    view,
    library: makeAssetLibrary(view, async (_ref, name) => f.members.get(name)!),
  };
}
test.each([false, true])(
  "loads full/coarse and validates real fields for SH3=%s",
  async (sh3) => {
    const f = await setup({ sh3, coarse: true });
    const a = await loadAsset(
      f.manifest,
      f.library,
      new AbortController().signal,
    );
    expect(a.full.kind).toBe(sh3 ? "ext-sh3" : "float14");
    expect(a.full.count).toBe(4);
    expect(a.coarse?.count).toBe(2);
    expect(a.patch).toBeNull();
  },
);
test("fixed 4x4 constructed patch preserves declared nonzero error bound", async () => {
  const f = await setup({ sh3: true, patch: true });
  const a = await loadAsset(
    f.manifest,
    f.library,
    new AbortController().signal,
  );
  expect(a.patch).toMatchObject({
    width: 4,
    depth: 4,
    spacing: 0.1,
    errorBound: 0.01,
  });
  expect(a.patch?.heights.length).toBe(1681);
});
test("nonzero anchor is not subtracted by loading", async () => {
  const f = await setup();
  const { assetContentVersion } = await import("./asset-package.ts");
  const m: any = structuredClone(f.manifest);
  m.object.anchor[1] = 0.1;
  m.contentVersion = await assetContentVersion(m);
  const l = makeAssetLibrary(await createCatalogView([m], []), async (_r, n) =>
    f.members.get(n)!,
  );
  const a = await loadAsset(m, l, new AbortController().signal);
  expect(a.manifest.kind === "object" && a.manifest.object.anchor[1]).toBe(0.1);
  expect(a.full.kind === "float14" && a.full.data[1]).toBe(0.5);
});
test.each(["full", "coarse"])(
  "rejects changed %s bytes and changed ref",
  async (lod) => {
    const f = await setup({ coarse: true });
    f.members.get(`${f.manifest.id}-${lod}.f32`)![0] ^= 1;
    await expect(
      loadAsset(f.manifest, f.library, new AbortController().signal),
    ).rejects.toThrow(/digest/i);
    await expect(
      loadAsset(
        { ...f.manifest, contentVersion: "changed" },
        f.library,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
test("pre-abort never resolves; mid-resolution abort cannot publish", async () => {
  const f = await setup();
  const c = new AbortController();
  c.abort();
  const resolve = vi.fn(async () => new Uint8Array());
  const l = makeAssetLibrary(f.view, resolve);
  await expect(loadAsset(f.manifest, l, c.signal)).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
  const c2 = new AbortController();
  const late = makeAssetLibrary(f.view, async (_r, n) => {
    c2.abort();
    return f.members.get(n)!;
  });
  await expect(loadAsset(f.manifest, late, c2.signal)).rejects.toThrow();
});
test("decoding yields to timers and aborts before publication", async () => {
  const f = await setup({ count: 30000 });
  const c = new AbortController();
  let returned = 0;
  const l = makeAssetLibrary(f.view, async (_r, n) => {
    returned++;
    if (n.endsWith("full.f32")) setTimeout(() => c.abort(), 0);
    return f.members.get(n)!;
  });
  await expect(loadAsset(f.manifest, l, c.signal)).rejects.toThrow();
  expect(returned).toBeGreaterThan(0);
});
test("rejects oversized declaration before resolving a member", async () => {
  const f = await setup();
  const m: any = structuredClone(f.manifest);
  m.resources.decodedBytes = 128 * 1024 ** 2 + 1;
  let calls = 0;
  const fake = {
    ...f.library,
    manifests: [m],
    resolveMember: async () => {
      calls++;
      return new Uint8Array();
    },
  };
  await expect(
    loadAsset(m, fake, new AbortController().signal),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test.each([false, true])(
  "nonidentity normalization preserves source arrays SH3=%s",
  async (sh3) => {
    const f = await setup({ sh3, coarse: true });
    const { assetContentVersion } = await import("./asset-package.ts");
    const m: any = structuredClone(f.manifest);
    m.coordinates.sourceToCanonical = {
      position: [2, 3, 4],
      quaternion: [1, 0, 0, 0],
      scale: 13,
    };
    m.contentVersion = await assetContentVersion(m);
    const l = makeAssetLibrary(
      await createCatalogView([m], []),
      async (_r, n) => f.members.get(n)!,
    );
    const a = await loadAsset(m, l, new AbortController().signal);
    if (a.full.kind === "float14") expect(a.full.data[1]).toBe(0.5);
    else
      expect(new Uint8Array(a.full.arrays.ext0.buffer)).toEqual(
        f.members.get(`${m.id}-full-ext0.u32`),
      );
    expect(a.manifest.coordinates.sourceToCanonical).toEqual(
      m.coordinates.sourceToCanonical,
    );
  },
);

test("abort is delivered after several actual decode chunks, not only during resolution", async () => {
  const f = await setup({ count: 30000 });
  const c = new AbortController(),
    original = setTimeout;
  let turns = 0;
  const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
  ) =>
    original(() => {
      turns++;
      if (turns === 5) c.abort();
      callback();
    }, 0)) as typeof setTimeout);
  try {
    await expect(loadAsset(f.manifest, f.library, c.signal)).rejects.toThrow();
    expect(turns).toBe(5);
  } finally {
    timers.mockRestore();
  }
});
