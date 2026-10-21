import { expect, test } from "vitest";
import { utils } from "@sparkjsdev/spark";
import { decodeExtRgb, decodeExtSplat, fromHalf } from "./ext-decode";

// Deterministic words, including every half-float exponent class.
function words(n: number, seed: number) {
  let x = seed >>> 0;
  return Uint32Array.from({ length: n }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  });
}
const same = (a: number, b: number) =>
  Number.isNaN(a) ? Number.isNaN(b) : Object.is(a, b);

test("fromHalf matches Spark for all 65536 half values", () => {
  const extA = new Uint32Array(4),
    extB = new Uint32Array(4);
  for (let h = 0; h < 65536; h++) {
    extA[3] = h;
    const spark = utils.decodeExtSplat([extA, extB], 0).opacity;
    expect(same(fromHalf(h), spark)).toBe(true);
  }
});

test("decodeExtSplat matches Spark field for field", () => {
  const count = 4096,
    extA = words(count * 4, 1),
    extB = words(count * 4, 2);
  // Real centers are finite floats; keep a few NaN/inf patterns too.
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const f = new Float32Array([((extA[i * 4 + k] % 2001) - 1000) / 37]);
      if (i % 97) extA[i * 4 + k] = new Uint32Array(f.buffer)[0];
    }
  }
  for (let i = 0; i < count; i++) {
    const mine = decodeExtSplat([extA, extB], i),
      spark = utils.decodeExtSplat([extA, extB], i);
    const expected = [
      ...spark.center.toArray(),
      ...spark.scales.toArray(),
      ...spark.quaternion.toArray(),
      spark.color.r,
      spark.color.g,
      spark.color.b,
      spark.opacity,
    ];
    const actual = [
      ...mine.center,
      ...mine.scales,
      ...mine.quaternion,
      ...mine.color,
      mine.opacity,
    ];
    actual.forEach((v, k) => expect(same(v, expected[k])).toBe(true));
  }
});

test("decodeExtRgb matches Spark", () => {
  for (const encoded of words(20000, 3)) {
    const c = utils.decodeExtRgb(encoded),
      [r, g, b] = decodeExtRgb(encoded);
    expect([same(r, c.r), same(g, c.g), same(b, c.b)]).toEqual([
      true,
      true,
      true,
    ]);
  }
});
