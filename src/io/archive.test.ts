import { expect, test } from "vitest";
import { zipSync } from "fflate";
import { unpackBundle } from "./archive";

const bytes = (s: string) => new TextEncoder().encode(s);
function zip(files: Record<string, Uint8Array> = {}) {
  return zipSync({ "manifest.json": bytes("{}"), ...files }, { level: 0 });
}
function directory(z: Uint8Array) {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  return v.getUint32(z.length - 22 + 16, true);
}
test("stored scene archive preserves bytes", () => {
  expect(
    unpackBundle(zip({ "x.u32": bytes("abc") })).files.get("x.u32"),
  ).toEqual(bytes("abc"));
});
test.each([
  [
    "local size disagrees",
    (z: Uint8Array, v: DataView) => v.setUint32(18, 100, true),
  ],
  [
    "local filename differs",
    (z: Uint8Array) => {
      z[30] = 120;
    },
  ],
  [
    "encrypted member",
    (z: Uint8Array, v: DataView) => {
      v.setUint16(6, 1, true);
      v.setUint16(directory(z) + 8, 1, true);
    },
  ],
  [
    "central offset points outside",
    (z: Uint8Array, v: DataView) =>
      v.setUint32(directory(z) + 42, 0xfffffff0, true),
  ],
  [
    "multi disk",
    (z: Uint8Array, v: DataView) => v.setUint16(z.length - 22 + 4, 1, true),
  ],
  [
    "central count low",
    (z: Uint8Array, v: DataView) => v.setUint16(z.length - 22 + 10, 0, true),
  ],
  [
    "central uncompressed budget lie",
    (z: Uint8Array, v: DataView) =>
      v.setUint32(directory(z) + 24, 64 * 1024 ** 2 + 1, true),
  ],
])("rejects %s before decoding", (_, mutate) => {
  const z = zip();
  mutate(z, new DataView(z.buffer));
  expect(() => unpackBundle(z)).toThrow();
});
test.each(["../x.u32", "/x.u32", "sub/x.u32", "x\\y.u32"])(
  "rejects path %s",
  (name) => {
    expect(() => unpackBundle(zip({ [name]: bytes("x") }))).toThrow();
  },
);
test("rejects excessive member count, manifest and truncation", () => {
  const files = Object.fromEntries(
    Array.from({ length: 14 }, (_, i) => [`x${i}.u32`, bytes("x")]),
  );
  expect(() => unpackBundle(zip(files))).toThrow();
  expect(() =>
    unpackBundle(
      zipSync({ "manifest.json": new Uint8Array(1048577) }, { level: 0 }),
    ),
  ).toThrow();
  expect(() => unpackBundle(zip().subarray(0, 35))).toThrow();
  expect(() =>
    unpackBundle(zipSync({ "manifest.json": bytes("{}") }, { level: 6 })),
  ).toThrow();
});
test("rejects duplicate and overlapping local records", () => {
  const z = zip({ "x.u32": bytes("abc") }),
    v = new DataView(z.buffer),
    c = directory(z);
  const second =
    c +
    46 +
    v.getUint16(c + 28, true) +
    v.getUint16(c + 30, true) +
    v.getUint16(c + 32, true);
  v.setUint32(second + 42, 0, true);
  expect(() => unpackBundle(z)).toThrow();
});
