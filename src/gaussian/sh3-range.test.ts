import { expect, test } from "vitest";
import { utils } from "@sparkjsdev/spark";
import { encodeRangeSafeRgb } from "./sh3-range";

test("representable signed SH coefficients stay within half a quantization step", () => {
  const rgb = [0.75, -0.3, 0.125] as const;
  const decoded = utils.decodeExtRgb(encodeRangeSafeRgb(...rgb)).toArray();
  for (let c = 0; c < 3; c++)
    expect(Math.abs(decoded[c] - rgb[c])).toBeLessThanOrEqual(1 / 510 + 1e-12);
});

test("zero, signs, exponent boundaries and the full supported range round-trip", () => {
  for (const value of [
    0,
    2 ** -24,
    2 ** -15,
    0.49999997,
    0.5,
    0.50000006,
    0.96504134,
    1,
    1.00000012,
    65536,
  ]) {
    const rgb = [value, -value * 0.43, value * 0.017] as const;
    const word = encodeRangeSafeRgb(...rgb);
    const step = 2 ** ((word >>> 27) - 15) / 255;
    const decoded = utils.decodeExtRgb(word).toArray();
    for (let c = 0; c < 3; c++)
      expect(Math.abs(decoded[c] - rgb[c])).toBeLessThanOrEqual(
        step / 2 + 1e-11,
      );
  }
});

test("unrepresentable or invalid coefficients fail instead of silently saturating", () => {
  for (const value of [65537, -65537, NaN, Infinity, -Infinity])
    expect(() => encodeRangeSafeRgb(0, value, 0)).toThrow(/SH coefficient/);
});
