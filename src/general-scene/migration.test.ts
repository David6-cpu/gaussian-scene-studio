import { beforeAll, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildScene } from "../build";
import { defaultRecipe, riversideRecipe } from "../recipe";
import type { GroundArrays, SceneBuildResult } from "../gaussian/types";
import { riversideData } from "../terrain/riverside-data";
import * as legacyDecoder from "../io/prepared-scene-bundle";
import { packBundle, unpackBundle } from "../io/archive";
import { sha256 } from "../io/hash";
import {
  copyLegacyScene,
  migrateDocumentCopy,
  validateLegacyOriginal,
} from "./migration";
import { preparedSceneFixture } from "../../tests/support/prepared-scene";
import { documentDigest } from "./canonical";
import { parseSnapshot } from "./contracts";
import { GENERAL_LIMITS as L } from "./core";
import type { IOContext } from "./archive";

const originals = new Map<
  number,
  { bytes: Uint8Array; source: SceneBuildResult }
>();
const io = (
  bytes: Uint8Array,
  controller = new AbortController(),
): IOContext => ({
  signal: controller.signal,
  resources: { retainedBytes: bytes.byteLength },
});
beforeAll(async () => {
  const riverside = buildScene(riversideRecipe);
  riverside.scene.ground!.arrays = Object.fromEntries(
    riversideData.outputs.map((o) => [
      o.key,
      new Uint32Array(
        Uint8Array.from(
          readFileSync(`public/assets/riverside-ground-v1/${o.filename}`),
        ).buffer,
      ),
    ]),
  ) as GroundArrays;
  const sources = [
    buildScene(defaultRecipe),
    riverside,
    (await preparedSceneFixture()).result,
  ];
  for (const [i, source] of sources.entries()) {
    originals.set(i + 1, {
      bytes: packBundle(await legacyDecoder.encodeSceneBundle(source)),
      source,
    });
  }
}, 30000);

test.each([1, 2, 3])(
  "legacy v%s creates a separate readonly copy preserving actual original bytes and display",
  async (version) => {
    const { bytes, source } = originals.get(version)!,
      hash = await sha256(bytes);
    const result = await copyLegacyScene(bytes, io(bytes));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const s = parseSnapshot(result.value);
    expect(s.capability).toBe("legacy-readonly");
    expect([
      s.intent,
      s.plan,
      s.state,
      s.terrain,
      s.water,
      s.surfaceStyle,
    ]).toEqual([null, null, null, null, null, null]);
    expect([s.assets, s.instances, s.surfaces]).toEqual([[], [], []]);
    expect(s.reviewStatus).toBe("draft");
    expect(s.quality.semantic.status).not.toBe("pass");
    expect(s.quality.visual.status).not.toBe("pass");
    if (s.capability !== "legacy-readonly") return;
    expect(s.original.digest).toBe(hash);
    expect(await sha256(s.original.bytes)).toBe(hash);
    expect(s.original.bytes.buffer).not.toBe(bytes.buffer);
    expect(s.originVersion).toBe(`wetland-f0-v${version}`);
    const archive = unpackBundle(s.original.bytes),
      opened = await legacyDecoder.decodeSceneBundle(
        archive.manifest,
        archive.files,
      );
    expect(opened.recipe).toEqual(source.recipe);
    expect(opened.scene.instances).toEqual(source.scene.instances);
    expect(opened.scene.terrain).toEqual(source.scene.terrain);
    expect(opened.scene.water).toEqual(source.scene.water);
    if (source.scene.ground) {
      expect(opened.scene.ground?.id).toBe(source.scene.ground.id);
      for (const k of Object.keys(
        source.scene.ground.arrays!,
      ) as (keyof GroundArrays)[]) {
        expect(
          await sha256(new Uint8Array(opened.scene.ground!.arrays![k].buffer)),
        ).toBe(
          await sha256(new Uint8Array(source.scene.ground.arrays![k].buffer)),
        );
      }
    }
    const again = await copyLegacyScene(bytes, io(bytes));
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value.sceneId).not.toBe(s.sceneId);
      expect(again.value.revisionId).not.toBe(s.revisionId);
      expect(again.value.operationId).not.toBe(s.operationId);
    }
  },
  30000,
);

test("legacy bytes and resource context are captured before the first await", async () => {
  const bytes = originals.get(1)!.bytes.slice(),
    hash = await sha256(bytes),
    context = io(bytes);
  const pending = copyLegacyScene(bytes, context);
  bytes.fill(0);
  context.resources.retainedBytes = L.maxTransitionBytes;
  const result = await pending;
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok && result.value.capability === "legacy-readonly") {
    expect(result.value.original.digest).toBe(hash);
    expect(await sha256(result.value.original.bytes)).toBe(hash);
  }
});

test("unsupported environment, future or corrupt legacy data remains untouched", async () => {
  const original = originals.get(1)!.bytes,
    decoded = unpackBundle(original),
    manifest = JSON.parse(decoded.manifest);
  manifest.version = 4;
  const badHash = JSON.parse(decoded.manifest);
  badHash.files[0].sha256 = "0".repeat(64);
  for (const bytes of [
    new TextEncoder().encode("WETENV1\nunsupported"),
    packBundle({ ...decoded, manifest: JSON.stringify(manifest) }),
    packBundle({ ...decoded, manifest: JSON.stringify(badHash) }),
  ]) {
    const hash = await sha256(bytes);
    expect((await copyLegacyScene(bytes, io(bytes))).ok).toBe(false);
    expect(await sha256(bytes)).toBe(hash);
  }
});

test("legacy cancellation and insufficient budgets never enter the original decoder", async () => {
  const bytes = originals.get(1)!.bytes,
    spy = vi.spyOn(legacyDecoder, "decodeSceneBundle");
  try {
    const aborted = new AbortController();
    aborted.abort();
    expect((await copyLegacyScene(bytes, io(bytes, aborted))).ok).toBe(false);
    const pendingAbort = new AbortController(),
      pending = copyLegacyScene(bytes, io(bytes, pendingAbort));
    pendingAbort.abort();
    expect((await pending).ok).toBe(false);
    expect(
      (
        await copyLegacyScene(bytes, {
          signal: new AbortController().signal,
          resources: { retainedBytes: L.maxTransitionBytes },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await copyLegacyScene(bytes, {
          signal: new AbortController().signal,
          resources: { retainedBytes: 0 },
        })
      ).ok,
    ).toBe(false);
    expect(
      (await copyLegacyScene(bytes, undefined as unknown as IOContext)).ok,
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("oversized candidate is rejected before entering the legacy decoder", async () => {
  const unpacked = unpackBundle(originals.get(1)!.bytes);
  unpacked.files.set("unused.gsbin", new Uint8Array(26 * 1024 ** 2));
  const bytes = packBundle(unpacked),
    hash = await sha256(bytes);
  const spy = vi.spyOn(legacyDecoder, "decodeSceneBundle");
  try {
    const result = await copyLegacyScene(bytes, io(bytes));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].message).toMatch(/memory budget/);
    expect(spy).not.toHaveBeenCalled();
    expect(await sha256(bytes)).toBe(hash);
  } finally {
    spy.mockRestore();
  }
});

type Fixture = {
  schemaVersion: number;
  value: { count: number };
  bytes?: Uint8Array;
};
const source = (): Fixture => ({ schemaVersion: 1, value: { count: 3 } });
const steps = [
  {
    from: 1,
    to: 2,
    apply: (x: Fixture) => ({
      ...x,
      schemaVersion: 2,
      value: { count: x.value.count + 1 },
    }),
  },
  {
    from: 2,
    to: 3,
    apply: (x: Fixture) => ({
      ...x,
      schemaVersion: 3,
      value: { count: x.value.count * 2 },
    }),
  },
];

test("pure fixture migrations run in version order, validate and return independent data", async () => {
  const input = source(),
    validate = vi.fn(),
    expected = await documentDigest(input);
  const result = await migrateDocumentCopy(
    input,
    expected,
    3,
    [...steps].reverse(),
    validate,
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual({ schemaVersion: 3, value: { count: 8 } });
  expect(result.value).not.toBe(input);
  expect(result.value.value).not.toBe(input.value);
  expect(validate).toHaveBeenCalledOnce();
  expect(input).toEqual(source());
});

test("same-version validation returns a new copy without inventing a production version", async () => {
  const input = source(),
    result = await migrateDocumentCopy(
      input,
      await documentDigest(input),
      1,
      [],
      () => {},
    );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual(input);
    expect(result.value).not.toBe(input);
  }
});

test("migration captures source before async hashing and isolates returned binary ownership", async () => {
  const input = { ...source(), bytes: new Uint8Array([1, 2, 3]) },
    digest = await documentDigest(input);
  const pending = migrateDocumentCopy(input, digest, 1, [], () => {});
  input.value.count = 99;
  input.bytes[0] = 99;
  const result = await pending;
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.value.count).toBe(3);
    expect(result.value.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.value.bytes!.buffer).not.toBe(input.bytes.buffer);
  }
});

test("pure sequential migration validates source digest and leaves original intact on validation failure", async () => {
  const input = source(),
    digest = await documentDigest(input);
  const result = await migrateDocumentCopy(input, digest, 2, steps, () => {
    throw Error("validation failed");
  });
  expect(result.ok).toBe(false);
  expect(input).toEqual(source());
  const apply = vi.fn(steps[0].apply);
  expect(
    (
      await migrateDocumentCopy(
        input,
        "0".repeat(64),
        2,
        [{ ...steps[0], apply }],
        () => {},
      )
    ).ok,
  ).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

test.each([
  ["missing step", 3, [steps[0]]],
  [
    "jump",
    3,
    [{ from: 1, to: 3, apply: (x: Fixture) => ({ ...x, schemaVersion: 3 }) }],
  ],
  ["duplicate source version", 2, [steps[0], steps[0]]],
  [
    "wrong resulting version",
    2,
    [{ ...steps[0], apply: (x: Fixture) => ({ ...x, schemaVersion: 3 }) }],
  ],
  ["downgrade", 0, []],
  ["fractional version", 1.5, []],
] as const)(
  "rejects %s without changing original",
  async (_, target, registry) => {
    const input = source(),
      result = await migrateDocumentCopy(
        input,
        await documentDigest(input),
        target,
        registry,
        () => {},
      );
    expect(result.ok).toBe(false);
    expect(input).toEqual(source());
  },
);

test("rejects impure migration and validation callbacks including typed-array mutations", async () => {
  const input = { ...source(), bytes: new Uint8Array([1, 2]) },
    digest = await documentDigest(input);
  const mutateObject = [
    {
      ...steps[0],
      apply: (x: Fixture) => {
        x.value.count++;
        return { ...x, schemaVersion: 2 };
      },
    },
  ];
  const mutateBuffer = [
    {
      ...steps[0],
      apply: (x: Fixture) => {
        x.bytes![0]++;
        return { ...x, schemaVersion: 2 };
      },
    },
  ];
  expect(
    (await migrateDocumentCopy(input, digest, 2, mutateObject, () => {})).ok,
  ).toBe(false);
  expect(
    (await migrateDocumentCopy(input, digest, 2, mutateBuffer, () => {})).ok,
  ).toBe(false);
  expect(
    (
      await migrateDocumentCopy(input, digest, 1, [], (x: Fixture) => {
        x.bytes![0]++;
      })
    ).ok,
  ).toBe(false);
  expect(input).toEqual({ ...source(), bytes: new Uint8Array([1, 2]) });
});

test("rejects asynchronous migration steps and accessor documents without executing getters", async () => {
  const input = source();
  expect(
    (
      await migrateDocumentCopy(
        input,
        await documentDigest(input),
        2,
        [
          {
            from: 1,
            to: 2,
            apply: async (x: Fixture) => ({ ...x, schemaVersion: 2 }),
          },
        ],
        () => {},
      )
    ).ok,
  ).toBe(false);
  const getter = vi.fn(() => ({ count: 3 }));
  const unsafe = {
    schemaVersion: 1,
    get value() {
      return getter();
    },
  };
  expect(
    (await migrateDocumentCopy(unsafe, "0".repeat(64), 1, [], () => {})).ok,
  ).toBe(false);
  expect(getter).not.toHaveBeenCalled();
});

// The document budget is UTF-8 bytes, not JS string code units.
test("pure migration rejects metadata above the actual 2 MiB UTF-8 limit", async () => {
  const input = {
    schemaVersion: 1,
    value: "界".repeat(Math.floor(L.maxJsonBytes / 3) + 1),
  };
  const result = await migrateDocumentCopy(
    input,
    await documentDigest(input),
    1,
    [],
    () => {},
  );
  expect(result.ok).toBe(false);
});

test("pure migration rejects known copy/hash peaks before cloning or hashing", async () => {
  const input = { schemaVersion: 1, bytes: new Uint8Array(22 * 1024 ** 2) };
  const clone = vi.spyOn(globalThis, "structuredClone"),
    hash = vi.spyOn(crypto.subtle, "digest");
  try {
    const result = await migrateDocumentCopy(
      input,
      "0".repeat(64),
      1,
      [],
      () => {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].message).toMatch(/memory budget/);
    expect(clone).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(input.bytes.byteLength).toBe(22 * 1024 ** 2);
  } finally {
    clone.mockRestore();
    hash.mockRestore();
  }
});

test.each([1, 2, 3])(
  "shared legacy validator accepts actual v%s without issuing new identities",
  async (version) => {
    const { bytes } = originals.get(version)!,
      digest = await sha256(bytes);
    const uuid = vi.spyOn(crypto, "randomUUID");
    try {
      await expect(
        validateLegacyOriginal(
          { bytes, digest },
          `wetland-f0-v${version}`,
          io(bytes),
        ),
      ).resolves.toBeUndefined();
      expect(uuid).not.toHaveBeenCalled();
      expect(await sha256(bytes)).toBe(digest);
    } finally {
      uuid.mockRestore();
    }
  },
);

test("shared legacy validator rejects hash-correct garbage and incorrect originVersion", async () => {
  const garbage = new TextEncoder().encode(
    "not a legacy scene: forty bytes of junk!!",
  );
  await expect(
    validateLegacyOriginal(
      { bytes: garbage, digest: await sha256(garbage) },
      "wetland-f0-v1",
      io(garbage),
    ),
  ).rejects.toThrow();
  const { bytes } = originals.get(1)!,
    digest = await sha256(bytes);
  await expect(
    validateLegacyOriginal({ bytes, digest }, "wetland-f0-v2", io(bytes)),
  ).rejects.toThrow(/origin.*version/i);
  await expect(
    validateLegacyOriginal({ bytes, digest }, "wetland-f0-v4", io(bytes)),
  ).rejects.toThrow(/origin.*version/i);
});

test("shared legacy validator checks original decoder semantics after an attacker recomputes outer SHA", async () => {
  const packageData = unpackBundle(originals.get(1)!.bytes),
    manifest = JSON.parse(packageData.manifest);
  manifest.scene.instances[0].position[0] += 0.5;
  const bytes = packBundle({
      ...packageData,
      manifest: JSON.stringify(manifest),
    }),
    digest = await sha256(bytes);
  await expect(
    validateLegacyOriginal({ bytes, digest }, "wetland-f0-v1", io(bytes)),
  ).rejects.toThrow();
  expect(await sha256(bytes)).toBe(digest);
});

test("shared legacy validator checks digest, cancellation and budget before old decoder entry", async () => {
  const { bytes } = originals.get(1)!,
    digest = await sha256(bytes);
  const spy = vi.spyOn(legacyDecoder, "decodeSceneBundle");
  const aborted = new AbortController();
  aborted.abort();
  try {
    await expect(
      validateLegacyOriginal(
        { bytes, digest: "0".repeat(64) },
        "wetland-f0-v1",
        io(bytes),
      ),
    ).rejects.toThrow(/digest/i);
    await expect(
      validateLegacyOriginal(
        { bytes, digest },
        "wetland-f0-v1",
        io(bytes, aborted),
      ),
    ).rejects.toThrow();
    await expect(
      validateLegacyOriginal({ bytes, digest }, "wetland-f0-v1", {
        signal: new AbortController().signal,
        resources: { retainedBytes: L.maxTransitionBytes },
      }),
    ).rejects.toThrow(/memory budget/);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("shared legacy validation retains cancellation through the wrapper await boundary", async () => {
  const { bytes } = originals.get(1)!,
    digest = await sha256(bytes);
  const controller = new AbortController(),
    originalDecode = legacyDecoder.decodeSceneBundle;
  const spy = vi
    .spyOn(legacyDecoder, "decodeSceneBundle")
    .mockImplementation(async (...args) => {
      const decoded = await originalDecode(...args);
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return decoded;
    });
  try {
    await expect(
      validateLegacyOriginal(
        { bytes, digest },
        "wetland-f0-v1",
        io(bytes, controller),
      ),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("nested legacy candidate residency cannot bypass 128 MiB through retained accounting", async () => {
  const { bytes } = originals.get(1)!,
    digest = await sha256(bytes);
  const candidateBytes = 120 * 1024 ** 2;
  const context = {
    ...io(bytes),
    candidateBytes,
    resources: { retainedBytes: candidateBytes + bytes.byteLength },
  };
  const decoder = vi.spyOn(legacyDecoder, "decodeSceneBundle"),
    hash = vi.spyOn(crypto.subtle, "digest");
  try {
    await expect(
      validateLegacyOriginal({ bytes, digest }, "wetland-f0-v1", context),
    ).rejects.toThrow(/memory budget/);
    expect((await copyLegacyScene(bytes, context)).ok).toBe(false);
    expect(hash).not.toHaveBeenCalled();
    expect(decoder).not.toHaveBeenCalled();
  } finally {
    decoder.mockRestore();
    hash.mockRestore();
  }
});

test("legacy copy captures nested candidate residency and reports both ceilings without double counting", async () => {
  const { bytes } = originals.get(1)!,
    base = await copyLegacyScene(bytes, io(bytes));
  expect(base.ok).toBe(true);
  if (!base.ok) return;
  const candidateBytes = 16 * 1024 ** 2,
    context = {
      ...io(bytes),
      candidateBytes,
      resources: { retainedBytes: bytes.byteLength + candidateBytes },
    };
  const pending = copyLegacyScene(bytes, context);
  context.candidateBytes = 0;
  const result = await pending;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.validation.usage.candidateCpuBytes).toBe(
    base.value.validation.usage.candidateCpuBytes + candidateBytes,
  );
  expect(result.value.validation.usage.transitionBytes).toBe(
    base.value.validation.usage.transitionBytes + candidateBytes,
  );
});

test("legacy nested candidate ledger rejects invalid numeric values", async () => {
  const { bytes } = originals.get(1)!,
    digest = await sha256(bytes);
  for (const candidateBytes of [-1, NaN, Infinity, 0.5]) {
    await expect(
      validateLegacyOriginal({ bytes, digest }, "wetland-f0-v1", {
        ...io(bytes),
        candidateBytes,
      }),
    ).rejects.toThrow();
  }
});

test("legacy candidate residency must be a subset of total retained bytes before hash/decode", async () => {
  const { bytes } = originals.get(1)!,
    digest = await sha256(bytes);
  const context = { ...io(bytes), candidateBytes: bytes.byteLength + 1 };
  const hash = vi.spyOn(crypto.subtle, "digest"),
    decoder = vi.spyOn(legacyDecoder, "decodeSceneBundle");
  try {
    await expect(
      validateLegacyOriginal({ bytes, digest }, "wetland-f0-v1", context),
    ).rejects.toThrow(/candidate.*retained/i);
    const result = await copyLegacyScene(bytes, context);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues[0].message).toMatch(/candidate.*retained/i);
    expect(hash).not.toHaveBeenCalled();
    expect(decoder).not.toHaveBeenCalled();
  } finally {
    hash.mockRestore();
    decoder.mockRestore();
  }
});

test.each([1, 2, 3])(
  "display helper returns the actual verified v%s decode once",
  async (version) => {
    const module = await import("./migration");
    const { bytes, source } = originals.get(version)!;
    const spy = vi.spyOn(legacyDecoder, "decodeSceneBundle");
    try {
      const displayed = await module.readLegacySceneForDisplay(
        { bytes, digest: await sha256(bytes) },
        `wetland-f0-v${version}`,
        io(bytes),
      );
      expect(displayed).toEqual(source);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(displayed.scene.terrain.data.buffer).not.toBe(
        source.scene.terrain.data.buffer,
      );
    } finally {
      spy.mockRestore();
    }
  },
);
test("display helper rejects digest, origin and memory violations before decoding", async () => {
  const module = await import("./migration"),
    { bytes } = originals.get(1)!,
    digest = await sha256(bytes);
  const spy = vi.spyOn(legacyDecoder, "decodeSceneBundle");
  try {
    await expect(
      module.readLegacySceneForDisplay(
        { bytes, digest: "0".repeat(64) },
        "wetland-f0-v1",
        io(bytes),
      ),
    ).rejects.toThrow(/digest/);
    await expect(
      module.readLegacySceneForDisplay(
        { bytes, digest },
        "wetland-f0-v2",
        io(bytes),
      ),
    ).rejects.toThrow(/origin/);
    await expect(
      module.readLegacySceneForDisplay({ bytes, digest }, "wetland-f0-v1", {
        signal: new AbortController().signal,
        resources: { retainedBytes: L.maxTransitionBytes },
      }),
    ).rejects.toThrow(/budget/);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
test("display helper retains cancellation through decoded result handoff", async () => {
  const module = await import("./migration"),
    { bytes, source } = originals.get(1)!,
    digest = await sha256(bytes),
    abort = new AbortController();
  const spy = vi
    .spyOn(legacyDecoder, "decodeSceneBundle")
    .mockImplementation(async () => {
      abort.abort();
      return source;
    });
  try {
    await expect(
      module.readLegacySceneForDisplay(
        { bytes, digest },
        "wetland-f0-v1",
        io(bytes, abort),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    spy.mockRestore();
  }
});
