import { afterEach, describe, expect, it, vi } from "vitest";
import { Inflate, zipSync } from "fflate";
import { constants, deflateRawSync } from "node:zlib";
import { GENERAL_LIMITS } from "./core.ts";
import {
  readBoundedZip,
  readBoundedZipManifest,
  writeBoundedZip,
  type ZipPolicy,
} from "./bounded-zip.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const files = () =>
  new Map([
    ["manifest.json", encode('{"fixture":"constructed"}')],
    ["license.txt", encode("constructed test fixture")],
    ["stone-full.f32", new Uint8Array([1, 2, 3, 4])],
  ]);
const policy: ZipPolicy = { allowedNames: [...files().keys()] };
const archive = (
  entries: Map<string, Uint8Array> = files(),
  level: 0 | 6 = 0,
) => zipSync(Object.fromEntries(entries), { level });
const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function records(bytes: Uint8Array) {
  const v = view(bytes);
  const end = bytes.length - 22;
  const result: {
    central: number;
    local: number;
    data: number;
    packed: number;
    name: string;
  }[] = [];
  let cursor = v.getUint32(end + 16, true);
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    const local = v.getUint32(cursor + 42, true);
    const n = v.getUint16(cursor + 28, true);
    result.push({
      central: cursor,
      local,
      data:
        local +
        30 +
        v.getUint16(local + 26, true) +
        v.getUint16(local + 28, true),
      packed: v.getUint32(cursor + 20, true),
      name: new TextDecoder().decode(
        bytes.subarray(cursor + 46, cursor + 46 + n),
      ),
    });
    cursor +=
      46 + n + v.getUint16(cursor + 30, true) + v.getUint16(cursor + 32, true);
  }
  return result;
}
function declared(bytes: Uint8Array, name: string, length: number) {
  const r = records(bytes).find((entry) => entry.name === name)!;
  view(bytes).setUint32(r.local + 22, length, true);
  view(bytes).setUint32(r.central + 24, length, true);
}
function entryFlags(bytes: Uint8Array, flags: number) {
  const r = records(bytes)[0];
  view(bytes).setUint16(r.local + 6, flags, true);
  view(bytes).setUint16(r.central + 8, flags, true);
}
function largeFixture(size: number) {
  return new Map([
    ["manifest.json", encode('{"fixture":"constructed"}')],
    ["stone-full.f32", new Uint8Array(size)],
    ["later.f32", new Uint8Array(1024)],
  ]);
}

afterEach(() => vi.restoreAllMocks());

describe("bounded ZIP32", () => {
  it.each([0, 6] as const)(
    "reads stored/deflate ZIP at level %i and owns returned bytes",
    (level) => {
      const bytes = archive(files(), level);
      const result = readBoundedZip(bytes, policy);
      expect(result).toEqual(files());
      result.get("stone-full.f32")![0] = 99;
      expect(readBoundedZip(bytes, policy)).toEqual(files());
    },
  );

  it("accepts a byte-offset input view and the UTF8 name flag", () => {
    const bytes = archive();
    entryFlags(bytes, 0x800);
    const padded = new Uint8Array(bytes.length + 7);
    padded.set(bytes, 3);
    expect(
      readBoundedZip(padded.subarray(3, 3 + bytes.length), policy),
    ).toEqual(files());
  });

  it("writes deterministic stored ZIP32 that round-trips and owns its output", () => {
    const entries = files();
    const bytes = writeBoundedZip(entries, policy);
    expect(writeBoundedZip(new Map([...entries].reverse()), policy)).toEqual(
      bytes,
    );
    expect(readBoundedZip(bytes, policy)).toEqual(entries);
    entries.get("stone-full.f32")![0] = 99;
    expect(readBoundedZip(bytes, policy)).toEqual(files());
    expect(
      records(bytes).every(
        (r) => view(bytes).getUint16(r.central + 10, true) === 0,
      ),
    ).toBe(true);
  });

  it("derives only the manifest before an exact member allowlist is available", () => {
    const bytes = archive(largeFixture(8192), 6);
    const pushes = vi.spyOn(Inflate.prototype, "push");
    expect(readBoundedZipManifest(bytes)).toEqual(
      largeFixture(8192).get("manifest.json"),
    );
    const first = records(bytes)[0];
    expect(
      pushes.mock.calls.reduce((sum, [data]) => sum + data.length, 0),
    ).toBe(first.packed);
    expect(() =>
      readBoundedZip(bytes, { allowedNames: ["manifest.json"] }),
    ).toThrow(/undeclared|allowed/i);
  });

  it("requires a manifest for manifest-only discovery", () => {
    expect(() =>
      readBoundedZipManifest(
        archive(new Map([["stone-full.f32", new Uint8Array(1)]])),
      ),
    ).toThrow(/manifest/i);
  });

  it.each([
    "../stone.f32",
    "dir/stone.f32",
    "/stone.f32",
    "C:stone.f32",
    "stone\\full.f32",
    "STONE.f32",
    "stone.exe",
    "stone..f32",
    "-stone.f32",
    "stone.txt",
    "a".repeat(81) + ".f32",
  ])("rejects invalid flat member name %s on read and write", (name) => {
    const entries = new Map([[name, new Uint8Array(1)]]);
    expect(() =>
      readBoundedZip(archive(entries), { allowedNames: [name] }),
    ).toThrow(/name/i);
    expect(() => writeBoundedZip(entries, { allowedNames: [name] })).toThrow(
      /name/i,
    );
  });

  it("rejects duplicate archive members before inflation", () => {
    const bytes = archive(
      new Map([
        ["stone.f32", new Uint8Array(1)],
        ["grass.f32", new Uint8Array(1)],
      ]),
    );
    const duplicate = records(bytes)[1];
    bytes.set(encode("stone.f32"), duplicate.local + 30);
    bytes.set(encode("stone.f32"), duplicate.central + 46);
    const pushes = vi.spyOn(Inflate.prototype, "push");
    expect(() =>
      readBoundedZip(bytes, { allowedNames: ["stone.f32", "grass.f32"] }),
    ).toThrow(/duplicate/i);
    expect(pushes).not.toHaveBeenCalled();
  });

  it("rejects undeclared members on read and write", () => {
    expect(() =>
      readBoundedZip(archive(), { allowedNames: ["manifest.json"] }),
    ).toThrow(/undeclared|allowed/i);
    expect(() =>
      writeBoundedZip(files(), { allowedNames: ["manifest.json"] }),
    ).toThrow(/undeclared|allowed/i);
  });

  it("rejects 129 archive members even when the caller asks for a higher ceiling", () => {
    const entries = new Map(
      Array.from({ length: 129 }, (_, i) => [
        `asset-${i}.f32`,
        new Uint8Array(0),
      ]),
    );
    const widened = { allowedNames: [...entries.keys()], maxFiles: 1000 };
    expect(() => readBoundedZip(archive(entries), widened)).toThrow(
      /files|count/i,
    );
    expect(() => writeBoundedZip(entries, widened)).toThrow(/files|count/i);
    expect(() => readBoundedZipManifest(archive(entries))).toThrow(
      /files|count/i,
    );
  });

  it.each(["manifest.json", "proxy.json"])(
    "enforces the frozen JSON ceiling for %s",
    (name) => {
      const entries = new Map([
        [name, new Uint8Array(GENERAL_LIMITS.maxJsonBytes + 1)],
      ]);
      const widened = {
        allowedNames: [name],
        maxJsonBytes: Number.MAX_SAFE_INTEGER,
      };
      expect(() => readBoundedZip(archive(entries, 6), widened)).toThrow(
        /JSON|json/i,
      );
      expect(() => writeBoundedZip(entries, widened)).toThrow(/JSON|json/i);
    },
  );

  it("rejects compressed input over 64 MiB before scanning records", () => {
    const bytes = new Uint8Array(GENERAL_LIMITS.maxCompressedPackageBytes + 1);
    expect(() =>
      readBoundedZip(bytes, {
        ...policy,
        maxCompressedBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/compressed/i);
  });

  it("rejects declared expansion over 128 MiB before allocating or inflating", () => {
    const bytes = archive(files(), 6);
    declared(
      bytes,
      "stone-full.f32",
      GENERAL_LIMITS.maxExpandedPackageBytes + 1,
    );
    const pushes = vi.spyOn(Inflate.prototype, "push");
    expect(() =>
      readBoundedZip(bytes, {
        ...policy,
        maxExpandedBytes: Number.MAX_SAFE_INTEGER,
        maxMemberBytes: Number.MAX_SAFE_INTEGER,
        maxPeakBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/expanded|member/i);
    expect(pushes).not.toHaveBeenCalled();
  });

  it.each([
    { maxCompressedBytes: 16 },
    { maxExpandedBytes: 16 },
    { maxMemberBytes: 1 },
    { maxJsonBytes: 1 },
    { maxFiles: 1 },
    { maxPeakBytes: 1 },
  ])("allows a caller to lower limits: %j", (limit) => {
    expect(() => readBoundedZip(archive(), { ...policy, ...limit })).toThrow();
    expect(() => writeBoundedZip(files(), { ...policy, ...limit })).toThrow();
  });

  it.each([NaN, Infinity, -1, 0.5])(
    "rejects invalid policy limits %s",
    (maxExpandedBytes) => {
      expect(() =>
        readBoundedZip(archive(), { ...policy, maxExpandedBytes }),
      ).toThrow(/policy|limit/i);
    },
  );

  it("accounts for compressed input, retained output and inflater scratch before decode", () => {
    const bytes = archive(files(), 6);
    const expanded = [...files().values()].reduce(
      (total, data) => total + data.length,
      0,
    );
    const pushes = vi.spyOn(Inflate.prototype, "push");
    expect(() =>
      readBoundedZip(bytes, {
        ...policy,
        maxPeakBytes: bytes.length + expanded,
      }),
    ).toThrow(/peak/i);
    expect(pushes).not.toHaveBeenCalled();
  });

  it.each([1, 8193])(
    "rejects a declared/actual deflate size mismatch (%i declared)",
    (size) => {
      const entries = largeFixture(8192);
      const bytes = archive(entries, 6);
      declared(bytes, "stone-full.f32", size);
      expect(() =>
        readBoundedZip(bytes, { allowedNames: [...entries.keys()] }),
      ).toThrow(/actual|declared|length|size/i);
    },
  );

  it("stops feeding compressed data on the first excessive output chunk and never starts later members", () => {
    const entries = new Map([
      ["stone-full.f32", new Uint8Array(1024 * 1024)],
      ["later.f32", new Uint8Array(1024)],
    ]);
    const bytes = archive(entries, 6);
    declared(bytes, "stone-full.f32", 8);
    const original = Inflate.prototype.push;
    let failed = false;
    let largestInput = 0;
    let pushesAfterFailure = 0;
    const instances = new Set<Inflate>();
    const push = vi
      .spyOn(Inflate.prototype, "push")
      .mockImplementation(function (this: Inflate, chunk, final) {
        if (failed) pushesAfterFailure++;
        instances.add(this);
        largestInput = Math.max(largestInput, chunk.length);
        try {
          original.call(this, chunk, final);
        } catch (error) {
          failed = true;
          throw error;
        }
      });
    expect(() =>
      readBoundedZip(bytes, {
        allowedNames: [...entries.keys()],
        maxExpandedBytes: 8192,
      }),
    ).toThrow(/actual|declared|length|size/i);
    expect(failed).toBe(true);
    expect(pushesAfterFailure).toBe(0);
    expect(instances.size).toBe(1);
    expect(largestInput).toBeLessThanOrEqual(16);
    expect(
      push.mock.calls.reduce((sum, [chunk]) => sum + chunk.length, 0),
    ).toBeLessThan(records(bytes)[0].packed);
  });

  it("checks CRC32 against actual stored and deflated content", () => {
    for (const level of [0, 6] as const) {
      const bytes = archive(files(), level);
      const r = records(bytes)[0];
      const incorrect = view(bytes).getUint32(r.local + 14, true) ^ 0x12345678;
      view(bytes).setUint32(r.local + 14, incorrect, true);
      view(bytes).setUint32(r.central + 16, incorrect, true);
      expect(() => readBoundedZip(bytes, policy)).toThrow(/CRC/i);
      expect(() => readBoundedZipManifest(bytes)).toThrow(/CRC/i);
    }
  });

  it("rejects malformed deflate instead of exposing partial data", () => {
    const bytes = archive(files(), 6);
    bytes[records(bytes)[0].data] = 7; // Reserved block type.
    expect(() => readBoundedZip(bytes, policy)).toThrow();
  });

  it.each([0x1, 0x8, 0x20, 0x40, 0x2000])(
    "rejects encryption, descriptors, and unsupported flags %i",
    (flag) => {
      const bytes = archive();
      entryFlags(bytes, flag);
      expect(() => readBoundedZip(bytes, policy)).toThrow(/flag|encrypt/i);
    },
  );

  it("rejects symlink/directory attributes and unsupported compression", () => {
    for (const attributes of [0xa0000000, 0x40000000, 0x10]) {
      const bytes = archive();
      view(bytes).setUint32(records(bytes)[0].central + 38, attributes, true);
      expect(() => readBoundedZip(bytes, policy)).toThrow(
        /regular|attribute|link/i,
      );
    }
    const bytes = archive();
    const r = records(bytes)[0];
    view(bytes).setUint16(r.local + 8, 12, true);
    view(bytes).setUint16(r.central + 10, 12, true);
    expect(() => readBoundedZip(bytes, policy)).toThrow(/method|compression/i);
  });

  it.each(["packed", "unpacked", "offset", "count"])(
    "rejects ZIP64 sentinel in %s",
    (field) => {
      const bytes = archive();
      const r = records(bytes)[0];
      if (field === "count")
        view(bytes).setUint16(bytes.length - 12, 0xffff, true);
      else
        view(bytes).setUint32(
          r.central +
            ({ packed: 20, unpacked: 24, offset: 42 } as const)[
              field as "packed" | "unpacked" | "offset"
            ],
          0xffffffff,
          true,
        );
      expect(() => readBoundedZip(bytes, policy)).toThrow();
    },
  );

  it("rejects ZIP64 extra records", () => {
    const bytes = zipSync(
      { "manifest.json": [encode("{}"), { extra: { 1: new Uint8Array(8) } }] },
      { level: 0 },
    );
    expect(() =>
      readBoundedZip(bytes, { allowedNames: ["manifest.json"] }),
    ).toThrow(/ZIP64/i);
  });

  it.each(["crc", "packed", "name", "method", "flags"])(
    "rejects local/central mismatch: %s",
    (field) => {
      const bytes = archive();
      const r = records(bytes)[0];
      if (field === "name") bytes[r.local + 30] = 120;
      else if (field === "method" || field === "flags")
        view(bytes).setUint16(r.local + (field === "method" ? 8 : 6), 1, true);
      else
        view(bytes).setUint32(r.local + (field === "crc" ? 14 : 18), 1, true);
      expect(() => readBoundedZip(bytes, policy)).toThrow();
    },
  );

  it("rejects undeclared local records, overlaps and gaps", () => {
    const bytes = archive();
    const rs = records(bytes);
    // Hide one physical member by removing its central record and adjusting EOCD.
    const last = rs[rs.length - 1];
    const removedLength = bytes.length - 22 - last.central;
    const hidden = new Uint8Array(bytes.length - removedLength);
    hidden.set(bytes.subarray(0, last.central));
    hidden.set(bytes.subarray(bytes.length - 22), last.central);
    const e = hidden.length - 22;
    view(hidden).setUint16(e + 8, rs.length - 1, true);
    view(hidden).setUint16(e + 10, rs.length - 1, true);
    view(hidden).setUint32(
      e + 12,
      view(hidden).getUint32(e + 12, true) - removedLength,
      true,
    );
    expect(() => readBoundedZip(hidden, policy)).toThrow(
      /range|local|hidden|gap/i,
    );
    const overlap = archive();
    view(overlap).setUint32(records(overlap)[1].central + 42, 0, true);
    expect(() => readBoundedZip(overlap, policy)).toThrow();
  });

  it("rejects split disks, malformed EOCD and truncated buffers", () => {
    const bytes = archive();
    const split = bytes.slice();
    view(split).setUint16(split.length - 18, 1, true);
    expect(() => readBoundedZip(split, policy)).toThrow();
    for (const cut of [0, 1, 21, 22, bytes.length - 1]) {
      expect(() => readBoundedZip(bytes.subarray(0, cut), policy)).toThrow();
    }
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => readBoundedZip(trailing, policy)).toThrow();
  });
});

// Substitute raw deflate bytes while preserving a fixture's correct CRC/size.
function rawDeflateFixture(payload: Uint8Array, expected: Uint8Array) {
  const original = archive(new Map([["stone.bin", expected]]));
  const r = records(original)[0];
  const delta = payload.length - r.packed;
  const result = new Uint8Array(original.length + delta);
  result.set(original.subarray(0, r.data));
  result.set(payload, r.data);
  result.set(original.subarray(r.data + r.packed), r.data + payload.length);
  const v = view(result);
  v.setUint16(r.local + 8, 8, true);
  v.setUint32(r.local + 18, payload.length, true);
  v.setUint16(r.central + delta + 10, 8, true);
  v.setUint32(r.central + delta + 20, payload.length, true);
  v.setUint32(result.length - 6, r.central + delta, true);
  return result;
}

describe("strict deflate framing beyond fflate's validation", () => {
  const policy = { allowedNames: ["stone.bin"] };
  it.each([
    constants.Z_DEFAULT_STRATEGY,
    constants.Z_FILTERED,
    constants.Z_HUFFMAN_ONLY,
    constants.Z_RLE,
    constants.Z_FIXED,
  ])(
    "accepts independently encoded zlib streams with strategy %i",
    (strategy) => {
      const expected = Uint8Array.from({ length: 4096 }, (_, i) =>
        i % 131 < 95 ? 65 + (i % 3) : (i * 17) & 255,
      );
      const payload = deflateRawSync(expected, { strategy });
      expect(
        readBoundedZip(rawDeflateFixture(payload, expected), policy).get(
          "stone.bin",
        ),
      ).toEqual(expected);
    },
  );

  it("rejects an early final block plus trailing data before feeding the inflater", () => {
    const payload = new Uint8Array(16384);
    payload[0] = 3;
    const pushes = vi.spyOn(Inflate.prototype, "push");
    expect(() =>
      readBoundedZip(rawDeflateFixture(payload, new Uint8Array(0)), policy),
    ).toThrow(/trailing/i);
    expect(pushes).not.toHaveBeenCalled();
  });

  it("accepts a valid empty stream and rejects trailing bytes after its final block", () => {
    expect(
      readBoundedZip(
        rawDeflateFixture(new Uint8Array([3, 0]), new Uint8Array(0)),
        policy,
      ).get("stone.bin"),
    ).toEqual(new Uint8Array(0));
    expect(() =>
      readBoundedZip(
        rawDeflateFixture(new Uint8Array([3, 0, 0]), new Uint8Array(0)),
        policy,
      ),
    ).toThrow(/trailing/i);
  });

  it("validates a stored deflate block's LEN/NLEN complement", () => {
    const valid = new Uint8Array([1, 1, 0, 254, 255, 65]);
    expect(
      readBoundedZip(rawDeflateFixture(valid, encode("A")), policy).get(
        "stone.bin",
      ),
    ).toEqual(encode("A"));
    valid[3] = 0;
    valid[4] = 0;
    expect(() =>
      readBoundedZip(rawDeflateFixture(valid, encode("A")), policy),
    ).toThrow(/complement/i);
  });

  it.each([new Uint8Array([2, 0]), new Uint8Array([115, 4])])(
    "rejects missing final blocks and truncated end symbols",
    (payload) => {
      expect(() =>
        readBoundedZip(
          rawDeflateFixture(
            payload,
            payload[0] === 2 ? new Uint8Array(0) : encode("A"),
          ),
          policy,
        ),
      ).toThrow();
    },
  );

  it("reads incompressible stored deflate blocks larger than the inflater history", () => {
    const data = new Uint8Array(131072);
    let state = 12345;
    for (let i = 0; i < data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      data[i] = state >>> 24;
    }
    const input = new Map([["stone.bin", data]]);
    expect(readBoundedZip(archive(input, 6), policy)).toEqual(input);
  });
});
