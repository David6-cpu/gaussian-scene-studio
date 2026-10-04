import { Quaternion, Vector3 } from "three";
import type {
  AssetPrototype,
  HeightField,
  F0Recipe,
  Instance,
  Vec3,
  Quat,
} from "../gaussian/types";
import { sampleHeight, sampleNormal } from "../terrain/heightfield";
import { isRiverProps } from "../recipe";
export function anchorInstance(
  f: HeightField,
  a: AssetPrototype,
  p: Vec3,
  q: Quat,
  scale: number,
): Vec3 | null {
  let low = -Infinity,
    high = Infinity;
  try {
    for (const point of a.supportPoints) {
      const v = new Vector3(...point)
        .sub(new Vector3(...a.anchor))
        .multiplyScalar(scale)
        .applyQuaternion(new Quaternion(...q));
      const h = sampleHeight(f, p[0] + v.x, p[2] + v.z);
      low = Math.max(low, h - v.y - 0.02);
      high = Math.min(high, h - v.y + 0.05);
    }
    if (low > high) return null;
    return [
      p[0] || 0,
      Math.max(low, Math.min(high, sampleHeight(f, p[0], p[2]))) || 0,
      p[2] || 0,
    ];
  } catch {
    return null;
  }
}
export function placeAssets(
  f: HeightField,
  r: F0Recipe,
  assets: AssetPrototype[],
): {
  instances: Instance[];
  rejections: Record<string, number>;
  shortfall: { rock: number; reed: number };
} {
  let seed = r.seed >>> 0;
  const varied = isRiverProps(r.algorithmVersion);
  const wet: [number, number][] = [];
  if (r.algorithmVersion === "f0-riverside-reed-v1" && r.waterLevel !== null)
    for (let iz = 0; iz < f.nz; iz++)
      for (let ix = 0; ix < f.nx; ix++)
        if (f.heights[iz * f.nx + ix] < r.waterLevel)
          wet.push([
            ix * f.spacing - f.width / 2,
            iz * f.spacing - f.depth / 2,
          ]);
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const instances: Instance[] = [],
    active: number[] = [],
    rejections: Record<string, number> = {},
    left = { ...r.requested };
  const cell = 0.6 / Math.SQRT2,
    grid = new Map<string, number[]>(),
    byId = new Map(assets.map((a) => [a.id, a]));
  let tries = 0,
    turn = 0;
  const reject = (why: string) => {
    rejections[why] = (rejections[why] ?? 0) + 1;
  };
  while (left.rock + left.reed > 0 && tries < 6000) {
    const activeSlot = active.length ? Math.floor(rand() * active.length) : -1,
      origin = activeSlot < 0 ? null : instances[active[activeSlot]];
    let accepted = false;
    for (let attempt = 0; attempt < 30 && tries < 6000; attempt++, tries++) {
      const id =
          left.rock && left.reed
            ? turn++ % 2
              ? "reed"
              : "rock"
            : left.rock
              ? "rock"
              : "reed",
        a = byId.get(id);
      if (!a) throw new Error("Missing requested asset");
      const scale = varied ? 0.85 + 0.25 * rand() : 1;
      const yaw = varied ? rand() * Math.PI * 2 : 0;
      const angle = rand() * Math.PI * 2,
        distance = 0.6 * (1 + rand()),
        x = origin
          ? origin.position[0] + Math.cos(angle) * distance
          : (rand() - 0.5) * f.width,
        z = origin
          ? origin.position[2] + Math.sin(angle) * distance
          : (rand() - 0.5) * f.depth;
      if (
        Math.abs(x) > f.width / 2 - a.radius * scale ||
        Math.abs(z) > f.depth / 2 - a.radius * scale
      ) {
        reject("boundary");
        continue;
      }
      const h = sampleHeight(f, x, z);
      if (r.waterLevel !== null && h < r.waterLevel) {
        reject("water");
        continue;
      }
      if (
        id === "reed" &&
        r.algorithmVersion === "f0-riverside-reed-v1" &&
        r.waterLevel !== null &&
        !wet.some(([wx, wz]) => (x - wx) ** 2 + (z - wz) ** 2 <= 0.9 ** 2)
      ) {
        reject("shore-distance");
        continue;
      }
      const normal = sampleNormal(
        f,
        Math.round((x + f.width / 2) / f.spacing),
        Math.round((z + f.depth / 2) / f.spacing),
      );
      if (normal[1] < Math.cos(Math.PI / 12)) {
        reject("slope");
        continue;
      }
      const gx = Math.floor(x / cell),
        gz = Math.floor(z / cell);
      let collision = false;
      for (let dx = -2; dx <= 2; dx++)
        for (let dz = -2; dz <= 2; dz++)
          for (const idx of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
            const other = instances[idx],
              b = byId.get(other.assetId)!;
            if (
              Math.hypot(x - other.position[0], z - other.position[2]) <
              Math.max(0.6, a.radius * scale + b.radius * other.scale)
            )
              collision = true;
          }
      if (collision) {
        reject("spacing");
        continue;
      }
      const rot =
        id === "rock"
          ? new Quaternion().setFromUnitVectors(
              new Vector3(0, 1, 0),
              new Vector3(...normal),
            )
          : new Quaternion();
      if (varied)
        rot.multiply(
          new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
        );
      const rotation: Quat = [rot.x || 0, rot.y || 0, rot.z || 0, rot.w];
      const position = anchorInstance(f, a, [x, h, z], rotation, scale);
      if (!position) {
        reject("support");
        continue;
      }
      const idx = instances.length;
      instances.push({
        id: `${id}-${idx}`,
        assetId: id,
        position,
        rotation,
        scale,
        lod: "full",
      });
      active.push(idx);
      const key = `${gx},${gz}`;
      grid.set(key, [...(grid.get(key) ?? []), idx]);
      left[id]--;
      accepted = true;
      tries++;
      break;
    }
    if (!accepted && activeSlot >= 0) active.splice(activeSlot, 1);
  }
  return { instances, rejections, shortfall: left };
}
