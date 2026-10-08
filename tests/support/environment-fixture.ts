import { gzipSync } from "fflate";
export const environmentWorld = (flip?: boolean) => ({
  id: "local-coordinate-fixture",
  display_name: "坐标测试夹具（非真实河岸）",
  model: "local-test-fixture",
  assets: {
    splats: {
      spz_urls: { "100k": "https://example.invalid/never-fetch.spz" },
      semantics_metadata: {
        metric_scale_factor: 2,
        ground_plane_offset: 0.5,
        ...(flip === undefined ? {} : { flip_y: flip }),
      },
    },
  },
});
export const jsonBytes = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v));
export function environmentSpz(version = 2, degree = 0): Uint8Array {
  const centers = [
      [1, 2, 3],
      [-1, 0, 0],
      [0, -1, -2],
    ],
    n = centers.length;
  const sh = [0, 3, 8, 15][degree] * 3;
  const bytes = new Uint8Array(16 + n * (version === 3 ? 20 : 19) + n * sh);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x5053474e, true);
  header.setUint32(4, version, true);
  header.setUint32(8, n, true);
  bytes[12] = degree;
  bytes[13] = 12;
  let at = 16;
  for (const p of centers)
    for (const x of p) {
      const q = Math.round(x * 4096);
      bytes[at++] = q & 255;
      bytes[at++] = (q >> 8) & 255;
      bytes[at++] = (q >> 16) & 255;
    }
  bytes.fill(255, at, (at += n)); // opacity
  bytes.set([255, 128, 128, 128, 255, 128, 128, 128, 255], at);
  at += n * 3;
  bytes.fill(136, at, (at += n * 3)); // exp(136/16-10), visible colored ellipsoids
  if (version === 2) bytes.fill(128, at, (at += n * 3));
  else {
    for (let i = 0; i < n; i++) {
      header.setUint32(at, 3 << 30, true);
      at += 4;
    }
  }
  bytes.fill(128, at);
  return gzipSync(bytes);
}
