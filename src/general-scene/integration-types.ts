import type { SceneSnapshot } from "./contracts";
import type { SceneController, Residency } from "./controller";
import type { SceneStore } from "./storage";
import type { CatalogView } from "./asset-library";
import type { PlanningRequest, PlanningOutcome } from "./planner";
import type { CameraState, Issue, Result } from "./core";
export type GeneralSceneMetadata = Pick<
  SceneSnapshot,
  | "sceneId"
  | "revisionId"
  | "parentRevisionId"
  | "capability"
  | "intent"
  | "plan"
  | "state"
  | "instances"
  | "assets"
  | "surfaceStyle"
  | "quality"
  | "reviewStatus"
  | "camera"
  | "patch"
  | "geometryDigest"
  | "validation"
> & {
  access: "editable" | "readonly";
  issues: readonly Issue[];
};
export type GeneralWorkbenchController = SceneController & {
  planManual(request: PlanningRequest): Promise<PlanningOutcome>;
  importFile(file: File): ReturnType<SceneController["importArchive"]>;
  listScenes(): ReturnType<SceneStore["list"]>;
  catalog(signal: AbortSignal): Promise<CatalogView>;
  metadata(): Promise<GeneralSceneMetadata | null>;
  downloadArchive(mode: "embedded" | "reference"): Promise<Result<void>>;
  downloadOriginal(file: File): Promise<Result<void>>;
};
export type GeneralPanelPorts = {
  controller: GeneralWorkbenchController;
  enterMode(): boolean;
  leaveMode(): void;
  subscribeMode(listener: (mode: WorkbenchMode) => void): () => void;
};
export type WorkbenchMode = "legacy" | "general" | "environment";
export type LegacyPorts = {
  viewerHost: HTMLElement;
  canSwitch(): boolean;
  cancelPending(): void;
  pause(): void;
  resume(): void;
  getCamera(): CameraState;
  setCamera(camera: CameraState): void;
  residency(): Residency;
  whenQuiescent(): Promise<void>;
  closeEnvironment(): void;
  changed(mode: WorkbenchMode): void;
};
