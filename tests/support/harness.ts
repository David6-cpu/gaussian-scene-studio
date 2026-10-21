import { createGaussianView } from "../../src/gaussian/view";
import { makeSharedFixture, defaultTestRecipe } from "./fixtures";
import { makeHeightField } from "../../src/terrain/heightfield";
import { makeSyntheticAssets } from "../../src/assets/synthetic";
import { placeAssets } from "../../src/assets/placement";
import { sampleTerrain } from "../../src/terrain/sampling";
import type { GaussianView } from "../../src/gaussian/types";
import { sparkProbe } from "./spark-observer";
import { SparkRenderer } from "@sparkjsdev/spark";
type FirstFrameSample = {
  serial: number;
  startedAt: number;
  completedAt: number;
  phase: string | null;
  domPhase: string | null;
  useDisabled: boolean | null;
  defaultFramebuffer: boolean;
  mapping: { uuid: string; count: number }[];
  activeSplats: number;
  viewport: number[];
  clientSize: number[];
  drawingSize: number[];
  pixelRect: number[] | null;
  rgba: number[] | null;
  nonBlackPixels: number | null;
  greenPixels: number | null;
  error: string | null;
};
type FirstFrameObservation = {
  armedAt: number | null;
  stoppedAt: number | null;
  stopReason: "first-preview" | "frame-limit" | "time-limit" | null;
  maxFrames: number;
  maxMilliseconds: number;
  samples: FirstFrameSample[];
  firstPreview: {
    time: number;
    phase: string;
    sceneId: string;
    revisionId: string;
    operationId: string;
    latestNativeDrawSerial: number | null;
    domPhase: string | null;
    useDisabledAtNotification: boolean | null;
    useDisabledAfterNotification: boolean | null;
    afterNotificationAt: number | null;
    draw: FirstFrameSample | null;
  } | null;
};
declare global {
  interface Window {
    currentScene: import("../../src/gaussian/types").BuiltScene;
    testView: GaussianView;
    fixture: typeof makeSharedFixture;
    ready: boolean;
    failure?: string;
    sparkProbe: typeof sparkProbe;
    createTestView: typeof createGaussianView;
    generalFirstFrameProbe?: {
      arm(): void;
      snapshot(): FirstFrameObservation;
    };
  }
}
if (new URLSearchParams(location.search).has("workbench")) {
  document.body.innerHTML = '<div id="app"></div>';
  window.sparkProbe = sparkProbe;
  // Opt-in diagnostic only. This does not drive rendering, change the camera,
  // change the framebuffer, or read pixels from a discarded canvas buffer.
  const probeEnabled = new URLSearchParams(location.search).has(
    "firstFrameProbe",
  );
  const observation: FirstFrameObservation = {
    armedAt: null,
    stoppedAt: null,
    stopReason: null,
    maxFrames: 30,
    maxMilliseconds: 3000,
    samples: [],
    firstPreview: null,
  };
  let probeTimer: number | undefined;
  let controllerPhase: string | null = null;
  const domPhase = () =>
    document.querySelector<HTMLElement>("#general-status")?.dataset.phase ??
    null;
  const useDisabled = () =>
    document.querySelector<HTMLButtonElement>("#general-use")?.disabled ?? null;
  function stopProbe(reason: FirstFrameObservation["stopReason"]) {
    if (observation.stoppedAt !== null) return;
    observation.stoppedAt = performance.now();
    observation.stopReason = reason;
    window.clearTimeout(probeTimer);
  }
  function observeFirstFrame(spark: SparkRenderer, serial: number) {
    if (
      !probeEnabled ||
      observation.armedAt === null ||
      observation.stoppedAt !== null
    )
      return;
    const startedAt = performance.now();
    if (startedAt - observation.armedAt >= observation.maxMilliseconds) {
      stopProbe("time-limit");
      return;
    }
    if (observation.samples.length >= observation.maxFrames) {
      stopProbe("frame-limit");
      return;
    }
    const renderer = spark.renderer;
    const canvas = renderer.domElement;
    const gl = renderer.getContext();
    const sample: FirstFrameSample = {
      serial,
      startedAt,
      completedAt: startedAt,
      phase: controllerPhase,
      domPhase: domPhase(),
      useDisabled: useDisabled(),
      defaultFramebuffer: false,
      mapping: spark.display.mapping.map(({ node, count }) => ({
        uuid: node.uuid,
        count,
      })),
      activeSplats: spark.activeSplats,
      viewport: [],
      clientSize: [canvas.clientWidth, canvas.clientHeight],
      drawingSize: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      pixelRect: null,
      rgba: null,
      nonBlackPixels: null,
      greenPixels: null,
      error: null,
    };
    try {
      sample.viewport = Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array);
      const readFramebufferBinding = (gl as WebGL2RenderingContext)
        .READ_FRAMEBUFFER_BINDING;
      sample.defaultFramebuffer =
        renderer.getRenderTarget() === null &&
        gl.getParameter(gl.FRAMEBUFFER_BINDING) === null &&
        typeof readFramebufferBinding === "number" &&
        gl.getParameter(readFramebufferBinding) === null;
      if (sample.defaultFramebuffer && !gl.isContextLost()) {
        const width = Math.min(16, gl.drawingBufferWidth);
        const height = Math.min(16, gl.drawingBufferHeight);
        if (width > 0 && height > 0) {
          const x = Math.floor((gl.drawingBufferWidth - width) / 2);
          const y = Math.floor((gl.drawingBufferHeight - height) / 2);
          const pixels = new Uint8Array(width * height * 4);
          // Synchronous GPU readback can affect timing: this is not a performance measurement.
          gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          sample.pixelRect = [x, y, width, height];
          sample.rgba = Array.from(pixels);
          sample.nonBlackPixels = 0;
          sample.greenPixels = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const [r, g, b] = pixels.subarray(i, i + 3);
            if (r + g + b > 12) sample.nonBlackPixels++;
            if (g > 12 && g > r + 4 && g > b + 4) sample.greenPixels++;
          }
        }
      }
    } catch (error) {
      sample.error = String(error);
    }
    sample.completedAt = performance.now();
    observation.samples.push(sample);
    // A preview notification in this same frame may still use the final sample.
    // Sampling stops immediately at the limit; it never starts another RAF.
    if (observation.samples.length >= observation.maxFrames)
      stopProbe("frame-limit");
  }
  // Read-only observation after Spark's real WebGL draw, matching the general transaction harness.
  // No render calls, scene setters or success receipts are exposed by this observer.
  const draws = new Map<
    string,
    {
      serial: number;
      nodes: { uuid: string; count: number; matrixWorld: number[] }[];
    }
  >();
  const afterSpark = SparkRenderer.prototype.onAfterRender;
  SparkRenderer.prototype.onAfterRender = function (...args) {
    afterSpark.apply(this, args);
    const canvas = this.renderer.domElement;
    const id =
      canvas.id || canvas.getAttribute("aria-label") || "unlabelled-canvas";
    draws.set(id, {
      serial: (draws.get(id)?.serial ?? 0) + 1,
      nodes: this.display.mapping.map(({ node, count }) => ({
        uuid: node.uuid,
        count,
        matrixWorld: node.matrixWorld.toArray(),
      })),
    });
    if (id === "general-scene-canvas")
      observeFirstFrame(this, draws.get(id)!.serial);
  };
  Object.defineProperty(window, "workbenchSparkDrawObservation", {
    value: Object.freeze({
      snapshot: () => structuredClone(Object.fromEntries(draws)),
    }),
  });
  const { workbench } = await import("../../src/main");
  (window as any).workbench = workbench;
  if (probeEnabled) {
    workbench.general.panelPorts.controller.subscribe((state) => {
      controllerPhase = state.phase;
      if (
        observation.armedAt === null ||
        observation.firstPreview !== null ||
        state.phase !== "previewing"
      )
        return;
      const time = performance.now();
      if (time - observation.armedAt >= observation.maxMilliseconds) {
        stopProbe("time-limit");
        return;
      }
      const latest = observation.samples.at(-1) ?? null;
      const first = {
        time,
        phase: state.phase,
        sceneId: state.candidate.sceneId,
        revisionId: state.candidate.revisionId,
        operationId: state.operation.operationId,
        latestNativeDrawSerial:
          draws.get("general-scene-canvas")?.serial ?? null,
        domPhase: domPhase(),
        useDisabledAtNotification: useDisabled(),
        useDisabledAfterNotification: null,
        afterNotificationAt: null,
        draw: latest ? structuredClone(latest) : null,
      } satisfies NonNullable<FirstFrameObservation["firstPreview"]>;
      observation.firstPreview = first;
      stopProbe("first-preview");
      // Subscriber ordering may leave the DOM one synchronous listener behind.
      // Record the same turn after notification separately, without another frame.
      queueMicrotask(() => {
        observation.firstPreview!.useDisabledAfterNotification = useDisabled();
        observation.firstPreview!.afterNotificationAt = performance.now();
      });
    });
    Object.defineProperty(window, "generalFirstFrameProbe", {
      value: Object.freeze({
        arm() {
          if (observation.armedAt !== null)
            throw Error("First-frame probe already armed");
          observation.armedAt = performance.now();
          probeTimer = window.setTimeout(
            () => stopProbe("time-limit"),
            observation.maxMilliseconds,
          );
        },
        snapshot: () => structuredClone(observation),
      }),
    });
  }
} else
  try {
    window.sparkProbe = sparkProbe;
    window.createTestView = createGaussianView;
    const view = await createGaussianView(document.querySelector("canvas")!);
    window.testView = view;
    window.fixture = makeSharedFixture;
    view.resize(1280, 720, 1);
    view.setCamera([0, 0, 8], [0, 0, 0]);
    const params = new URLSearchParams(location.search),
      assetMode = params.has("assets"),
      terrainMode = assetMode || params.has("terrain");
    const field = makeHeightField(defaultTestRecipe),
      assets = assetMode ? makeSyntheticAssets() : [],
      count = Number(params.get("count") ?? 20);
    const recipe = {
      ...defaultTestRecipe,
      requested: { rock: Math.ceil(count / 2), reed: Math.floor(count / 2) },
    };
    window.currentScene = terrainMode
      ? {
          ...sampleTerrain(field, recipe),
          assets,
          instances: assetMode
            ? placeAssets(field, recipe, assets).instances
            : [],
        }
      : makeSharedFixture();
    await view.setScene(window.currentScene);
    view.setLodEnabled(assetMode);
    function tick() {
      window.testView.render();
      requestAnimationFrame(tick);
    }
    tick();
    window.ready = true;
  } catch (e) {
    window.failure = String(e);
    document.body.append(String(e));
  }
