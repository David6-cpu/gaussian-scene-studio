import { Quaternion, Vector3 } from "three";
import type { F0Recipe, HeightField, GaussianBuffer } from "../gaussian/types";
import { sampleHeight } from "./heightfield";
type Samples = { terrain: GaussianBuffer; water: GaussianBuffer | null };

/** Refine only the 5x5 wet/dry crossing band. Source heightfield is unchanged. */
export function refineShoreline(
  f: HeightField,
  r: F0Recipe,
  baseline: Samples,
): Samples {
  if (r.waterLevel === null) return baseline;
  const level = r.waterLevel,
    mask = new Uint8Array(f.nx * f.nz);
  let refined = 0;
  for (let iz = 0; iz < f.nz; iz++)
    for (let ix = 0; ix < f.nx; ix++) {
      let wet = false,
        dry = false;
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++) {
          const h =
            f.heights[
              Math.max(0, Math.min(f.nz - 1, iz + dz)) * f.nx +
                Math.max(0, Math.min(f.nx - 1, ix + dx))
            ];
          if (h < level) wet = true;
          else dry = true;
        }
      if (wet && dry) {
        mask[iz * f.nx + ix] = 1;
        refined++;
      }
    }
  if (!refined) return baseline;
  // Allowed recipe spacings 0.1/0.2/0.4 give 2/4/8 subdivisions: fixed 5 cm step.
  // Even refining every vertex on 10x10 m keeps terrain+water+20 full assets <=168448.
  const subdivisions = Math.round(f.spacing / 0.05),
    step = f.spacing / subdivisions;
  const ground: number[] = [],
    water: number[] = [],
    q = new Quaternion(),
    axis = new Vector3(0, 0, 1),
    normal = new Vector3();
  const height = (x: number, z: number) =>
    sampleHeight(
      f,
      Math.max(-f.width / 2, Math.min(f.width / 2, x)),
      Math.max(-f.depth / 2, Math.min(f.depth / 2, z)),
    );
  let originalWet = 0;
  for (let iz = 0; iz < f.nz; iz++)
    for (let ix = 0; ix < f.nx; ix++) {
      const i = iz * f.nx + ix,
        wasWet = f.heights[i] < level;
      if (!mask[i]) {
        ground.push(...baseline.terrain.data.subarray(i * 14, (i + 1) * 14));
        if (wasWet)
          water.push(
            ...baseline.water!.data.subarray(
              originalWet * 14,
              (originalWet + 1) * 14,
            ),
          );
      } else {
        const cx = ix * f.spacing - f.width / 2,
          cz = iz * f.spacing - f.depth / 2;
        for (let a = 0; a < subdivisions; a++)
          for (let b = 0; b < subdivisions; b++) {
            const x = cx + ((a + 0.5) / subdivisions - 0.5) * f.spacing,
              z = cz + ((b + 0.5) / subdivisions - 0.5) * f.spacing;
            if (Math.abs(x) > f.width / 2 || Math.abs(z) > f.depth / 2)
              continue;
            const h = height(x, z),
              submerged = h < level,
              t = (h + (r.amplitude || 1) / 2) / (r.amplitude || 1),
              color = submerged
                ? [0.1, 0.13, 0.075]
                : [0.14 + 0.05 * t, 0.2 + 0.12 * t, 0.055 + 0.025 * t];
            normal
              .set(
                -(height(x + step / 2, z) - height(x - step / 2, z)) / step,
                1,
                -(height(x, z + step / 2) - height(x, z - step / 2)) / step,
              )
              .normalize();
            q.setFromUnitVectors(axis, normal).normalize();
            ground.push(
              x,
              h,
              z,
              step * r.tangentFactor,
              step * r.tangentFactor,
              step * r.normalFactor,
              q.x,
              q.y,
              q.z,
              q.w,
              ...color,
              r.opacity,
            );
            if (submerged) {
              q.setFromUnitVectors(axis, new Vector3(0, 1, 0));
              water.push(
                x,
                level,
                z,
                step * r.tangentFactor,
                step * r.tangentFactor,
                step * r.normalFactor,
                q.x,
                q.y,
                q.z,
                q.w,
                0.025,
                0.19,
                0.23,
                r.opacity,
              );
            }
          }
      }
      if (wasWet) originalWet++;
    }
  return {
    terrain: { count: ground.length / 14, data: new Float32Array(ground) },
    water: { count: water.length / 14, data: new Float32Array(water) },
  };
}
