// Byte accounting for splat sources. Kept free of Spark imports so the build
// worker (compile.ts) can budget sources without bundling the renderer.
import { SH3_KEYS } from "../../io/sh3-variant";
import type { SplatSource } from "../asset-loader";
import { GENERAL_LIMITS } from "../core";
export const arraysOf = (s: SplatSource) =>
  s.kind === "float14" ? [s.data] : SH3_KEYS.map((k) => s.arrays[k]);
export function sourceBytes(s: SplatSource): number {
  if (
    !Number.isInteger(s.count) ||
    s.count < 1 ||
    s.count > GENERAL_LIMITS.maxWorstSplats
  )
    throw Error("Invalid source count");
  if (s.kind === "float14") {
    if (!(s.data instanceof Float32Array) || s.data.length !== s.count * 14)
      throw Error("Invalid float14 array");
  } else if (s.kind === "ext-sh3") {
    if (
      s.capacity !== Math.ceil(s.count / 2048) * 2048 ||
      SH3_KEYS.some(
        (k) =>
          !(s.arrays[k] instanceof Uint32Array) ||
          s.arrays[k].length !== s.capacity * 4,
      )
    )
      throw Error("Invalid SH3 capacity or array");
  } else throw Error("Unsupported source kind");
  const bytes = arraysOf(s).reduce((n, a) => n + a.byteLength, 0);
  if (bytes > GENERAL_LIMITS.maxCandidateCpuBytes)
    throw Error("Source CPU budget exceeded");
  return bytes;
}
/** CPU snapshot + Spark CPU storage + estimated GPU textures. Renderer sort overhead is budgeted separately. */
export function sourceOwnedBytes(s: SplatSource) {
  const bytes = sourceBytes(s);
  return s.kind === "float14"
    ? bytes + Math.ceil(s.count / 2048) * 2048 * 16 * 2
    : bytes * 2;
}
