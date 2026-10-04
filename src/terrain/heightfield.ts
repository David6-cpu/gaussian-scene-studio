import type { F0Recipe, HeightField, Vec3 } from "../gaussian/types";
function hash(x: number, z: number, seed: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x: number, z: number, seed: number) {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    fx = x - ix,
    fz = z - iz,
    u = fx * fx * (3 - 2 * fx),
    v = fz * fz * (3 - 2 * fz);
  return (
    (1 - v) * ((1 - u) * hash(ix, iz, seed) + u * hash(ix + 1, iz, seed)) +
    v * ((1 - u) * hash(ix, iz + 1, seed) + u * hash(ix + 1, iz + 1, seed))
  );
}
export function makeHeightField(r: F0Recipe): HeightField {
  const nx = Math.round(r.width / r.spacing) + 1,
    nz = Math.round(r.depth / r.spacing) + 1;
  if (nx < 2 || nz < 2 || nx * nz > 10201)
    throw new Error("Heightfield size out of F0 range");
  const raw = new Float64Array(nx * nz);
  let min = Infinity,
    max = -Infinity;
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const x = ix * r.spacing - r.width / 2,
        z = iz * r.spacing - r.depth / 2;
      let f = 0.2,
        w = 1,
        sum = 0,
        total = 0;
      for (let o = 0; o < r.octaves; o++) {
        sum += w * (noise(x * f, z * f, r.seed + o) - 0.5);
        total += w;
        f *= 2;
        w *= 0.5;
      }
      const h =
        (0.28 * sum) / total -
        0.4 *
          Math.exp(
            -((x / (r.width * 0.28)) ** 2 + (z / (r.depth * 0.25)) ** 2),
          );
      raw[iz * nx + ix] = h;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  return {
    width: r.width,
    depth: r.depth,
    spacing: r.spacing,
    nx,
    nz,
    heights: Float32Array.from(raw, (h) =>
      max > min ? ((h - min) / (max - min) - 0.5) * r.amplitude : 0,
    ),
  };
}
export function sampleHeight(f: HeightField, x: number, z: number): number {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(z) ||
    Math.abs(x) > f.width / 2 + 1e-6 ||
    Math.abs(z) > f.depth / 2 + 1e-6
  )
    throw new Error("Height sample outside field");
  const gx = Math.max(0, Math.min(f.nx - 1, (x + f.width / 2) / f.spacing)),
    gz = Math.max(0, Math.min(f.nz - 1, (z + f.depth / 2) / f.spacing));
  const ix = Math.min(f.nx - 2, Math.floor(gx)),
    iz = Math.min(f.nz - 2, Math.floor(gz)),
    tx = gx - ix,
    tz = gz - iz;
  const at = (a: number, b: number) => f.heights[b * f.nx + a];
  return (
    (1 - tz) * ((1 - tx) * at(ix, iz) + tx * at(ix + 1, iz)) +
    tz * ((1 - tx) * at(ix, iz + 1) + tx * at(ix + 1, iz + 1))
  );
}
export function sampleNormal(f: HeightField, ix: number, iz: number): Vec3 {
  const x0 = Math.max(0, ix - 1),
    x1 = Math.min(f.nx - 1, ix + 1),
    z0 = Math.max(0, iz - 1),
    z1 = Math.min(f.nz - 1, iz + 1);
  const dx =
      (f.heights[iz * f.nx + x1] - f.heights[iz * f.nx + x0]) /
      ((x1 - x0) * f.spacing),
    dz =
      (f.heights[z1 * f.nx + ix] - f.heights[z0 * f.nx + ix]) /
      ((z1 - z0) * f.spacing);
  const n = Math.hypot(dx, 1, dz);
  return Number.isFinite(n) ? [-dx / n, 1 / n, -dz / n] : [0, 1, 0];
}
