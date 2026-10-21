import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { Object3D } from "three";
import { createGeneralView } from "./view";
import type { GeneralView, RenderPacket } from "./types";
const state = vi.hoisted(() => ({
  sourceReady: Promise.resolve() as Promise<unknown>,
  sortReady: Promise.resolve() as Promise<unknown>,
  retainedBytes: 0,
  sparks: [] as any[],
  meshReady: Promise.resolve() as Promise<unknown>,
  meshes: [] as any[],
  sources: [] as any[],
  lost: false,
  manualMapping: null as { node: any; count: number }[] | null,
  lastDrawn: [] as { node: any; count: number }[],
}));
vi.mock("three", async (original) => ({
  ...(await original<typeof import("three")>()),
  WebGLRenderer: class {
    outputColorSpace = "";
    setSize() {}
    setPixelRatio() {}
    render() {
      state.lastDrawn = (
        state.manualMapping ??
        state.meshes
          .filter((m) => m.parent)
          .map((node) => ({ node, count: node.numSplats }))
      ).map((m) => ({ ...m }));
    }
    dispose() {}
    getContext() {
      return { isContextLost: () => state.lost };
    }
  },
}));
vi.mock("../../gaussian/spark-lifecycle", () => ({
  releaseGeneratorMaterial: vi.fn(),
  deferredSparkDisposal: (spark: any, after: () => void) => async () => {
    await state.sortReady;
    spark.dispose();
    after();
  },
}));
vi.mock("./source-bank", async (original) => {
  const module = await original<typeof import("./source-bank")>();
  return {
    ...module,
    createSourceBank() {
      const bank = module.createSourceBank();
      return {
        ...bank,
        stats() {
          const stats = bank.stats();
          return {
            ...stats,
            ownedBytes: stats.ownedBytes + state.retainedBytes,
          };
        },
      };
    },
  };
});
vi.mock("@sparkjsdev/spark", () => ({
  PackedSplats: class {
    initialized = state.sourceReady;
    numSplats = 0;
    dispose = vi.fn();
    pushSplat() {
      this.numSplats++;
    }
    getNumSplats() {
      return this.numSplats;
    }
    constructor() {
      state.sources.push(this);
    }
  },
  ExtSplats: class {},
  SplatMesh: class extends Object3D {
    numSplats = 1;
    initialized = state.meshReady;
    dispose = vi.fn();
    constructor(options: { packedSplats: { getNumSplats(): number } }) {
      super();
      this.numSplats = options.packedSplats.getNumSplats();
      state.meshes.push(this);
    }
  },
  SparkRenderer: class extends Object3D {
    readback32 = new Uint32Array(2048);
    orderingTexture: any = { image: { data: new Uint32Array(16384) } };
    uniforms = {
      ordering: { value: this.orderingTexture },
      extSplats: { value: {} },
      extSplats2: { value: {} },
    };
    dispose() {
      this.orderingTexture = null;
    }
    constructor() {
      super();
      state.sparks.push(this);
    }
    display = {
      set mapping(value: any[]) {
        state.manualMapping = value;
      },
      get mapping() {
        return (
          state.manualMapping ??
          state.meshes
            .filter((m) => m.parent)
            .map((node) => ({ node, count: node.numSplats }))
        );
      },
    };
    current = this.display;
    accumulators: any[] = [];
  },
}));
const packet = (key = "a"): RenderPacket => ({
  sources: new Map([
    [
      key,
      {
        kind: "float14",
        count: 1,
        data: new Float32Array([
          1, 0, 0, 0.1, 0.1, 0.1, 0, 0, 0, 1, 0.5, 0.5, 0.5, 1,
        ]),
      },
    ],
  ]),
  instances: [
    {
      id: "one",
      sourceKey: key,
      coarseSourceKey: null,
      anchor: [1, 0, 0],
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 },
    },
  ],
});
const deferred = () => {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
let view: GeneralView, canvas: HTMLCanvasElement;
beforeEach(async () => {
  vi.useFakeTimers();
  state.sourceReady = Promise.resolve();
  state.sortReady = Promise.resolve();
  state.retainedBytes = 0;
  state.sparks = [];
  state.meshReady = Promise.resolve();
  state.sources = [];
  state.meshes = [];
  state.lost = false;
  state.manualMapping = null;
  state.lastDrawn = [];
  canvas = Object.assign(new EventTarget(), {
    clientWidth: 1280,
    clientHeight: 720,
    width: 1280,
    height: 720,
  }) as HTMLCanvasElement;
  view = await createGeneralView(canvas);
});
afterEach(async () => {
  await view.dispose();
  vi.useRealTimers();
});
const install = async (p = packet()) => {
  const s = await view.prepare(p, new AbortController().signal);
  s.activate();
  view.render();
  expect(s.isUsable()).toBe(true);
  s.commit();
  return s;
};
test("a committed view becomes unavailable on context loss and rejects further preparation", async () => {
  await install();
  expect(view.activity()).toEqual({ preparing: false, available: true });
  const event = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(view.activity()).toEqual({ preparing: false, available: false });
  await expect(
    view.prepare(packet("candidate"), new AbortController().signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("dispose makes a view unavailable before renderer disposal settles", async () => {
  await install();
  expect(view.activity().available).toBe(true);
  const wait = deferred();
  state.sortReady = wait.promise;
  const closing = view.dispose();
  expect(view.activity()).toEqual({ preparing: false, available: false });
  expect(view.stats().ownedBytes).toBeGreaterThan(0);
  wait.resolve();
  await closing;
  expect(view.activity()).toEqual({ preparing: false, available: false });
});

test("preparation settlement spans source upload, mesh initialization, and the outer prepare", async () => {
  expect(view.activity()).toEqual({ preparing: false, available: true });
  await view.whenPreparationSettled();
  const source = deferred(),
    mesh = deferred();
  state.sourceReady = source.promise;
  state.meshReady = mesh.promise;
  const work = view.prepare(packet(), new AbortController().signal);
  let settled = false;
  const settlement = view.whenPreparationSettled().then(() => {
    expect(view.activity()).toMatchObject({ preparing: false });
    settled = true;
  });
  expect(view.activity()).toMatchObject({ preparing: true });
  source.resolve();
  await flush();
  expect(state.meshes).toHaveLength(1);
  expect(view.activity()).toMatchObject({ preparing: true });
  expect(settled).toBe(false);
  mesh.resolve();
  await settlement;
  const swap = await work;
  expect(settled).toBe(true);
  swap.activate();
  expect(swap.isUsable()).toBe(false);
  view.render();
  expect(swap.isUsable()).toBe(true);
  swap.commit();
  expect(view.stats().activeSplats).toBe(1);
});

test.each([
  ["source", "cancel"],
  ["mesh", "cancel"],
  ["source", "dispose"],
  ["mesh", "dispose"],
] as const)(
  "preparation settlement waits for late %s cleanup after %s",
  async (kind, action) => {
    await install();
    const oldSource = state.sources[0],
      oldCamera = view.getCamera(),
      wait = deferred(),
      abort = new AbortController();
    state[kind === "source" ? "sourceReady" : "meshReady"] = wait.promise;
    const work = view.prepare(packet("candidate"), abort.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    let settled = false;
    const settlement = view.whenPreparationSettled().then(() => {
      settled = true;
    });
    expect(view.activity()).toMatchObject({ preparing: true });
    if (action === "cancel") abort.abort();
    else await view.dispose();
    await rejected;
    let lateWaiterSettled = false;
    const lateSettlement = view.whenPreparationSettled().then(() => {
      lateWaiterSettled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(lateWaiterSettled).toBe(false);
    expect(view.activity()).toEqual({
      preparing: true,
      available: action === "cancel",
    });
    if (action === "cancel") {
      expect(view.stats().instanceCount).toBe(1);
      expect(view.getCamera()).toEqual(oldCamera);
      expect(oldSource.dispose).not.toHaveBeenCalled();
    }
    const resource = kind === "source" ? state.sources[1] : state.meshes[1],
      disposalCount = resource.dispose.mock.calls.length;
    // Exercise late success and failure; either path must complete its cleanup.
    if (action === "cancel") wait.resolve();
    else wait.reject(Error("late initialization failure"));
    await Promise.all([settlement, lateSettlement]);
    expect(resource.dispose.mock.calls.length).toBeGreaterThan(disposalCount);
    expect(view.activity()).toEqual({
      preparing: false,
      available: action === "cancel",
    });
    expect(view.stats().sourceCount).toBe(action === "cancel" ? 1 : 0);
    if (action === "dispose") expect(view.stats().ownedBytes).toBe(0);
  },
);

test("prepared shared source rollback restores meshes and camera, commit releases old leases", async () => {
  const p = packet();
  await install(p);
  const camera = view.getCamera();
  const next = await view.prepare(
    { ...p, instances: [{ ...p.instances[0], id: "two" }] },
    new AbortController().signal,
  );
  expect(state.sources).toHaveLength(1);
  next.activate();
  view.setCamera({ position: [4, 5, 6], target: [1, 2, 3] });
  next.rollback();
  expect(view.getCamera()).toEqual(camera);
  expect(view.stats()).toMatchObject({ sourceCount: 1, instanceCount: 1 });
  expect(state.sources[0].dispose).not.toHaveBeenCalled();
  await install({ ...p, instances: [] });
  expect(view.stats()).toMatchObject({
    sourceCount: 0,
    instanceCount: 0,
    ownedBytes: 8 * 1024 ** 2 + 128 * 2048,
  });
});
test.each(["source", "mesh"] as const)(
  "cancel paused %s preserves current and contains late rejection",
  async (kind) => {
    await install();
    const original = state.sources[0],
      wait = deferred(),
      abort = new AbortController();
    state[kind === "source" ? "sourceReady" : "meshReady"] = wait.promise;
    let error: unknown;
    const work = view.prepare(packet("next"), abort.signal).catch((e) => {
      error = e;
    });
    await flush();
    abort.abort();
    await flush();
    expect(error).toMatchObject({ name: "AbortError" });
    expect(view.stats().instanceCount).toBe(1);
    expect(original.dispose).not.toHaveBeenCalled();
    wait.reject(Error("late rejected"));
    await work;
    await flush();
    expect(view.stats().sourceCount).toBe(1);
  },
);
test.each(["source", "mesh"] as const)(
  "failed %s is never published",
  async (kind) => {
    await install();
    const failure = Promise.reject(Error("injected"));
    failure.catch(() => {});
    state[kind === "source" ? "sourceReady" : "meshReady"] = failure;
    await expect(
      view.prepare(packet("next"), new AbortController().signal),
    ).rejects.toThrow("injected");
    expect(view.stats().instanceCount).toBe(1);
  },
);
test("stalled initialization times out and dispose cancels without awaiting the stalled promise", async () => {
  const wait = deferred();
  state.sourceReady = wait.promise;
  const work = view.prepare(packet(), new AbortController().signal);
  const rejected = expect(work).rejects.toThrow(/timed out/i);
  await vi.advanceTimersByTimeAsync(10001);
  await rejected;
  await view.dispose();
  wait.resolve();
  await flush();
  expect(view.stats().ownedBytes).toBe(0);
});
test("supersede and abort of prepared swap reject stale activation", async () => {
  await install();
  const abort = new AbortController();
  const first = await view.prepare(packet("b"), abort.signal);
  abort.abort();
  expect(() => first.activate()).toThrow();
  const second = await view.prepare(packet("c"), new AbortController().signal);
  const third = await view.prepare(packet("d"), new AbortController().signal);
  expect(() => second.activate()).toThrow();
  third.rollback();
  expect(view.stats().instanceCount).toBe(1);
});
test("ten replace/rollback/release cycles return all source ownership to baseline", async () => {
  for (let i = 0; i < 10; i++) {
    await install();
    const s = await view.prepare(packet("other"), new AbortController().signal);
    s.activate();
    s.rollback();
    await install({ sources: new Map(), instances: [] });
    expect(view.stats().ownedBytes).toBe(8 * 1024 ** 2 + 128 * 2048);
  }
  expect(state.sources.every((s) => s.dispose.mock.calls.length === 1)).toBe(
    true,
  );
});
test("budget counts shared worst LOD per instance, and rejects bad transforms before publishing", async () => {
  const p = packet();
  p.instances = Array.from({ length: 122 }, (_, i) => ({
    ...p.instances[0],
    id: String(i),
  }));
  await expect(view.prepare(p, new AbortController().signal)).rejects.toThrow(
    /budget|instances/i,
  );
  const q = packet();
  q.instances[0].transform = {
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 0],
    scale: 1,
  };
  await expect(view.prepare(q, new AbortController().signal)).rejects.toThrow(
    /transform|quaternion/i,
  );
  expect(view.stats().instanceCount).toBe(0);
});

test("ownedBytes retains displayed sort capacity after an empty replacement and reaches zero only on disposal", async () => {
  expect(view.stats().ownedBytes).toBe(8 * 1024 ** 2);
  await install();
  expect(view.stats().ownedBytes).toBeGreaterThan(8 * 1024 ** 2 + 128 * 2048);
  await install({ sources: new Map(), instances: [] });
  expect(view.stats()).toEqual({
    sourceCount: 0,
    instanceCount: 0,
    activeSplats: 0,
    ownedBytes: 8 * 1024 ** 2 + 128 * 2048,
  });
  await install({ sources: new Map(), instances: [] });
  expect(view.stats().ownedBytes).toBe(8 * 1024 ** 2 + 128 * 2048);
  await view.dispose();
  expect(view.stats().ownedBytes).toBe(0);
});

test("renderer accepts 100 terrain tiles plus 20 objects plus one water node", async () => {
  const p = packet();
  p.instances = Array.from({ length: 121 }, (_, i) => ({
    ...p.instances[0],
    id: String(i),
  }));
  await install(p);
  expect(view.stats()).toMatchObject({
    sourceCount: 1,
    instanceCount: 121,
    activeSplats: 121,
  });
});

test("the independent scene-object budget still rejects 21 objects", async () => {
  const { assertBudget, GENERAL_LIMITS } = await import("../core");
  expect(() =>
    assertBudget(
      {
        instances: 21,
        worstSplats: 21,
        candidateCpuBytes: 0,
        transitionBytes: 0,
      },
      GENERAL_LIMITS,
    ),
  ).toThrow(/instances/);
  expect(GENERAL_LIMITS.maxInstances).toBe(20);
});

test("the 250k limit expands the worst LOD for every shared instance", async () => {
  const p = packet();
  p.sources = new Map([
    ["a", { kind: "float14", count: 1, data: new Float32Array(14) }],
    [
      "coarse",
      { kind: "float14", count: 125001, data: new Float32Array(125001 * 14) },
    ],
  ]);
  p.instances = ["one", "two"].map((id) => ({
    ...p.instances[0],
    id,
    coarseSourceKey: "coarse",
  }));
  await expect(view.prepare(p, new AbortController().signal)).rejects.toThrow(
    /worstSplats/,
  );
  expect(state.sources).toHaveLength(0);
});

test.each([false, true])(
  "a sorted %s candidate cannot commit until its mapping has actually been drawn",
  async (empty) => {
    await install();
    const oldMesh = state.meshes[0],
      oldSource = state.sources[0];
    state.manualMapping = [{ node: oldMesh, count: 1 }];
    const swap = await view.prepare(
      empty ? { sources: new Map(), instances: [] } : packet("candidate"),
      new AbortController().signal,
    );
    swap.activate();
    view.render();
    expect(state.lastDrawn[0].node).toBe(oldMesh);
    expect(swap.isUsable()).toBe(false);
    await Promise.resolve(); // asynchronous Spark sort completes between draws
    state.manualMapping = empty ? [] : [{ node: state.meshes[1], count: 1 }];
    expect(swap.isUsable()).toBe(false);
    expect(() => swap.commit()).toThrow(/usable rendered frame/);
    expect(oldSource.dispose).not.toHaveBeenCalled();
    expect(view.stats().sourceCount).toBe(empty ? 1 : 2);
    view.render();
    expect(state.lastDrawn).toEqual(state.manualMapping);
    expect(swap.isUsable()).toBe(true);
    swap.commit();
    expect(oldSource.dispose).toHaveBeenCalledTimes(1);
    expect(view.stats()).toMatchObject({
      sourceCount: empty ? 0 : 1,
      activeSplats: empty ? 0 : 1,
    });
  },
);

function manySource(count: number) {
  const data = new Float32Array(count * 14);
  for (let i = 0; i < count; i++)
    data.set([1, 0, 0, 0.1, 0.1, 0.1, 0, 0, 0, 1, 0.5, 0.5, 0.5, 1], i * 14);
  return { kind: "float14" as const, count, data };
}
test("a paused first source cannot let later-source mutation bypass the 250k cap", async () => {
  await install();
  const old = state.sources[0],
    wait = deferred();
  state.sourceReady = wait.promise;
  const later = manySource(1),
    p = packet("first");
  p.sources = new Map([
    ["first", manySource(1)],
    ["later", later],
  ]);
  p.instances = [
    p.instances[0],
    ...["second", "third"].map((id) => ({
      ...p.instances[0],
      id,
      sourceKey: "later",
    })),
  ];
  const work = view.prepare(p, new AbortController().signal);
  Object.assign(later, manySource(125001));
  expect(view.stats().activeSplats).toBe(1);
  expect(old.dispose).not.toHaveBeenCalled();
  wait.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  const swap = await work;
  expect(old.dispose).not.toHaveBeenCalled();
  swap.activate();
  view.render();
  swap.commit();
  expect(view.stats().activeSplats).toBe(3);
  expect(state.sources.map((s) => s.numSplats)).toEqual([1, 1, 1]);
  expect(old.dispose).toHaveBeenCalledTimes(1);
});
test("already acquired source count cannot shrink stats or sort ownership after upload", async () => {
  const source = manySource(250000),
    p = packet("large");
  p.sources = new Map([["large", source]]);
  const wait = deferred();
  state.sourceReady = wait.promise;
  const work = view.prepare(p, new AbortController().signal);
  Object.assign(source, manySource(1));
  wait.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  const swap = await work;
  swap.activate();
  view.render();
  swap.commit();
  expect(state.sources[0].numSplats).toBe(250000);
  expect(state.meshes[0].numSplats).toBe(250000);
  expect(view.stats()).toMatchObject({
    activeSplats: 250000,
    ownedBytes: 62693248,
  });
});
test("partial synchronous acquisition failure releases every new lease while retaining the old frame", async () => {
  await install();
  const old = state.sources[0],
    p = packet("new");
  p.sources = new Map([
    ["new", manySource(1)],
    ["invalid", { kind: "float14", count: 1, data: new Float32Array(14) }],
  ]);
  p.instances.push({ ...p.instances[0], id: "bad", sourceKey: "invalid" });
  await expect(view.prepare(p, new AbortController().signal)).rejects.toThrow(
    /sigma/,
  );
  await flush();
  expect(view.stats()).toMatchObject({ sourceCount: 1, activeSplats: 1 });
  expect(old.dispose).not.toHaveBeenCalled();
  expect(state.sources[1].dispose).toHaveBeenCalled();
});

test("121 one-point generators reserve their padded capacity, not their shared source count", async () => {
  const p = packet();
  p.instances = Array.from({ length: 121 }, (_, i) => ({
    ...p.instances[0],
    id: String(i),
  }));
  await install(p);
  const sourceBytes = 56 + 2048 * 32;
  expect(view.stats().ownedBytes - sourceBytes).toBe(
    8 * 1024 ** 2 + 128 * 247808,
  );
  expect(view.stats().ownedBytes - sourceBytes).toBeGreaterThan(
    2 * 20 * 247808,
  );
});

test("every shared instance reserves its padded worst LOD through rollback and empty replacement", async () => {
  await install();
  const p = packet("full");
  p.sources = new Map([
    ["full", manySource(1)],
    ["coarse", manySource(2049)],
  ]);
  p.instances = ["first", "second"].map((id) => ({
    ...p.instances[0],
    id,
    coarseSourceKey: "coarse",
  }));
  const work = view.prepare(p, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(100);
  const swap = await work;
  swap.activate();
  view.render();
  swap.rollback();
  await install({ sources: new Map(), instances: [] });
  expect(view.stats().ownedBytes).toBe(8 * 1024 ** 2 + 128 * 8192);
});

test("padded transition rejection happens before acquiring candidate sources or meshes", async () => {
  await install();
  const old = state.sources[0],
    camera = view.getCamera();
  const p = packet("candidate");
  p.instances = Array.from({ length: 121 }, (_, i) => ({
    ...p.instances[0],
    id: String(i),
  }));
  // Model already-retained late source ownership without allocating 236 MiB in this unit test.
  state.retainedBytes = 256 * 1024 ** 2 - 20_000_000;
  await expect(view.prepare(p, new AbortController().signal)).rejects.toThrow(
    /transitionBytes/,
  );
  expect(state.sources).toHaveLength(1);
  expect(state.meshes).toHaveLength(1);
  expect(old.dispose).not.toHaveBeenCalled();
  expect(view.getCamera()).toEqual(camera);
  expect(view.stats().activeSplats).toBe(1);
  state.retainedBytes = 0;
});

test("sort disposal retains bytes and heavy references until settlement, then clears arrays and mappings", async () => {
  await install();
  const wait = deferred(),
    spark = state.sparks[0];
  state.sortReady = wait.promise;
  const closing = view.dispose();
  await flush();
  expect(view.stats().ownedBytes).toBeGreaterThan(0);
  expect(spark.readback32.byteLength).toBe(8192);
  expect(spark.uniforms.ordering.value.image.data.byteLength).toBe(65536);
  wait.resolve();
  await closing;
  expect(spark.readback32.byteLength).toBe(0);
  expect(spark.display.mapping).toEqual([]);
  expect(spark.uniforms.ordering.value).toBeNull();
  expect(view.stats().ownedBytes).toBe(0);
});

test.each(["source", "mesh"] as const)(
  "disposed view keeps late %s cleanup reserved after prompt cancellation",
  async (kind) => {
    const wait = deferred(),
      abort = new AbortController();
    state[kind === "source" ? "sourceReady" : "meshReady"] = wait.promise;
    const work = view.prepare(packet(), abort.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    abort.abort();
    await rejected;
    await view.dispose();
    const retained = view.stats().ownedBytes;
    wait.resolve();
    await flush();
    expect(retained).toBeGreaterThanOrEqual(8 * 1024 ** 2);
    expect(view.stats().ownedBytes).toBe(0);
    expect(state.sparks[0].readback32.byteLength).toBe(0);
  },
);

test("transition bytes admit the exact ceiling and reject one byte above before allocation", async () => {
  await install();
  const p = packet("candidate");
  p.instances = Array.from({ length: 121 }, (_, i) => ({
    ...p.instances[0],
    id: String(i),
  }));
  const sourceOwned = 56 + 2048 * 32;
  state.retainedBytes =
    256 * 1024 ** 2 - (sourceOwned + 56 + sourceOwned + 40108032);
  const admitted = await view.prepare(p, new AbortController().signal);
  admitted.rollback();
  const count = state.sources.length;
  state.retainedBytes++;
  await expect(view.prepare(p, new AbortController().signal)).rejects.toThrow(
    /transitionBytes/,
  );
  expect(state.sources).toHaveLength(count);
  state.retainedBytes = 0;
});

test("a smaller candidate cannot evade the already retained padded renderer capacity", async () => {
  const p = packet();
  p.instances = Array.from({ length: 121 }, (_, i) => ({
    ...p.instances[0],
    id: String(i),
  }));
  await install(p);
  state.retainedBytes = 256 * 1024 ** 2 - 20_000_000;
  await expect(
    view.prepare(
      { sources: new Map(), instances: [] },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/transitionBytes/);
  expect(view.stats().instanceCount).toBe(121);
  state.retainedBytes = 0;
});

test("all cancelled initializer generations stay reserved until the last settles", async () => {
  const first = deferred(),
    second = deferred();
  for (const [key, wait] of [
    ["first", first],
    ["second", second],
  ] as const) {
    const abort = new AbortController();
    state.sourceReady = wait.promise;
    const work = view.prepare(packet(key), abort.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    abort.abort();
    await rejected;
  }
  let settled = false;
  const settlement = view.whenPreparationSettled().then(() => {
    settled = true;
  });
  const closing = view.dispose();
  expect(view.dispose()).toBe(closing);
  await closing;
  expect(settled).toBe(false);
  expect(view.activity()).toMatchObject({ preparing: true });
  expect(view.stats().sourceCount).toBe(2);
  first.resolve();
  await flush();
  expect(view.stats().sourceCount).toBe(1);
  expect(view.stats().ownedBytes).toBeGreaterThan(8 * 1024 ** 2);
  expect(settled).toBe(false);
  expect(view.activity()).toMatchObject({ preparing: true });
  second.reject(Error("late failure"));
  await settlement;
  expect(view.activity()).toMatchObject({ preparing: false });
  expect(view.stats().ownedBytes).toBe(0);
  expect(state.sparks[0].uniforms.ordering.value).toBeNull();
});
