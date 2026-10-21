import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Object3D, Vector3, Quaternion, Color } from "three";
import { createEnvironmentView } from "./view";
import type { EnvironmentAsset } from "./asset";

const state = vi.hoisted(() => ({
  sourceReady: Promise.resolve() as Promise<unknown>,
  meshReady: Promise.resolve() as Promise<unknown>,
  sortReady: Promise.resolve() as Promise<unknown>,
  sorting: false,
  disposalError: null as Error | null,
  sourceDisposalError: null as Error | null,
  arrays: [new Uint32Array(8), new Uint32Array(8)],
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
  deferredSparkDisposal: (_spark: unknown, after: () => void) => {
    let released = false,
      closing = false;
    let work: Promise<void> | undefined;
    return Object.assign(
      () => {
        closing = true;
        return (work ??= state.sortReady.then(() => {
          if (state.disposalError) throw state.disposalError;
          after();
          released = true;
          closing = false;
        }));
      },
      {
        activity: () => ({ busy: state.sorting || closing, released }),
        whenQuiescent: async () => {
          await state.sortReady;
        },
      },
    );
  },
  releaseGeneratorMaterial: vi.fn(),
}));
vi.mock("@sparkjsdev/spark", () => ({
  SplatFileType: { SPZ: "spz" },
  SparkRenderer: class extends Object3D {
    readback32 = new Uint32Array(0);
    orderingTexture = null;
    current = { mapping: [], readback: null, readbackSplats: [] };
    accumulators = [];
    uniforms = {};

    display = {
      get mapping() {
        return state.meshes.map((node) => ({ node, count: 3 }));
      },
      set mapping(_value) {},
    };
  },
  ExtSplats: class {
    initialized = state.sourceReady;
    extArrays = state.arrays;
    extra = {};
    dispose = vi.fn(() => {
      if (state.sourceDisposalError) throw state.sourceDisposalError;
      this.extArrays = [];
    });
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
  state.sortReady = Promise.resolve();
  state.sorting = false;
  state.disposalError = null;
  state.sourceDisposalError = null;
  state.arrays = [new Uint32Array(8), new Uint32Array(8)];
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

test.each(["source", "mesh"] as const)(
  "%s cancellation keeps the real initializer reserved until cleanup",
  async (kind) => {
    const wait = deferred(),
      abort = new AbortController();
    state[kind === "source" ? "sourceReady" : "meshReady"] = wait.promise;
    const input = { ...asset, spz: new Uint8Array(123) };
    const work = view.stage(input, abort.signal).catch(() => {});
    await flush();
    expect(view.residency().buffers).toContain(input.spz.buffer);
    expect(view.residency().extraBytes).toBeGreaterThan(8 * 1024 ** 2);
    abort.abort();
    await work;
    let quiet = false,
      released = false;
    void view.whenQuiescent().then(() => {
      quiet = true;
    });
    view.dispose();
    void view.whenReleased().then(() => {
      released = true;
    });
    await flush();
    expect(view.residency().settled).toBe(false);
    expect(view.residency().buffers).toContain(input.spz.buffer);
    expect(quiet).toBe(false);
    expect(released).toBe(false);
    wait.resolve();
    await view.whenReleased();
    expect(view.residency()).toEqual({
      buffers: [],
      extraBytes: 0,
      settled: true,
    });
  },
);

test("resident source buffers use backing identity and held renderer disposal does not report zero", async () => {
  const shared = new ArrayBuffer(128);
  state.arrays = [
    new Uint32Array(shared, 0, 8),
    new Uint32Array(shared, 32, 8),
  ];
  const input = {
    ...asset,
    spz: new Uint8Array(123),
    transform: {
      scale: 1,
      offset: 0,
      flipY: false,
      flipSource: "metadata" as const,
      policy: "marble-raw-three-v1" as const,
    },
  };
  const stage = await view.stage(input, new AbortController().signal);
  stage.commit();
  expect(view.residency().buffers.filter((b) => b === shared)).toHaveLength(1);
  expect(view.residency().buffers).toContain(input.spz.buffer);
  const wait = deferred();
  state.sortReady = wait.promise;
  state.sorting = true;
  view.dispose();
  let released = false;
  const release = view.whenReleased().then(() => {
    released = true;
  });
  await flush();
  expect(released).toBe(false);
  expect(view.residency().extraBytes).toBeGreaterThanOrEqual(8 * 1024 ** 2);
  expect(view.residency().settled).toBe(false);
  state.sorting = false;
  wait.resolve();
  await release;
  expect(view.residency()).toEqual({
    buffers: [],
    extraBytes: 0,
    settled: true,
  });
});

test("a failed renderer disposal rejects release and keeps its reservation visible", async () => {
  state.disposalError = Error("GPU cleanup failure");
  view.dispose();
  let failure: unknown;
  void view.whenReleased().catch((error) => {
    failure = error;
  });
  await flush();
  expect(failure).toBe(state.disposalError);
  await expect(view.whenQuiescent()).rejects.toThrow("GPU cleanup failure");
  expect(view.residency().extraBytes).toBeGreaterThanOrEqual(8 * 1024 ** 2);
});

test("a late source cleanup failure terminates release and keeps the failed owner", async () => {
  const wait = deferred(),
    abort = new AbortController();
  state.sourceReady = wait.promise;
  const input = { ...asset, spz: new Uint8Array(123) };
  const work = view.stage(input, abort.signal).catch(() => {});
  await flush();
  abort.abort();
  await work;
  view.dispose();
  let failure: unknown;
  void view.whenReleased().catch((error) => {
    failure = error;
  });
  state.sourceDisposalError = Error("late source cleanup failure");
  wait.resolve();
  await flush();
  expect(failure).toBe(state.sourceDisposalError);
  await expect(view.whenQuiescent()).rejects.toThrow(
    "late source cleanup failure",
  );
  expect(view.residency().buffers).toContain(input.spz.buffer);
  expect(view.residency().extraBytes).toBeGreaterThan(0);
});

test("synchronous source cleanup failure becomes a failed release without erasing residency", async () => {
  const input = {
    ...asset,
    spz: new Uint8Array(123),
    transform: {
      scale: 1,
      offset: 0,
      flipY: false,
      flipSource: "metadata" as const,
      policy: "marble-raw-three-v1" as const,
    },
  };
  const stage = await view.stage(input, new AbortController().signal);
  stage.commit();
  state.sourceDisposalError = Error("source cleanup failure");
  expect(() => view.dispose()).not.toThrow();
  let failure: unknown;
  void view.whenReleased().catch((error) => {
    failure = error;
  });
  await flush();
  expect(failure).toBe(state.sourceDisposalError);
  await expect(view.whenQuiescent()).rejects.toThrow("source cleanup failure");
  expect(view.residency().buffers).toContain(input.spz.buffer);
});
