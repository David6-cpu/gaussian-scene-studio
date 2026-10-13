import type { GaussianBuffer, BuiltScene } from "./types";
import { assertRiversideGround } from "../terrain/riverside.ts";
export function assertGaussianBuffer(buffer: GaussianBuffer): void {
  if (
    !Number.isSafeInteger(buffer.count) ||
    buffer.count < 0 ||
    !(buffer.data instanceof Float32Array) ||
    buffer.data.length !== buffer.count * 14
  )
    throw new Error("Gaussian buffer length does not match count");
  const d = buffer.data;
  for (let i = 0; i < d.length; i += 14) {
    for (let k = 0; k < 14; k++)
      if (!Number.isFinite(d[i + k]))
        throw new Error("Gaussian fields must be finite");
    if (d[i + 3] <= 0 || d[i + 4] <= 0 || d[i + 5] <= 0)
      throw new Error("Gaussian sigma must be positive");
    if (Math.abs(Math.hypot(d[i + 6], d[i + 7], d[i + 8], d[i + 9]) - 1) > 1e-4)
      throw new Error("Gaussian quaternion must be normalized");
    for (let k = 10; k < 14; k++)
      if (d[i + k] < 0 || d[i + k] > 1)
        throw new Error("Gaussian color and opacity must be in [0,1]");
  }
}
export function sourceBuffers(scene: BuiltScene): GaussianBuffer[] {
  return [
    ...new Set([
      scene.terrain,
      ...(scene.water ? [scene.water] : []),
      ...scene.assets.flatMap((a) => [a.lods.full, a.lods.coarse]),
    ]),
  ].filter((b) => b.count > 0);
}
export function countSplats(scene: BuiltScene): {
  uniqueSourceSplats: number;
  activeSplats: number;
} {
  const assets = new Map(scene.assets.map((a) => [a.id, a]));
  return {
    uniqueSourceSplats:
      sourceBuffers(scene).reduce((s, b) => s + b.count, 0) +
      (scene.ground?.count ?? 0),
    activeSplats:
      scene.terrain.count +
      (scene.ground?.count ?? 0) +
      (scene.water?.count ?? 0) +
      scene.instances.reduce((s, i) => {
        const a = assets.get(i.assetId);
        if (!a) throw new Error("Unknown asset");
        return s + a.lods[i.lod].count;
      }, 0),
  };
}
export function assertSceneBudget(scene: BuiltScene): void {
  if (scene.ground) {
    const g=scene.ground;
    if ("kind" in g) {
      const d=g.definition;
      if(g.id!==d.metadata.id || g.count!==d.count || !Number.isSafeInteger(g.count) || g.count<1 || g.count>250000 || d.capacity!==Math.ceil(d.count/2048)*2048 || g.scale!==d.display.uniformScale || JSON.stringify(g.position)!==JSON.stringify(d.display.position) || JSON.stringify(g.rotation)!==JSON.stringify(d.display.quaternionXYZW)) throw Error("Invalid prepared descriptor or 250000 point budget");
    } else assertRiversideGround(g);
  }
  if (scene.instances.length > 20) throw new Error("Instance limit is 20");
  const ids = new Set<string>(),
    assets = new Map(scene.assets.map((a) => [a.id, a]));
  let worst =
    scene.terrain.count +
    (scene.water?.count ?? 0) +
    (scene.ground?.count ?? 0);
  for (const i of scene.instances) {
    if (!Number.isFinite(i.scale) || i.scale <= 0)
      throw new Error("Instance scale must be positive");
    if (ids.has(i.id) || i.id.startsWith("$"))
      throw new Error("Duplicate or reserved instance id");
    ids.add(i.id);
    if (
      i.position.some((x) => !Number.isFinite(x)) ||
      i.rotation.some((x) => !Number.isFinite(x)) ||
      Math.abs(Math.hypot(...i.rotation) - 1) > 1e-4
    )
      throw new Error("Invalid instance transform");
    const a = assets.get(i.assetId);
    if (!a) throw new Error("Unknown asset");
    if (i.lod !== "full" && i.lod !== "coarse") throw new Error("Invalid LOD");
    worst += Math.max(a.lods.full.count, a.lods.coarse.count);
  }
  if (!Number.isSafeInteger(worst) || worst < 0 || worst > 250000)
    throw new Error("Active Gaussian limit is 250000");
}
