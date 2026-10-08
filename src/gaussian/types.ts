import type { PreparedGroundDefinition } from "../io/prepared-ground";
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
export interface GaussianBuffer {
  count: number;
  data: Float32Array;
}
export interface HeightField {
  width: number;
  depth: number;
  spacing: number;
  nx: number;
  nz: number;
  heights: Float32Array;
}
export interface AssetPrototype {
  id: "rock" | "reed";
  synthetic: true;
  radius: number;
  anchor: Vec3;
  supportPoints: Vec3[];
  lods: { full: GaussianBuffer; coarse: GaussianBuffer };
}
export interface Instance {
  id: string;
  assetId: AssetPrototype["id"];
  position: Vec3;
  rotation: Quat;
  scale: number;
  lod: "full" | "coarse";
}
export type GroundArrayKey = "ext0" | "ext1" | "sh1" | "sh2" | "sh3a" | "sh3b";
export type GroundArrays = Record<GroundArrayKey, Uint32Array>;
export interface RiversideGround {
  id: "riverside-ground-v1";
  count: 64949;
  position: Vec3;
  rotation: Quat;
  scale: number;
  // Loaded only for display/export. Preflight stays synchronous and lightweight.
  arrays?: GroundArrays;
}
export interface BuiltScene {
  terrain: GaussianBuffer;
  water: GaussianBuffer | null;
  assets: AssetPrototype[];
  instances: Instance[];
  ground?: RiversideGround | PreparedGround;
}
export interface PreparedGround {
  kind: "prepared";
  definition: PreparedGroundDefinition;
  id: string;
  count: number;
  position: Vec3;
  rotation: Quat;
  scale: number;
  arrays?: GroundArrays;
}
export type PreparedGroundRecipe = Omit<
  F0Recipe,
  "schemaVersion" | "algorithmVersion"
> & {
  schemaVersion: 2;
  algorithmVersion: "f0-prepared-ground-v1";
  ground: { id: string; contentVersion: string };
  plantKind: "low-grass" | "reed";
};
export type SceneRecipe = F0Recipe | PreparedGroundRecipe;
export interface PreparedBuildResult extends Omit<
  BuildResult,
  "recipe" | "report"
> {
  recipe: PreparedGroundRecipe;
  report: Omit<BuildReport, "algorithmVersion"> & {
    algorithmVersion: "f0-prepared-ground-v1";
  };
}
export type SceneBuildResult = BuildResult | PreparedBuildResult;
export type AssetCounts = { rock: number; reed: number };
export type RiverbankVersion = "f0-riverbank-grass-v1" | "f0-riverbank-reed-v1";
export type RiverbankRecipe = F0Recipe & { algorithmVersion: RiverbankVersion };
export interface F0Recipe {
  schemaVersion: 1;
  algorithmVersion:
    | "f0-v1"
    | "f0-shore-v2"
    | "f0-riverside-v1"
    | "f0-riverside-grass-v1"
    | "f0-riverside-grass-v2"
    | "f0-riverside-reed-v1"
    | RiverbankVersion;
  recipeSource: "manual";
  seed: number;
  width: number;
  depth: number;
  spacing: number;
  amplitude: number;
  octaves: number;
  tangentFactor: number;
  normalFactor: number;
  opacity: number;
  waterLevel: number | null;
  requested: AssetCounts;
  lodEnabled: boolean;
}
export interface BuildReport {
  algorithmVersion: F0Recipe["algorithmVersion"];
  requested: AssetCounts;
  accepted: AssetCounts;
  shortfall: AssetCounts;
  rejections: Record<string, number>;
  stageMs: {
    heightfield: number;
    sampling: number;
    assets: number;
    placement: number;
    total: number;
  };
  uniqueSourceSplats: number;
  activeSplats: number;
  cpuBufferBytes: number;
}
export interface BuildResult {
  recipe: F0Recipe;
  scene: BuiltScene;
  heightfield: HeightField;
  report: BuildReport;
}
export interface ViewStats {
  sourceBuffers: number;
  instanceCount: number;
  uniqueSourceSplats: number;
  activeSplats: number;
  ownedBytes: number;
  ground?: { id: string; count: number; shBands: number };
}
export interface SceneSwap {
  activate(): void;
  commit(): void;
  rollback(): void;
}
export interface GaussianView {
  prepareScene(scene: BuiltScene): Promise<SceneSwap>;
  setScene(scene: BuiltScene): Promise<void>;
  cancelPendingScene(): void;
  clearScene(): void;
  isCurrentSceneDisplayed(): boolean;
  removeInstance(id: string): void;
  setLodEnabled(enabled: boolean): void;
  setInteractive(enabled: boolean): void;
  setCameraGuard(guard: ((p: Vec3) => Vec3) | null): void;
  setBackground(hex: number): void;
  getCamera(): { position: Vec3; target: Vec3 };
  gpuInfo(): { renderer: string | null; software: boolean | null };
  setCamera(position: Vec3, target: Vec3): void;
  resize(width: number, height: number, dpr: number): void;
  render(): void;
  stats(): ViewStats;
  // Stops rendering immediately; GPU teardown drains pending sorting. Creating
  // another GaussianView on the same canvas waits for that teardown.
  dispose(): void;
}
