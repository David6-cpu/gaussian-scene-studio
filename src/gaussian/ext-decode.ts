// Worker-safe copies of Spark 2.3.1's `utils.decodeExtSplat` and
// `utils.decodeExtRgb` (MIT, World Labs Technologies). Importing them from
// "@sparkjsdev/spark" pulls the whole renderer into every build worker, which
// only needs to validate packed data. ext-decode.test.ts checks these against
// Spark's own functions; revalidate when upgrading Spark.

export type DecodedExtSplat = {
  center: [number, number, number];
  scales: [number, number, number];
  quaternion: [number, number, number, number];
  color: [number, number, number];
  opacity: number;
};

const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
function uintBitsToFloat(u: number) {
  u32[0] = u;
  return f32[0];
}
/** Exact IEEE half → number, matching Spark's native and JS paths. */
export function fromHalf(h: number) {
  const sign = h & 0x8000 ? -1 : 1,
    exp = (h >> 10) & 31,
    frac = h & 1023;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}
function decodeQuatOctXy1010R12(
  encoded: number,
): [number, number, number, number] {
  const u = (encoded & 1023) / 1023,
    v = ((encoded >>> 10) & 1023) / 1023,
    angle = (encoded >>> 20) & 4095;
  let x = (u - 0.5) * 2,
    y = (v - 0.5) * 2;
  const z = 1 - (Math.abs(x) + Math.abs(y)),
    t = Math.max(-z, 0);
  x += x >= 0 ? -t : t;
  y += y >= 0 ? -t : t;
  const len = Math.sqrt(x * x + y * y + z * z),
    ax = len < 1e-6 ? 0 : x / len,
    ay = len < 1e-6 ? 0 : y / len,
    az = len < 1e-6 ? 0 : z / len,
    half = (angle / 4095) * Math.PI * 0.5,
    s = Math.sin(half);
  return [ax * s, ay * s, az * s, Math.cos(half)];
}
export function decodeExtSplat(
  [extA, extB]: readonly [Uint32Array, Uint32Array],
  index: number,
): DecodedExtSplat {
  const i = index * 4;
  return {
    center: [
      uintBitsToFloat(extA[i]),
      uintBitsToFloat(extA[i + 1]),
      uintBitsToFloat(extA[i + 2]),
    ],
    opacity: fromHalf(extA[i + 3] & 0xffff),
    color: [
      fromHalf(extB[i] & 0xffff),
      fromHalf(extB[i] >>> 16),
      fromHalf(extB[i + 1] & 0xffff),
    ],
    scales: [
      Math.exp(fromHalf(extB[i + 1] >>> 16)),
      Math.exp(fromHalf(extB[i + 2] & 0xffff)),
      Math.exp(fromHalf(extB[i + 2] >>> 16)),
    ],
    quaternion: decodeQuatOctXy1010R12(extB[i + 3]),
  };
}
export function decodeExtRgb(encoded: number): [number, number, number] {
  const divisor = 2 ** (((encoded >>> 27) & 31) - 15) / 255,
    r = (encoded & 255) * divisor,
    g = ((encoded >>> 8) & 255) * divisor,
    b = ((encoded >>> 16) & 255) * divisor;
  return [
    encoded & 0x1000000 ? -r : r,
    encoded & 0x2000000 ? -g : g,
    encoded & 0x4000000 ? -b : b,
  ];
}
/** The validation both prepared-ground and asset loading apply per splat. */
export function isValidExtSplat(s: DecodedExtSplat) {
  const q = s.quaternion;
  return (
    [...s.center, ...s.scales, ...q, ...s.color, s.opacity].every(
      Number.isFinite,
    ) &&
    s.scales.every((x) => x > 0) &&
    Math.abs(Math.hypot(...q) - 1) <= 0.01 &&
    s.opacity >= 0 &&
    s.opacity <= 1
  );
}
