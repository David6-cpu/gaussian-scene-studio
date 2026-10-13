import { PerspectiveCamera, Vector3 } from "three";
import type { LoadedAsset } from "./asset-loader";
import type { AssetManifestV2 } from "./asset-manifest";
import type { CameraState, Transform, Vec3 } from "./core";
import { sourcePlacement, worldPoint, type RenderPacket } from "./render/types";
export const reviewPlacement: Transform = {
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: 1,
};
const anchorOf = (m: AssetManifestV2): Vec3 =>
  m.kind === "object" ? m.object.anchor : [0, 0, 0];
/** Inspection does not change the manifest or authenticate/approve admission. */
export function makeReviewPacket(
  asset: LoadedAsset,
  lod: "full" | "coarse",
  placement: Transform = reviewPlacement,
): RenderPacket {
  const source = lod === "full" ? asset.full : asset.coarse;
  if (!source) throw Error("Requested review LOD is absent");
  const key = `${asset.manifest.id}@${asset.manifest.contentVersion}/${lod}`;
  return {
    sources: new Map([[key, source]]),
    instances: [
      {
        id: "review",
        sourceKey: key,
        coarseSourceKey: null,
        ...sourcePlacement(
          anchorOf(asset.manifest),
          asset.manifest.coordinates.sourceToCanonical,
          placement,
        ),
      },
    ],
  };
}
/** Proposed inspection settings, never validatedDistance/validatedDirections metadata. */
export function reviewViews(
  m: AssetManifestV2,
): { name: string; camera: CameraState; distance: number; basis: string }[] {
  const b = m.coordinates.fullBounds,
    a = anchorOf(m),
    center = b.min.map((v, i) => (v + b.max[i]) / 2 - a[i]) as unknown as Vec3;
  const radius = Math.max(
    0.1,
    Math.hypot(...b.max.map((v, i) => (v - b.min[i]) / 2)),
  );
  const distance = (radius / Math.sin((25 * Math.PI) / 180)) * 1.15;
  const minimum = m.gaussian.validatedDistance?.[0] ?? radius * 1.25;
  return (
    [
      ["front", [0, 0.12, 1], distance],
      ["back", [0, 0.12, -1], distance],
      ["top", [0, 1, 0.001], distance],
      ["low", [0, 0.025, 1], distance],
      ["minimum-distance", [0, 0.12, 1], minimum],
    ] as const
  ).map(([name, direction, d]) => ({
    name,
    camera: {
      position: new Vector3(...direction)
        .normalize()
        .multiplyScalar(d)
        .add(new Vector3(...center))
        .toArray() as [number, number, number],
      target: center,
    },
    distance: d,
    basis:
      name === "minimum-distance"
        ? m.gaussian.validatedDistance
          ? "declared minimum distance"
          : "proposed 1.25 × numerical bounds radius; unvalidated"
        : "proposed canonical inspection camera",
  }));
}
/** Optional 2D debug overlay; natural visible geometry remains Gaussian. */
export function drawReviewDebug(
  canvas: HTMLCanvasElement,
  m: AssetManifestV2,
  cameraState: CameraState,
  enabled: boolean,
  placement: Transform = reviewPlacement,
) {
  const ctx = canvas.getContext("2d")!;
  const dpr = Math.min(devicePixelRatio || 1, 2),
    w = canvas.clientWidth,
    h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!enabled) return;
  const camera = new PerspectiveCamera(50, w / h, 0.01, 150);
  camera.position.fromArray(cameraState.position);
  camera.lookAt(new Vector3(...cameraState.target));
  camera.updateMatrixWorld();
  const project = (p: Vec3) =>
    new Vector3(...worldPoint(p, anchorOf(m), placement)).project(camera);
  const b = m.coordinates.fullBounds,
    corners = Array.from({ length: 8 }, (_, i) =>
      project([
        i & 1 ? b.max[0] : b.min[0],
        i & 2 ? b.max[1] : b.min[1],
        i & 4 ? b.max[2] : b.min[2],
      ]),
    );
  ctx.strokeStyle = "#ffb347";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 8; i++)
    for (const bit of [1, 2, 4])
      if (!(i & bit)) {
        const p = corners[i],
          q = corners[i | bit];
        if (Math.abs(p.z) > 1 || Math.abs(q.z) > 1) continue;
        ctx.beginPath();
        ctx.moveTo(((p.x + 1) * w) / 2, ((1 - p.y) * h) / 2);
        ctx.lineTo(((q.x + 1) * w) / 2, ((1 - q.y) * h) / 2);
        ctx.stroke();
      }
  if (m.kind === "object")
    for (const support of m.object.supportPoints) {
      const p = project(support.position);
      if (Math.abs(p.z) > 1) continue;
      ctx.fillStyle = support.role === "root" ? "#00ffb0" : "#ee66ff";
      ctx.beginPath();
      ctx.arc(((p.x + 1) * w) / 2, ((1 - p.y) * h) / 2, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
}
