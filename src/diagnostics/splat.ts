import type { GaussianBuffer } from "../gaussian/types";
import { Color, Quaternion, Vector3 } from "three";
import { assertGaussianBuffer } from "../gaussian/validate";
/** Antimatter15 .splat: LE float32 xyz/sigma, uint8 RGBA, uint8 wxyz. */
export function decodeSplat(bytes: Uint8Array): GaussianBuffer {
  if (
    !bytes.byteLength ||
    bytes.byteLength % 32 ||
    bytes.byteLength / 32 > 250000
  )
    throw new Error("Invalid SPLAT record length or Gaussian budget");
  const count = bytes.byteLength / 32,
    data = new Float32Array(count * 14);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const q = new Quaternion(),
    color = new Color();
  for (let i = 0; i < count; i++) {
    const from = i * 32,
      to = i * 14;
    for (let k = 0; k < 6; k++)
      data[to + k] = view.getFloat32(from + k * 4, true);
    q.set(
      (bytes[from + 29] - 128) / 128,
      (bytes[from + 30] - 128) / 128,
      (bytes[from + 31] - 128) / 128,
      (bytes[from + 28] - 128) / 128,
    );
    if (q.lengthSq() < 1e-8) throw new Error("Invalid SPLAT quaternion");
    q.normalize().toArray(data, to + 6);
    // Existing GaussianView accepts linear RGB and encodes it for Spark once.
    color
      .setRGB(
        bytes[from + 24] / 255,
        bytes[from + 25] / 255,
        bytes[from + 26] / 255,
      )
      .convertSRGBToLinear()
      .toArray(data, to + 10);
    data[to + 13] = bytes[from + 27] / 255;
  }
  const buffer = { count, data };
  assertGaussianBuffer(buffer);
  return buffer;
}
/** Display-only similarity transform: upright, centered, center-height range 1. */
export function orientDiagnostic(buffer: GaussianBuffer, up: "-y" | "+y") {
  assertGaussianBuffer(buffer);
  const flip = up === "-y" ? -1 : 1,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < buffer.count; i++)
    for (let k = 0; k < 3; k++) {
      const value = buffer.data[i * 14 + k] * (k === 0 ? 1 : flip);
      min[k] = Math.min(min[k], value);
      max[k] = Math.max(max[k], value);
    }
  const height = max[1] - min[1];
  if (!Number.isFinite(height) || height <= 1e-8)
    throw new Error("Diagnostic asset has no height extent");
  const scale = 1 / height,
    center: [number, number, number] = [
      (min[0] + max[0]) / 2,
      min[1],
      (min[2] + max[2]) / 2,
    ];
  const data = buffer.data.slice(),
    q = new Quaternion(),
    rotation = new Quaternion(up === "-y" ? 1 : 0, 0, 0, up === "-y" ? 0 : 1);
  for (let i = 0; i < buffer.count; i++) {
    const off = i * 14;
    for (let k = 0; k < 3; k++) {
      data[off + k] =
        (data[off + k] * (k === 0 ? 1 : flip) - center[k]) * scale;
      data[off + 3 + k] *= scale;
    }
    q.fromArray(data, off + 6)
      .premultiply(rotation)
      .normalize()
      .toArray(data, off + 6);
  }
  return { buffer: { count: buffer.count, data }, scale, center };
}

/** Display-only rigid rotation and uniform footprint scale; never flatten relief. */
export function orientGround(
  buffer: GaussianBuffer,
  rotation: [number, number, number, number],
) {
  assertGaussianBuffer(buffer);
  if (
    rotation.some((x) => !Number.isFinite(x)) ||
    Math.abs(Math.hypot(...rotation) - 1) > 1e-4
  )
    throw new Error("Invalid ground rotation");
  const r = new Quaternion(...rotation),
    p = new Vector3(),
    q = new Quaternion();
  const data = buffer.data.slice(),
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.length; i += 14) {
    p.fromArray(data, i).applyQuaternion(r).toArray(data, i);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], data[i + k]);
      max[k] = Math.max(max[k], data[i + k]);
    }
    q.fromArray(data, i + 6)
      .premultiply(r)
      .normalize()
      .toArray(data, i + 6);
  }
  const extent = Math.max(max[0] - min[0], max[2] - min[2]);
  if (!Number.isFinite(extent) || extent <= 1e-8)
    throw new Error("Ground has no horizontal extent");
  const scale = 1 / extent,
    center = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  for (let i = 0; i < data.length; i += 14)
    for (let k = 0; k < 3; k++) {
      data[i + k] = (data[i + k] - center[k]) * scale;
      data[i + 3 + k] *= scale;
    }
  return { buffer: { count: buffer.count, data }, scale, center };
}

/** Optional removal only; keep the original crop's transform and retained records. */
export function removeLargeGroundSplats(
  buffer: GaussianBuffer,
  threshold: number,
) {
  assertGaussianBuffer(buffer);
  if (!Number.isFinite(threshold) || threshold <= 0)
    throw new Error("Invalid cleanup threshold");
  const removedIndices: number[] = [];
  for (let i = 0; i < buffer.count; i++)
    if (
      Math.max(
        buffer.data[i * 14 + 3],
        buffer.data[i * 14 + 4],
        buffer.data[i * 14 + 5],
      ) > threshold
    )
      removedIndices.push(i);
  const count = buffer.count - removedIndices.length,
    data = new Float32Array(count * 14);
  let removed = 0,
    next = 0;
  for (let i = 0; i < buffer.count; i++) {
    if (removedIndices[removed] === i) {
      removed++;
      continue;
    }
    data.set(buffer.data.subarray(i * 14, i * 14 + 14), next++ * 14);
  }
  return { buffer: { count, data }, removedIndices };
}
