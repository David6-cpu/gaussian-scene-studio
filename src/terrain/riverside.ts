import type { HeightField, RiversideGround } from "../gaussian/types";
import { riversideData } from "./riverside-data.ts";

export const RIVERSIDE_BYTES = 6 * 1024 * 1024;
export function riversideGround(): RiversideGround {
  return {
    id: riversideData.id,
    count: riversideData.count,
    position: [...riversideData.position],
    rotation: [...riversideData.rotation],
    scale: riversideData.scale,
  };
}
export function riversideHeightField(): HeightField {
  const p = riversideData.heightProxy;
  return {
    width: p.width,
    depth: p.depth,
    spacing: p.spacing,
    nx: p.nx,
    nz: p.nz,
    heights: Float32Array.from(p.heights),
  };
}
export function assertRiversideGround(ground: RiversideGround): void {
  const expected = riversideGround();
  if (
    ground.id !== expected.id ||
    ground.count !== expected.count ||
    ground.scale !== expected.scale ||
    !Array.isArray(ground.position) ||
    !Array.isArray(ground.rotation) ||
    JSON.stringify(ground.position) !== JSON.stringify(expected.position) ||
    JSON.stringify(ground.rotation) !== JSON.stringify(expected.rotation)
  )
    throw new Error("Riverside地表版本或变换不匹配");
}
