import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeSplat, orientDiagnostic } from "./splat";
import { assertGaussianBuffer } from "../gaussian/validate";
import { Quaternion, Vector3 } from "three";
function fixture() {
  const bytes = new Uint8Array(64),
    view = new DataView(bytes.buffer);
  for (let n = 0; n < 2; n++) {
    [1, n === 0 ? -2 : 2, 3, 0.01, 0.02, 0.03].forEach((v, i) =>
      view.setFloat32(n * 32 + i * 4, v, true),
    );
    bytes.set([128, 64, 255, 200, 255, 128, 128, 128], n * 32 + 24);
  }
  return bytes;
}
test("32-byte SPLAT records retain position, sigma and opacity with wxyz converted to normalized xyzw", () => {
  const b = decodeSplat(fixture());
  expect(b.count).toBe(2);
  expect([...b.data.slice(0, 3)]).toEqual([1, -2, 3]);
  expect(b.data[4]).toBeCloseTo(0.02);
  expect([...b.data.slice(6, 10)]).toEqual([0, 0, 0, 1]);
  expect(b.data[13]).toBeCloseTo(200 / 255);
  // Display-byte 128 must not be treated as linear 0.502 (which would brighten it).
  expect(b.data[10]).toBeCloseTo(0.2158605, 6);
  expect(b.data[12]).toBe(1);
  assertGaussianBuffer(b);
});
test("decoder respects byteOffset and rejects incomplete, excessive or nonfinite records", () => {
  const packed = new Uint8Array(70);
  packed.set(fixture(), 3);
  expect(decodeSplat(packed.subarray(3, 67)).count).toBe(2);
  for (const n of [0, 31, 65, 250001 * 32])
    expect(() => decodeSplat(new Uint8Array(n))).toThrow();
  const invalid = fixture();
  new DataView(invalid.buffer).setFloat32(0, NaN, true);
  expect(() => decodeSplat(invalid)).toThrow(/finite/);
  const zero = fixture();
  zero.fill(128, 28, 32);
  expect(() => decodeSplat(zero)).toThrow(/quaternion/);
});
test("negative-Y capture becomes upright without changing count, colors or covariance orientation", () => {
  const source = decodeSplat(fixture()),
    before = source.data.slice();
  const result = orientDiagnostic(source, "-y");
  expect(source.data).toEqual(before);
  expect(result.buffer.count).toBe(2);
  expect(result.scale).toBe(0.25);
  expect([...result.buffer.data.slice(0, 3)]).toEqual([0, 1, 0]);
  expect([...result.buffer.data.slice(14, 17)]).toEqual([0, 0, 0]);
  const axis = new Vector3(0, 1, 0).applyQuaternion(
    new Quaternion().fromArray(result.buffer.data, 6),
  );
  expect(axis.y).toBeCloseTo(-1);
  expect([...result.buffer.data.slice(10, 14)]).toEqual([
    ...source.data.slice(10, 14),
  ]);
});
test("positive-Y synthetic control stays upright and uses display units rather than inferred meters", () => {
  const result = orientDiagnostic(decodeSplat(fixture()), "+y");
  expect(result.buffer.data[1]).toBe(0);
  expect(result.buffer.data[15]).toBe(1);
  expect(result.buffer.data[3]).toBeCloseTo(0.0025);
});
test("pinned Houseplant data matches attribution metadata and keeps all 113648 primitives", () => {
  const bytes = readFileSync("public/diagnostics/houseplant/plant.splat");
  const meta = JSON.parse(
    readFileSync("public/diagnostics/houseplant/source-meta.json", "utf8"),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
  expect(meta.license).toBe("CC-BY-4.0");
  expect(bytes.length).toBe(3636736);
  const b = decodeSplat(bytes);
  expect(b.count).toBe(113648);
  assertGaussianBuffer(orientDiagnostic(b, "-y").buffer);
});
