import { Quaternion, Vector3 } from "three";
import type { SplatSource } from "../asset-loader";
import type { CameraState, Transform, Vec3 } from "../core";
export type RenderInstance = {
  id: string;
  sourceKey: string;
  /** Anchor in the raw source frame. transform.position remains the world landing anchor. */
  anchor: Vec3;
  transform: Transform;
  coarseSourceKey: string | null;
};
export type RenderPacket = {
  sources: ReadonlyMap<string, SplatSource>;
  instances: RenderInstance[];
};
export type RenderStats = {
  sourceCount: number;
  instanceCount: number;
  activeSplats: number;
  /** Retained sources + padded renderer high-water reservation, including late cleanup.
   * Excludes caller arrays; private WASM/runtime heaps and driver overhead are unmeasured. */
  ownedBytes: number;
};
export type GeneralSwap = {
  activate(): void;
  commit(): void;
  rollback(): void;
  isUsable(): boolean;
};
export type GeneralView = {
  prepare(packet: RenderPacket, signal: AbortSignal): Promise<GeneralSwap>;
  /** Preparing includes late cleanup; unavailable means disposed or context-lost. */
  activity(): { preparing: boolean; readonly available: boolean };
  /** Resolves once all prepare calls and their initializer cleanup have settled. */
  whenPreparationSettled(): Promise<void>;
  getCamera(): CameraState;
  setCamera(camera: CameraState): void;
  stats(): RenderStats;
  /** Caller owns the render loop. No loop is started by this view. */
  render(): void;
  /** Cancels promptly and waits for renderer sorting/disposal. Unsettled source/mesh
   * initialization can outlive this promise; stats stays reserved until its cleanup. */
  dispose(): Promise<void>;
};
/** Same-frame point/anchor; placement support uses the canonical frame, rendering uses raw. */
export function worldPoint(
  point: Vec3,
  anchor: Vec3,
  transform: Transform,
): Vec3 {
  return new Vector3(...point)
    .sub(new Vector3(...anchor))
    .multiplyScalar(transform.scale)
    .applyQuaternion(new Quaternion(...transform.quaternion))
    .add(new Vector3(...transform.position))
    .toArray() as [number, number, number];
}
/** Compose normalization once without modifying centers or SH coefficients. */
export function sourcePlacement(
  anchor: Vec3,
  normalization: Transform,
  placement: Transform,
): Pick<RenderInstance, "anchor" | "transform"> {
  const rawAnchor = new Vector3(...anchor)
    .sub(new Vector3(...normalization.position))
    .applyQuaternion(new Quaternion(...normalization.quaternion).invert())
    .divideScalar(normalization.scale);
  return {
    anchor: rawAnchor.toArray() as [number, number, number],
    transform: {
      position: [...placement.position],
      quaternion: new Quaternion(...placement.quaternion)
        .multiply(new Quaternion(...normalization.quaternion))
        .toArray() as [number, number, number, number],
      scale: placement.scale * normalization.scale,
    },
  };
}
