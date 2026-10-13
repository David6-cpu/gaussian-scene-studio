import { integer, record } from "../data-validation.ts";

export type Issue = { code: string; path: string; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };
export type AssetRef = { readonly id: string; readonly contentVersion: string };
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
/** Quaternion component order is x, y, z, w. */
export type Quat = readonly [number, number, number, number];
/** Scale is one positive scalar: nonuniform scaling has no representation. */
export type Transform = {
  readonly position: Vec3;
  readonly quaternion: Quat;
  readonly scale: number;
};
/** Vec2 coordinates are x, z in the canonical ground plane. */
export type Bounds2 = { readonly min: Vec2; readonly max: Vec2 };
export type CameraState = { readonly position: Vec3; readonly target: Vec3 };
export type ResourceUsage = {
  readonly instances: number;
  /** Sum of the worst available LOD for every instance, including shared sources. */
  readonly worstSplats: number;
  readonly candidateCpuBytes: number;
  /** Current + candidate + worker copies + staging + upload/sort estimates. */
  readonly transitionBytes: number;
};

const MiB = 1024 ** 2;
/** Application ceilings, never populated from requests or manifests. Display units are not metres. */
export const GENERAL_LIMITS = Object.freeze({
  minExtent: 4,
  maxExtent: 10,
  extentStep: 0.5,
  spacings: Object.freeze([0.1, 0.2] as const),
  maxHeightNodes: 10201,
  maxInstances: 20,
  maxWorstSplats: 250000,
  maxRegions: 8,
  maxFeatureGroups: 8,
  maxWaterBodies: 1,
  maxProceduralSites: 1,
  maxRigidPatches: 1,
  minSlopeDegrees: 0,
  maxSlopeDegrees: 12,
  minNoiseAmplitude: 0,
  maxNoiseAmplitude: 0.4,
  minNoiseScale: 0.5,
  maxNoiseScale: 5,
  minNoiseOctaves: 1,
  maxNoiseOctaves: 4,
  minElevation: -2,
  maxElevation: 2,
  minWaterLevel: -2,
  maxWaterLevel: 2,
  minRiverControlPoints: 2,
  maxRiverControlPoints: 8,
  minRiverWidth: 0.4,
  maxRiverWidth: 2,
  minRiverDepth: 0.05,
  maxRiverDepth: 0.5,
  minBankWidth: 0.2,
  maxBankWidth: 1,
  minSurfaceVertices: 3,
  maxSurfaceVertices: 12,
  minDryBankWidth: 0.2,
  minDryAreaFraction: 0.25,
  minContactGap: -0.02,
  maxContactGap: 0.05,
  defaultFootprintSlopeDegrees: 15,
  minDryWaterDistance: 0.1,
  recommendedReedBankMin: 0.1,
  recommendedReedBankMax: 0.9,
  defaultSpacingMargin: 0.1,
  maxPlacementAttempts: 6000,
  maxAttemptsPerInstance: 300,
  maxCandidateCpuBytes: 128 * MiB,
  maxTransitionBytes: 256 * MiB,
  maxJsonBytes: 2 * MiB,
  maxCompressedPackageBytes: 64 * MiB,
  maxExpandedPackageBytes: 128 * MiB,
  maxPackageFiles: 128,
  maxLocalScenes: 20,
  maxLocalBlobBytes: 256 * MiB,
  modelContextTokens: 4096,
  maxModelOutputTokens: 1024,
  maxModelConcurrency: 1,
  maxPromptCharacters: 2000,
  maxCandidatesPerStage: 12,
  maxCandidatesPerGroup: 3,
  maxModelStages: 2,
  maxFormatRepairs: 1,
  maxModelRequests: 3,
  maxModelRequestMs: 60000,
  maxModelTotalMs: 120000,
  maxCancelUiMs: 1000,
  targetCpuBuildMs: 2000,
  maxCpuBuildMs: 10000,
  benchmarkWidth: 1280,
  benchmarkHeight: 720,
  benchmarkDpr: 1,
  benchmarkDurationMs: 60000,
  minMedianFps: 30,
  maxP95FrameMs: 50,
  maxFirstDisplayMs: 3000,
  maxSwapGrowthBytes: 256 * MiB,
} as const);

export function assertBudget(
  usage: ResourceUsage,
  limits: typeof GENERAL_LIMITS,
): void {
  if (limits !== GENERAL_LIMITS)
    throw Error("Resource ceilings must be GENERAL_LIMITS");
  const values = record(usage, [
    "instances",
    "worstSplats",
    "candidateCpuBytes",
    "transitionBytes",
  ]);
  const ceilings = {
    instances: limits.maxInstances,
    worstSplats: limits.maxWorstSplats,
    candidateCpuBytes: limits.maxCandidateCpuBytes,
    transitionBytes: limits.maxTransitionBytes,
  };
  for (const [key, ceiling] of Object.entries(ceilings)) {
    try {
      integer(values[key], 0, ceiling);
    } catch (cause) {
      throw new Error(
        `Resource budget invalid or exceeded: ${key} (maximum ${ceiling})`,
        { cause },
      );
    }
  }
}
