import { Vector3, Quaternion } from "three";
import type {
  BuiltScene,
  HeightField,
  Vec3,
  GaussianView,
} from "./gaussian/types";
import { sampleHeight } from "./terrain/heightfield";
export function makeCameraGuard(
  f: HeightField,
  s: BuiltScene,
  water: number | null,
): (p: Vec3) => Vec3 {
  const bounds = new Map<string, { center: Vector3; radius: number }>();
  for (const a of s.assets) {
    const min = new Vector3(Infinity, Infinity, Infinity),
      max = new Vector3(-Infinity, -Infinity, -Infinity),
      d = a.lods.full.data;
    for (let i = 0; i < d.length; i += 14) {
      const sigma = 3 * Math.max(d[i + 3], d[i + 4], d[i + 5]);
      min.min(new Vector3(d[i] - sigma, d[i + 1] - sigma, d[i + 2] - sigma));
      max.max(new Vector3(d[i] + sigma, d[i + 1] + sigma, d[i + 2] + sigma));
    }
    bounds.set(a.id, {
      center: min.clone().add(max).multiplyScalar(0.5),
      radius: min.distanceTo(max) / 2,
    });
  }
  const spheres = s.instances.map((i) => {
    const b = bounds.get(i.assetId)!;
    return {
      center: b.center
        .clone()
        .multiplyScalar(i.scale)
        .applyQuaternion(new Quaternion(...i.rotation))
        .add(new Vector3(...i.position)),
      radius: b.radius * i.scale + 0.5,
    };
  });
  const floor = (p: Vector3) => {
    const x = Math.max(-f.width / 2, Math.min(f.width / 2, p.x)),
      z = Math.max(-f.depth / 2, Math.min(f.depth / 2, p.z));
    p.y = Math.max(
      p.y,
      sampleHeight(f, x, z) + 0.5,
      (water ?? -Infinity) + 0.5,
    );
  };
  return (position) => {
    const p = new Vector3(...position);
    floor(p);
    for (let pass = 0; pass < 4; pass++) {
      for (const s of spheres) {
        const delta = p.clone().sub(s.center),
          distance = delta.length();
        if (distance < s.radius) {
          if (distance < 1e-9) delta.set(0, 1, 0);
          else delta.divideScalar(distance);
          p.copy(s.center).addScaledVector(delta, s.radius);
        }
      }
      floor(p);
    }
    return [p.x, p.y, p.z];
  };
}
export function applyCameraPreset(
  view: Pick<GaussianView, "setCamera">,
  f: HeightField,
  preset: "top" | "eye" | "low" | "near" | "overlap",
  water: number | null,
  displayExtent = Math.max(f.width, f.depth),
): void {
  const h = Math.max(sampleHeight(f, 0, 0), water ?? -Infinity),
    size = Math.max(f.width, f.depth, displayExtent),
    target: Vec3 = [0, h, 0];
  const positions: Record<typeof preset, Vec3> = {
    top: [0, size * 1.2, 0.01],
    eye: [0, h + 1.6, size * 0.65],
    low: [0, h + 0.65, size * 0.65],
    near: [0, h + 0.5, 1],
    overlap: [size * 0.6, Math.max(2.5, size * 0.4), size * 0.7],
  };
  view.setCamera(positions[preset], target);
}
