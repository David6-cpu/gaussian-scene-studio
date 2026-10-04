// Compatible with Spark 2.3.1 decodeExtRgb. This changes only SH encoding,
// not its 8-bit magnitudes / shared exponent format, geometry or renderer.
export function encodeRangeSafeRgb(r: number, g: number, b: number): number {
  const max = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
  if (![r, g, b].every(Number.isFinite) || max > 65536)
    throw new Error("SH coefficient is nonfinite or exceeds the Ext RGB range");
  const exponent = Math.max(0, Math.min(31, Math.ceil(Math.log2(max)) + 15));
  const step = 2 ** (exponent - 15) / 255;
  const magnitude = (v: number) => Math.round(Math.abs(v) / step);
  const signs = (r < 0 ? 1 : 0) | (g < 0 ? 2 : 0) | (b < 0 ? 4 : 0);
  return (
    (magnitude(r) |
      (magnitude(g) << 8) |
      (magnitude(b) << 16) |
      (((exponent << 3) | signs) << 24)) >>>
    0
  );
}
