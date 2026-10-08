import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Object3D, Vector3, Quaternion, Color } from "three";
import { createEnvironmentView } from "./view";
import type { EnvironmentAsset } from "./asset";

const state = vi.hoisted(() => ({
  sourceReady: Promise.resolve() as Promise<unknown>,
  meshReady: Promise.resolve() as Promise<unknown>,
  sources: [] as { dispose: ReturnType<typeof vi.fn> }[],
  meshes: [] as { dispose: ReturnType<typeof vi.fn> }[],
}));
vi.mock("three", async (original) => ({
  ...(await original<typeof import("three")>()),
  WebGLRenderer: class {
    dispose = vi.fn();
    render = vi.fn();
    setPixelRatio = vi.fn();
    setSize = vi.fn();
  },
}));
vi.mock("three/addons/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    target = new Vector3();
    dispose = vi.fn();
    update = vi.fn();
  },
}));
vi.mock("../gaussian/spark-lifecycle", () => ({
  deferredSparkDisposal: (_spark: unknown, after: () => void) => async () =>
    after(),
  releaseGeneratorMaterial: vi.fn(),
}));
vi.mock("@sparkjsdev/spark", () => ({
  SplatFileType: { SPZ: "spz" },
  SparkRenderer: class extends Object3D {
    display = {
      get mapping() {
        return state.meshes.map((node) => ({ node, count: 3 }));
      },
    };
  },
  ExtSplats: class {
    initialized = state.sourceReady;
    dispose = vi.fn();
    getNumSplats = () => 3;
    getNumSh = () => 3;
    getSplat = () => ({ center: new Vector3() });
    forEachSplat = (visit: (...args: unknown[]) => void) =>
      visit(
        0,
        new Vector3(),
        new Vector3(1, 1, 1),
        new Quaternion(),
        1,
        new Color(),
      );
    constructor() {
      state.sources.push(this);
    }
  },
  SplatMesh: class extends Object3D {
    initialized = state.meshReady;
    dispose = vi.fn();
    constructor() {
      super();
      state.meshes.push(this);
    }
  },
}));

const deferred = () => {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const asset = {
  spz: new Uint8Array(),
  splats: { count: 3, shDegree: 3 },
} as EnvironmentAsset;
let view: ReturnType<typeof createEnvironmentView>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("devicePixelRatio", 1);
  state.sources = [];
  state.meshes = [];
  state.sourceReady = Promise.resolve();
  state.meshReady = Promise.resolve();
  view = createEnvironmentView(
    Object.assign(new EventTarget(), {
      width: 1,
      height: 1,
      getBoundingClientRect: () => ({ width: 1, height: 1 }),
    }) as HTMLCanvasElement,
    vi.fn(),
  );
});

test("a ready preview can still be saved after the loading deadline", async () => {
  const stage = await view.stage(
    {
      ...asset,
      transform: {
        scale: 1,
        offset: 0,
        flipY: true,
        flipSource: "metadata",
        policy: "marble-raw-three-v1",
      },
    },
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(11000);
  expect(stage.usable()).toBe(true);
  expect(() => stage.commit()).not.toThrow();
  expect(view.diagnostics().sources).toBe(1);
});
afterEach(() => {
  view.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each(["source", "mesh"] as const)(
  "%s initialization shares the 10-second deadline and frees late results",
  async (kind) => {
    const wait = deferred();
    state[kind === "source" ? "sourceReady" : "meshReady"] = wait.promise;
    let error: unknown;
    const work = view.stage(asset, new AbortController().signal).catch((e) => {
      error = e;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(10001);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/超时/);
    expect(state.sources[0].dispose).toHaveBeenCalledTimes(1);
    if (kind === "mesh")
      expect(state.meshes[0].dispose).toHaveBeenCalledTimes(1);
    wait.resolve();
    await flush();
    await work;
    expect(state.sources[0].dispose).toHaveBeenCalledTimes(2);
    if (kind === "mesh")
      expect(state.meshes[0].dispose).toHaveBeenCalledTimes(2);
    else expect(state.meshes).toHaveLength(0);
    expect(view.diagnostics().sources).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(["abort", "dispose", "replace"] as const)(
  "%s stops a stalled decoder promptly; late rejection stays contained",
  async (action) => {
    const wait = deferred(),
      abort = new AbortController();
    state.sourceReady = wait.promise;
    let error: unknown;
    const work = view.stage(asset, abort.signal).catch((e) => {
      error = e;
    });
    const next = new AbortController();
    let nextWork: Promise<unknown> | undefined;
    if (action === "abort") abort.abort();
    if (action === "dispose") view.dispose();
    if (action === "replace")
      nextWork = view.stage(asset, next.signal).catch(() => {});
    await flush();
    expect(error).toMatchObject({ name: "AbortError" });
    expect(state.sources[0].dispose).toHaveBeenCalledTimes(1);
    next.abort();
    await flush();
    wait.reject(Error("late decoder failure"));
    await flush();
    await work;
    await nextWork;
    expect(state.sources[0].dispose).toHaveBeenCalledTimes(2);
    expect(state.meshes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
