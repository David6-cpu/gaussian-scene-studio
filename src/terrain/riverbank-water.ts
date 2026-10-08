import type {
  GaussianBuffer,
  HeightField,
  RiverbankRecipe,
} from "../gaussian/types";
import type { PlacementSurface } from "../assets/placement";
import { sampleHeight } from "./heightfield";

export interface RiverbankWater {
  buffer: GaussianBuffer | null;
  mask: Uint8Array;
  nx: number;
  nz: number;
  spacing: number;
  metrics: {
    components: number;
    spansZ: boolean;
    minWetWidth: number;
    wetFraction: number;
  };
}
const N = 81,
  SPACING = 0.05;
const neighbors = (i: number): number[] => {
  const x = i % N,
    z = Math.floor(i / N);
  return [
    ...(x ? [i - 1] : []),
    ...(x < N - 1 ? [i + 1] : []),
    ...(z ? [i - N] : []),
    ...(z < N - 1 ? [i + N] : []),
  ];
};

export function sampleRiverbankWater(
  f: HeightField,
  r: RiverbankRecipe,
): RiverbankWater {
  const mask = new Uint8Array(N * N);
  const out: RiverbankWater = {
    buffer: null,
    mask,
    nx: N,
    nz: N,
    spacing: SPACING,
    metrics: { components: 0, spansZ: false, minWetWidth: 0, wetFraction: 0 },
  };
  if (r.waterLevel === null) return out;
  const level = r.waterLevel,
    heights = new Float64Array(N * N),
    wet = new Uint8Array(N * N),
    seen = new Uint8Array(N * N);
  for (let i = 0; i < wet.length; i++) {
    heights[i] = sampleHeight(
      f,
      (i % N) * SPACING - 2,
      Math.floor(i / N) * SPACING - 2,
    );
    wet[i] = heights[i] < level ? 1 : 0;
  }
  if (wet.every(Boolean))
    throw Error(
      "当前水位淹没全部展示区域，没有可见干岸；请调整水位后重新预览。",
    );
  let selected: number[] = [];
  for (let i = 0; i < wet.length; i++) {
    if (!wet[i] || seen[i]) continue;
    const part = [i];
    seen[i] = 1;
    let north = false,
      south = false,
      westSeed = false;
    for (let cursor = 0; cursor < part.length; cursor++) {
      const point = part[cursor],
        x = point % N,
        z = Math.floor(point / N);
      north ||= z === 0;
      south ||= z === N - 1;
      westSeed ||= x <= 10;
      for (const next of neighbors(point))
        if (wet[next] && !seen[next]) {
          seen[next] = 1;
          part.push(next);
        }
    }
    if (north && south && westSeed && part.length > selected.length)
      selected = part;
  }
  if (!selected.length)
    throw Error("当前水位不能形成贯通两端的连续河岸水面；未修改水位。");
  for (const i of selected) mask[i] = 1;
  const data = new Float32Array(selected.length * 14),
    rows = new Uint16Array(N);
  let cursor = 0;
  // Row-major output is deterministic even if traversal order changes.
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % N,
      z = Math.floor(i / N),
      depth = Math.min(1, Math.max(0, (level - heights[i]) / 0.25));
    rows[z]++;
    let shoreDistance = 0.1;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx,
          nz = z + dz;
        if (nx >= 0 && nx < N && nz >= 0 && nz < N && !wet[nz * N + nx])
          shoreDistance = Math.min(shoreDistance, Math.hypot(dx, dz) * SPACING);
      }
    // Dense overlapping splats compound opacity; retain the scanned shallow bed.
    const opacity = 0.12 + (0.22 + 0.22 * depth - 0.12) * (shoreDistance / 0.1);
    data.set(
      [
        x * SPACING - 2,
        level,
        z * SPACING - 2,
        0.0375,
        0.0375,
        0.003,
        -Math.SQRT1_2,
        0,
        0,
        Math.SQRT1_2,
        0.085 + (0.028 - 0.085) * depth,
        0.14 + (0.075 - 0.14) * depth,
        0.115 + (0.082 - 0.115) * depth,
        opacity,
      ],
      cursor++ * 14,
    );
  }
  return {
    ...out,
    buffer: { count: selected.length, data },
    metrics: {
      components: 1,
      spansZ: true,
      minWetWidth: Math.min(...rows) * SPACING,
      wetFraction: selected.length / mask.length,
    },
  };
}

export function riverbankSurface(
  w: RiverbankWater,
  shorePlant: boolean,
): PlacementSurface {
  const waterPoints: [number, number][] = [];
  for (let i = 0; i < w.mask.length; i++)
    if (w.mask[i])
      waterPoints.push([
        (i % w.nx) * w.spacing - 2,
        Math.floor(i / w.nx) * w.spacing - 2,
      ]);
  return {
    waterPoints,
    shorePlant: shorePlant && waterPoints.length > 0,
    isWet: (x, z) => {
      if (Math.abs(x) > 2 || Math.abs(z) > 2) return false;
      return Boolean(
        w.mask[
          Math.round((z + 2) / w.spacing) * w.nx +
            Math.round((x + 2) / w.spacing)
        ],
      );
    },
  };
}
