import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { Object3D, Vector3 } from "three";
import { createGaussianView } from "./view";
import {
  sparkRendererBudget,
  sparkSceneCapacity,
  SPARK_BUDGET_OPTIONS,
} from "./spark-budget";
import { preparedFixture } from "../../tests/support/prepared-fixture";
import type { GaussianView, BuiltScene } from "./types";
import { assertGaussianBuffer, countSplats } from "./validate";
import { single, makeSharedFixture } from "../../tests/support/fixtures";
test("accepts a finite anisotropic Gaussian with normalized xyzw", () =>
  expect(() => assertGaussianBuffer(single())).not.toThrow());
test.each([
  [3, 0],
  [4, -0.1],
  [0, NaN],
  [9, 2],
  [10, 2],
  [13, -0.1],
])("rejects invalid field %i=%s", (i, v) => {
  const b = single();
  b.data[i] = v;
  expect(() => assertGaussianBuffer(b)).toThrow(/Gaussian/);
});
test("rejects mismatched count and buffer length", () => {
  const b = single();
  b.count = 2;
  expect(() => assertGaussianBuffer(b)).toThrow(/length/);
});
test("counts shared resident sources once but each active instance", () =>
  expect(countSplats(makeSharedFixture())).toEqual({
    uniqueSourceSplats: 2,
    activeSplats: 4,
  }));

// Hold real asynchronous boundaries; use the production Spark disposal adapter.
const state = vi.hoisted(() => ({
  sourceReady: Promise.resolve() as Promise<unknown>,
  meshReady: Promise.resolve() as Promise<unknown>,
  sortReady: Promise.resolve() as Promise<unknown>,
  meshReadyQueue: [] as Promise<unknown>[],
  sparks: [] as any[],
  sources: [] as any[],
  meshes: [] as any[],
  controls: [] as any[],
  rendererDisposals: 0,
  validationReady: Promise.resolve() as Promise<unknown>,
  validationEntered: () => {},
}));
vi.mock("../io/prepared-ground", async (original) => {
  const actual = await original<typeof import("../io/prepared-ground")>();
  return {
    ...actual,
    async validatePreparedArrays(
      ...args: Parameters<typeof actual.validatePreparedArrays>
    ) {
      state.validationEntered();
      await state.validationReady;
      return actual.validatePreparedArrays(...args);
    },
  };
});
vi.mock("three", async (original) => ({
  ...(await original<typeof import("three")>()),
  WebGLRenderer: class {
    outputColorSpace = "";
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {
      state.rendererDisposals++;
    }
    getContext() {
      return { getExtension: () => null, isContextLost: () => false };
    }
  },
}));
vi.mock("three/addons/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    target = new Vector3();
    enabled = false;
    constructor() {
      state.controls.push(this);
    }
    update() {}
    dispose = vi.fn();
  },
}));
vi.mock("@sparkjsdev/spark", async (original) => ({
  ...(await original<typeof import("@sparkjsdev/spark")>()),
  PackedSplats: class {
    initialized: Promise<unknown>;
    packedArray: Uint32Array | null = null;
    extra = {};
    numSplats = 0;
    dispose = vi.fn(() => {
      this.packedArray = null;
    });
    constructor(options: { maxSplats: number }) {
      state.sources.push(this);
      this.initialized = state.sourceReady.then(() => {
        this.packedArray = new Uint32Array(
          Math.ceil(options.maxSplats / 2048) * 2048 * 4,
        );
      });
    }
    pushSplat() {
      this.numSplats++;
    }
  },
  ExtSplats: class {
    initialized: Promise<unknown>;
    extArrays: [Uint32Array, Uint32Array];
    extra: Record<string, unknown>;
    numSplats: number;
    dispose = vi.fn(() => {
      this.extArrays = [new Uint32Array(), new Uint32Array()];
      this.extra = {};
    });
    constructor(options: {
      extArrays: [Uint32Array, Uint32Array];
      extra: Record<string, unknown>;
      numSplats: number;
    }) {
      this.extArrays = options.extArrays;
      this.extra = options.extra;
      this.numSplats = options.numSplats;
      this.initialized = state.sourceReady;
      state.sources.push(this);
    }
    getNumSh() {
      return 3;
    }
  },
  SplatMesh: class extends Object3D {
    initialized: Promise<unknown>;
    numSplats: number;
    packedSplats: any;
    splats: any;
    generator: object | undefined;
    dispose = vi.fn();
    constructor(options: { packedSplats?: any; extSplats?: any }) {
      super();
      this.packedSplats = this.splats =
        options.packedSplats ?? options.extSplats;
      this.numSplats = this.splats.numSplats;
      const ready = state.meshReadyQueue.shift() ?? state.meshReady;
      this.initialized = ready.then(() => {
        this.generator = {};
      });
      state.meshes.push(this);
    }
  },
  SplatAccumulator: class {
    static generatorProgram = new WeakMap();
    static fullScreenQuad = { material: null };
  },
  SparkRenderer: class extends Object3D {
    options: unknown;
    readback32 = new Uint32Array(2048);
    orderingTexture: any = { image: { data: new Uint32Array(16384) } };
    uniforms = {
      ordering: { value: this.orderingTexture },
      extSplats: { value: {} },
      extSplats2: { value: {} },
    };
    display = { mapping: [] as any[] };
    current = this.display;
    accumulators: any[] = [];
    sorting = false;
    sortDirty = false;
    autoUpdate = true;
    updateTimeoutId: ReturnType<typeof setTimeout> | undefined;
    sortTimeoutId: ReturnType<typeof setTimeout> | undefined;
    dispose = vi.fn(() => {
      this.orderingTexture = null;
    });
    constructor(options: unknown) {
      super();
      this.options = options;
      state.sparks.push(this);
    }
    async driveSort() {
      this.sorting = true;
      await state.sortReady;
      this.sorting = false;
    }
  },
}));
const deferred = () => {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const sceneOf = (data = single()): BuiltScene => ({
  terrain: data,
  water: null,
  assets: [],
  instances: [],
});
let view: GaussianView;
let canvas: HTMLCanvasElement;
beforeEach(async () => {
  state.sourceReady = state.meshReady = state.sortReady = Promise.resolve();
  state.meshReadyQueue = [];
  state.sparks = [];
  state.sources = [];
  state.meshes = [];
  state.controls = [];
  state.rendererDisposals = 0;
  state.validationReady = Promise.resolve();
  state.validationEntered = () => {};
  canvas = {} as HTMLCanvasElement;
  view = await createGaussianView(canvas);
});
afterEach(async () => {
  view.dispose();
  if (view.whenReleased) await view.whenReleased();
});

test("cancel keeps all input backings and source ownership until held initialization finishes", async () => {
  const held = deferred(),
    input = sceneOf();
  state.sourceReady = held.promise;
  const work = view.prepareScene(input);
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  view.cancelPendingScene();
  try {
    expect(view.residency().settled).toBe(false);
    expect(view.residency().buffers).toContain(input.terrain.data.buffer);
    let done = false;
    const quiet = view.whenQuiescent().then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    expect(state.sources[0].dispose).not.toHaveBeenCalled();
    held.resolve();
    await rejected;
    await quiet;
    expect(view.residency().settled).toBe(true);
    expect(view.residency().buffers).not.toContain(input.terrain.data.buffer);
    expect(state.sources[0].packedArray).toBeNull();
  } finally {
    held.resolve();
    await rejected;
  }
});

test("disposal waits for both held source initialization and real sort terminal cleanup", async () => {
  const source = deferred(),
    sort = deferred(),
    input = sceneOf();
  state.sourceReady = source.promise;
  state.sortReady = sort.promise;
  const work = view.prepareScene(input);
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  const spark = state.sparks[0],
    sorting = spark.driveSort();
  view.dispose();
  try {
    expect(view.residency().settled).toBe(false);
    expect(view.residency().buffers).toContain(input.terrain.data.buffer);
    expect(view.residency().extraBytes).toBeGreaterThan(0);
    const released = view.whenReleased();
    expect(view.whenReleased()).toBe(released);
    let done = false;
    void released.then(() => {
      done = true;
    });
    sort.resolve();
    await sorting;
    await flush();
    expect(done).toBe(false);
    expect(view.residency().extraBytes).toBeGreaterThan(0);
    source.resolve();
    await rejected;
    await released;
    expect(view.residency()).toEqual({
      buffers: [],
      extraBytes: 0,
      settled: true,
    });
    expect(spark.readback32.byteLength).toBe(0);
    expect(spark.uniforms.ordering.value).toBeNull();
    expect(state.rendererDisposals).toBe(1);
  } finally {
    source.resolve();
    sort.resolve();
    await rejected;
    await sorting;
  }
});

test("CPU identities, padded per-generator renderer capacity and source GPU reserve are counted once", async () => {
  const input = makeSharedFixture();
  await view.setScene(input);
  const resident = view.residency(),
    source = state.sources[0],
    spark = state.sparks[0];
  expect(resident.settled).toBe(true);
  expect(new Set(resident.buffers).size).toBe(resident.buffers.length);
  expect(
    resident.buffers.filter((b) => b === input.assets[0].lods.full.data.buffer),
  ).toHaveLength(1);
  expect(resident.buffers).toContain(source.packedArray.buffer);
  expect(resident.buffers).toContain(spark.readback32.buffer);
  expect(resident.buffers).toContain(spark.orderingTexture.image.data.buffer);
  const total =
    resident.buffers.reduce((n, b) => n + b.byteLength, 0) +
    resident.extraBytes;
  expect(total).toBe(
    input.assets[0].lods.full.data.byteLength +
      source.packedArray.byteLength * 2 +
      sparkRendererBudget(sparkSceneCapacity([2, 2])).reservedBytes,
  );
  expect(spark.options).toMatchObject(SPARK_BUDGET_OPTIONS);
});

test("quiescence observes a real sort without disposing the current scene", async () => {
  await view.setScene(sceneOf());
  const held = deferred();
  state.sortReady = held.promise;
  const sorting = state.sparks[0].driveSort();
  try {
    expect(view.residency().settled).toBe(false);
    let quiet = false;
    const work = view.whenQuiescent().then(() => {
      quiet = true;
    });
    await flush();
    expect(quiet).toBe(false);
    held.resolve();
    await sorting;
    await work;
    expect(view.residency().settled).toBe(true);
    expect(view.stats().activeSplats).toBe(1);
    expect(state.sparks[0].dispose).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    await sorting;
  }
});

test("pending and rollback parents remain counted and camera restoration stays exact", async () => {
  const parent = sceneOf(),
    candidate = sceneOf();
  await view.setScene(parent);
  view.setCamera([3, 4, 5], [0, 1, 0]);
  const swap = await view.prepareScene(candidate);
  expect(view.residency().buffers).toContain(parent.terrain.data.buffer);
  expect(view.residency().buffers).toContain(candidate.terrain.data.buffer);
  swap.activate();
  view.setCamera([9, 9, 9], [0, 0, 0]);
  expect(view.residency().buffers).toContain(parent.terrain.data.buffer);
  swap.rollback();
  expect(view.getCamera()).toEqual({ position: [3, 4, 5], target: [0, 1, 0] });
  expect(view.residency().buffers).toContain(parent.terrain.data.buffer);
  expect(view.residency().buffers).not.toContain(candidate.terrain.data.buffer);
  const replacement = await view.prepareScene(candidate);
  replacement.activate();
  replacement.commit();
  expect(view.residency().buffers).not.toContain(parent.terrain.data.buffer);
  expect(view.residency().buffers).toContain(candidate.terrain.data.buffer);
  view.clearScene();
  expect(view.residency().buffers).not.toContain(candidate.terrain.data.buffer);
  // Holding closed swap handles cannot keep their source/prototype maps alive.
  swap.rollback();
  replacement.rollback();
});

test("a failed mesh leaves later initialization resident and disposes late generated objects", async () => {
  const first = deferred(),
    second = deferred(),
    input = makeSharedFixture();
  state.meshReadyQueue = [first.promise, second.promise];
  const work = view.prepareScene(input);
  const rejected = expect(work).rejects.toThrow("first mesh failed");
  await flush();
  expect(state.meshes).toHaveLength(2);
  first.reject(Error("first mesh failed"));
  await rejected;
  try {
    expect(view.residency().settled).toBe(false);
    expect(view.residency().buffers).toContain(
      input.assets[0].lods.full.data.buffer,
    );
    let quiet = false;
    const waiting = view.whenQuiescent().then(() => {
      quiet = true;
    });
    await flush();
    expect(quiet).toBe(false);
    second.resolve();
    await waiting;
    expect(state.meshes[1].dispose).toHaveBeenCalledTimes(2);
    expect(view.residency().settled).toBe(true);
    expect(view.residency().buffers).not.toContain(
      input.assets[0].lods.full.data.buffer,
    );
  } finally {
    second.resolve();
    await flush();
  }
});

test("retains renderer high-water after smaller scenes and clear until release", async () => {
  await view.setScene(makeSharedFixture());
  const high = sparkRendererBudget(sparkSceneCapacity([2, 2])).reservedBytes;
  await view.setScene(sceneOf());
  view.clearScene();
  const r = view.residency();
  expect(r.buffers.reduce((n, b) => n + b.byteLength, 0) + r.extraBytes).toBe(
    high,
  );
  let released = false;
  const waiting = view.whenReleased().then(() => {
    released = true;
  });
  await flush();
  expect(released).toBe(false);
  expect(state.sparks[0].dispose).not.toHaveBeenCalled();
  view.dispose();
  await waiting;
  expect(view.residency()).toEqual({
    buffers: [],
    extraBytes: 0,
    settled: true,
  });
});

test("SH3 input and ExtSplats shared CPU arrays are counted once with separate source textures", async () => {
  const f = await preparedFixture(),
    d = f.asset.definition;
  const input: BuiltScene = {
    terrain: { count: 0, data: new Float32Array() },
    water: null,
    assets: [],
    instances: [],
    ground: {
      kind: "prepared",
      definition: d,
      id: d.metadata.id,
      count: d.count,
      position: [
        d.display.position[0],
        d.display.position[1],
        d.display.position[2],
      ],
      rotation: [
        d.display.quaternionXYZW[0],
        d.display.quaternionXYZW[1],
        d.display.quaternionXYZW[2],
        d.display.quaternionXYZW[3],
      ],
      scale: d.display.uniformScale,
      arrays: f.asset.arrays,
    },
  };
  await view.setScene(input);
  const resident = view.residency(),
    arrays = Object.values(f.asset.arrays);
  for (const a of arrays)
    expect(resident.buffers.filter((b) => b === a.buffer)).toHaveLength(1);
  const bytes = arrays.reduce((n, a) => n + a.byteLength, 0);
  expect(
    resident.buffers.reduce((n, b) => n + b.byteLength, 0) +
      resident.extraBytes,
  ).toBe(
    bytes * 2 +
      sparkRendererBudget(sparkSceneCapacity([d.count])).reservedBytes,
  );
  const swap = await view.prepareScene(sceneOf());
  swap.activate();
  swap.rollback();
  for (const a of arrays) expect(view.residency().buffers).toContain(a.buffer);
  view.clearScene();
  for (const a of arrays)
    expect(view.residency().buffers).not.toContain(a.buffer);
  expect(
    state.sources[0].extArrays.every((a: Uint32Array) => a.byteLength === 0),
  ).toBe(true);
  swap.rollback();
});

test("same-canvas replacement waits for late old initialization as well as renderer disposal", async () => {
  const held = deferred();
  state.sourceReady = held.promise;
  const work = view.prepareScene(sceneOf());
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  view.dispose();
  const replacement = createGaussianView(canvas);
  try {
    await flush();
    expect(state.sparks).toHaveLength(1);
    held.resolve();
    await rejected;
    const next = await replacement;
    expect(state.sparks).toHaveLength(2);
    next.dispose();
    await next.whenReleased();
  } finally {
    held.resolve();
    await rejected;
    const next = await replacement;
    next.dispose();
    await next.whenReleased();
  }
});

test("resolver-loaded SH3 buffers stay resident while asynchronous validation is held after cancellation", async () => {
  const f = await preparedFixture(),
    d = f.asset.definition,
    held = deferred(),
    entered = deferred();
  state.validationReady = held.promise;
  state.validationEntered = entered.resolve;
  const loading = await createGaussianView({} as HTMLCanvasElement, {
    loadPreparedGround: async () => f.asset,
  });
  const input: BuiltScene = {
    terrain: { count: 0, data: new Float32Array() },
    water: null,
    assets: [],
    instances: [],
    ground: {
      kind: "prepared",
      definition: d,
      id: d.metadata.id,
      count: d.count,
      position: [
        d.display.position[0],
        d.display.position[1],
        d.display.position[2],
      ],
      rotation: [
        d.display.quaternionXYZW[0],
        d.display.quaternionXYZW[1],
        d.display.quaternionXYZW[2],
        d.display.quaternionXYZW[3],
      ],
      scale: d.display.uniformScale,
    },
  };
  const work = loading.prepareScene(input);
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  try {
    await entered.promise;
    loading.cancelPendingScene();
    expect(loading.residency().settled).toBe(false);
    for (const a of Object.values(f.asset.arrays))
      expect(loading.residency().buffers).toContain(a.buffer);
    loading.dispose();
    const released = loading.whenReleased();
    let done = false;
    void released.then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    held.resolve();
    await rejected;
    await released;
    expect(loading.residency()).toEqual({
      buffers: [],
      extraBytes: 0,
      settled: true,
    });
  } finally {
    held.resolve();
    await rejected;
    loading.dispose();
    await loading.whenReleased();
  }
});

test("subarray sources report full backing identity rather than only the visible byte range", async () => {
  const input = makeSharedFixture(),
    original = input.assets[0].lods.full.data;
  const backing = new ArrayBuffer(4096),
    slice = new Float32Array(backing, 128, original.length);
  slice.set(original);
  input.assets[0].lods.full.data = slice;
  await view.setScene(input);
  const resident = view.residency();
  expect(resident.buffers.filter((b) => b === backing)).toHaveLength(1);
  expect(
    resident.buffers.reduce((n, b) => n + b.byteLength, 0) +
      resident.extraBytes,
  ).toBe(
    4096 +
      2 * state.sources[0].packedArray.byteLength +
      sparkRendererBudget(sparkSceneCapacity([2, 2])).reservedBytes,
  );
});

const terminalWithin = async (work: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => ({ status: "fulfilled" as const }),
        (reason) => ({ status: "rejected" as const, reason }),
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "pending" }), 50);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test("a synchronous source cleanup failure rejects current and future terminal waiters while retaining ownership", async () => {
  const badCanvas = {} as HTMLCanvasElement,
    bad = await createGaussianView(badCanvas),
    input = sceneOf();
  await bad.setScene(input);
  const source = state.sources.at(-1),
    failure = Error("source cleanup failed"),
    held = deferred();
  source.dispose.mockImplementation(() => {
    throw failure;
  });
  state.sortReady = held.promise;
  const sorting = state.sparks.at(-1).driveSort();
  const quiet = terminalWithin(bad.whenQuiescent()),
    released = terminalWithin(bad.whenReleased());
  try {
    expect(() => bad.dispose()).not.toThrow();
    expect(await released).toEqual({ status: "rejected", reason: failure });
    expect(await quiet).toEqual({ status: "rejected", reason: failure });
    expect(await terminalWithin(bad.whenQuiescent())).toEqual({
      status: "rejected",
      reason: failure,
    });
    expect(await terminalWithin(bad.whenReleased())).toEqual({
      status: "rejected",
      reason: failure,
    });
    const rendererCount = state.sparks.length;
    await expect(createGaussianView(badCanvas)).rejects.toBe(failure);
    expect(state.sparks).toHaveLength(rendererCount);
    expect(bad.residency().settled).toBe(false);
    expect(bad.residency().buffers).toContain(input.terrain.data.buffer);
    expect(bad.residency().buffers).toContain(source.packedArray.buffer);
    expect(bad.residency().extraBytes).toBeGreaterThan(0);
  } finally {
    held.resolve();
    await sorting;
    await released;
    await quiet;
  }
});

test("a pending swap mesh cleanup failure still closes the view and reports terminal failure", async () => {
  const bad = await createGaussianView({} as HTMLCanvasElement);
  await bad.setScene(sceneOf());
  const input = sceneOf(),
    swap = await bad.prepareScene(input);
  swap.activate();
  const failure = Error("mesh cleanup failed");
  state.meshes.at(-1).dispose.mockImplementation(() => {
    throw failure;
  });
  const released = terminalWithin(bad.whenReleased());
  expect(() => bad.dispose()).not.toThrow();
  expect(await released).toEqual({ status: "rejected", reason: failure });
  expect(await terminalWithin(bad.whenQuiescent())).toEqual({
    status: "rejected",
    reason: failure,
  });
  await expect(bad.prepareScene(sceneOf())).rejects.toThrow(
    "Renderer disposed",
  );
  expect(bad.residency().buffers).toContain(input.terrain.data.buffer);
  expect(bad.residency().settled).toBe(false);
});

test("late source cleanup failure cannot turn final initializer settlement into a false release", async () => {
  const bad = await createGaussianView({} as HTMLCanvasElement),
    input = sceneOf(),
    held = deferred();
  state.sourceReady = held.promise;
  const work = bad.prepareScene(input);
  const failure = Error("late source cleanup failed");
  const rejected = expect(work).rejects.toBe(failure);
  state.sources.at(-1).dispose.mockImplementation(() => {
    throw failure;
  });
  const released = terminalWithin(bad.whenReleased());
  bad.dispose();
  held.resolve();
  await rejected;
  expect(await released).toEqual({ status: "rejected", reason: failure });
  expect(await terminalWithin(bad.whenQuiescent())).toEqual({
    status: "rejected",
    reason: failure,
  });
  expect(bad.residency().buffers).toContain(input.terrain.data.buffer);
  expect(bad.residency().settled).toBe(false);
  expect(bad.residency().extraBytes).toBeGreaterThan(0);
});

test("late borrower cleanup failure decrements real work but rejects release instead of hanging", async () => {
  const bad = await createGaussianView({} as HTMLCanvasElement),
    input = makeSharedFixture(),
    first = deferred(),
    second = deferred();
  state.meshReadyQueue = [first.promise, second.promise];
  const work = bad.prepareScene(input);
  const rejected = expect(work).rejects.toThrow("early mesh failed");
  await flush();
  first.reject(Error("early mesh failed"));
  await rejected;
  const failure = Error("late borrower cleanup failed");
  state.meshes.at(-1).dispose.mockImplementation(() => {
    throw failure;
  });
  const quiet = terminalWithin(bad.whenQuiescent()),
    released = terminalWithin(bad.whenReleased());
  bad.dispose();
  second.resolve();
  await flush();
  expect(await released).toEqual({ status: "rejected", reason: failure });
  expect(await quiet).toEqual({ status: "rejected", reason: failure });
  expect(await terminalWithin(bad.whenQuiescent())).toEqual({
    status: "rejected",
    reason: failure,
  });
  expect(bad.residency().buffers).toContain(
    input.assets[0].lods.full.data.buffer,
  );
  expect(bad.residency().settled).toBe(false);
});

test("controls cleanup failure remains observable after renderer disposal without clearing the resource reserve", async () => {
  const bad = await createGaussianView({} as HTMLCanvasElement);
  await bad.setScene(sceneOf());
  const failure = Error("controls cleanup failed");
  state.controls.at(-1).dispose.mockImplementation(() => {
    throw failure;
  });
  const released = terminalWithin(bad.whenReleased());
  expect(() => bad.dispose()).not.toThrow();
  expect(await released).toEqual({ status: "rejected", reason: failure });
  await flush();
  expect(await terminalWithin(bad.whenQuiescent())).toEqual({
    status: "rejected",
    reason: failure,
  });
  expect(await terminalWithin(bad.whenReleased())).toEqual({
    status: "rejected",
    reason: failure,
  });
  expect(bad.residency().settled).toBe(false);
  expect(bad.residency().extraBytes).toBeGreaterThan(0);
  expect(state.sparks.at(-1).dispose).toHaveBeenCalledTimes(1);
});
