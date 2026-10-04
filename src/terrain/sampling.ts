import { Quaternion, Vector3 } from "three";
import type { F0Recipe, HeightField, GaussianBuffer } from "../gaussian/types";
import { sampleNormal } from "./heightfield";
import { refineShoreline } from "./shoreline";
export function sampleTerrain(
  f: HeightField,
  r: F0Recipe,
): { terrain: GaussianBuffer; water: GaussianBuffer | null } {
  const baseline = sampleTerrainV1(f, r);
  return r.algorithmVersion === "f0-shore-v2"
    ? refineShoreline(f, r, baseline)
    : baseline;
}
function sampleTerrainV1(
  f: HeightField,
  r: F0Recipe,
): { terrain: GaussianBuffer; water: GaussianBuffer | null } {
  const data = new Float32Array(f.nx * f.nz * 14),
    wet: number[] = [];
  const q = new Quaternion(),
    zAxis = new Vector3(0, 0, 1),
    normal = new Vector3();
  for (let iz = 0; iz < f.nz; iz++)
    for (let ix = 0; ix < f.nx; ix++) {
      const i = iz * f.nx + ix,
        h = f.heights[i],
        x = ix * f.spacing - f.width / 2,
        z = iz * f.spacing - f.depth / 2;
      q.setFromUnitVectors(
        zAxis,
        normal.fromArray(sampleNormal(f, ix, iz)),
      ).normalize();
      const submerged = r.waterLevel !== null && h < r.waterLevel;
      const t = (h + (r.amplitude || 1) / 2) / (r.amplitude || 1),
        color = submerged
          ? [0.1, 0.13, 0.075]
          : [0.14 + 0.05 * t, 0.2 + 0.12 * t, 0.055 + 0.025 * t];
      data.set(
        [
          x,
          h,
          z,
          f.spacing * r.tangentFactor,
          f.spacing * r.tangentFactor,
          f.spacing * r.normalFactor,
          q.x,
          q.y,
          q.z,
          q.w,
          ...color,
          r.opacity,
        ],
        i * 14,
      );
      if (submerged) {
        q.setFromUnitVectors(zAxis, new Vector3(0, 1, 0));
        wet.push(
          x,
          r.waterLevel!,
          z,
          f.spacing * r.tangentFactor,
          f.spacing * r.tangentFactor,
          f.spacing * r.normalFactor,
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
  return {
    terrain: { count: f.nx * f.nz, data },
    water:
      r.waterLevel === null
        ? null
        : { count: wet.length / 14, data: new Float32Array(wet) },
  };
}
