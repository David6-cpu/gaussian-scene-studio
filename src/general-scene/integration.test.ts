import { expect, test, vi } from "vitest";
import { createAllocationGate, manualPlanningOutcome } from "./integration";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
test("general waits for actual legacy IO, including a cancelled but unsettled read", async () => {
  const gate = createAllocationGate(),
    read = deferred(),
    work = vi.fn(async () => 42);
  const old = gate.run("legacy", () => read.promise);
  await flush();
  gate.setGeneral(true);
  const next = gate.run("general", work);
  await flush();
  expect(gate.activity().running).toBe("legacy");
  expect(work).not.toHaveBeenCalled();
  read.resolve();
  await old;
  expect(await next).toBe(42);
  expect(gate.activity().running).toBe(null);
});
test("queued background work does not block general and resumes after leaving", async () => {
  const gate = createAllocationGate(),
    order: string[] = [];
  gate.setGeneral(true);
  const refresh = gate.run("background", async () => {
    order.push("refresh");
  });
  await gate.run("general", async () => {
    order.push("general");
  });
  expect(order).toEqual(["general"]);
  expect(gate.activity()).toEqual({ running: null, queued: 1 });
  gate.setGeneral(false);
  await refresh;
  expect(order).toEqual(["general", "refresh"]);
});
test("lease is held through actual cleanup after immediate cancellation", async () => {
  const gate = createAllocationGate(),
    cleanup = deferred(),
    next = vi.fn(async () => {});
  const first = gate.run("general", async () => {
    await cleanup.promise;
  });
  await flush();
  const queued = gate.run("legacy", next);
  await flush();
  expect(next).not.toHaveBeenCalled();
  cleanup.resolve();
  await first;
  await queued;
  expect(next).toHaveBeenCalledTimes(1);
});
test("stale activation never starts file reading and does not poison following work", async () => {
  const gate = createAllocationGate(),
    held = deferred(),
    reading = vi.fn(async () => {});
  const first = gate.run("legacy", () => held.promise);
  let current = true;
  const queued = gate
    .run("general", reading, () => current)
    .catch((e) => e.name);
  current = false;
  held.resolve();
  await first;
  expect(await queued).toBe("AbortError");
  expect(reading).not.toHaveBeenCalled();
  expect(await gate.run("general", async () => 7)).toBe(7);
});
test("save completion can enqueue refresh after its lease without nested deadlock", async () => {
  const gate = createAllocationGate(),
    order: string[] = [];
  const save = gate.run("background", async () => {
    order.push("saved");
  });
  await save.finally(() =>
    gate.run("background", async () => {
      order.push("refreshed");
    }),
  );
  expect(order).toEqual(["saved", "refreshed"]);
});
test("manual entry captures the exact request and honestly reports no model evidence", () => {
  const request = {
    operationId: "manual-op",
    prompt: "手工安排场地",
    baseRevisionId: null,
    manualOverrides: [],
  };
  const out = manualPlanningOutcome(request);
  expect(out.ok).toBe(false);
  expect(out.request).toEqual(request);
  if (out.ok) throw Error("manual outcome cannot claim model success");
  expect(out.partial).toEqual({ intent: null, draft: null, evidence: [] });
  expect(out.inputs).toEqual([]);
  expect(out.mode).toBe("manual");
  expect(out.issues[0].code).toBe("manual-entry");
  expect(out.issues[0].message).not.toMatch(/失败|网络|模型错误/);
});

// Controlled ports isolate the integration's real owner/cleanup decisions. Native
// WebGL/IDB draw and receipt behavior remains covered by the browser suite.
const browser = vi.hoisted(() => ({
  display: null as any,
  decode: vi.fn(),
  download: vi.fn(),
  createOld: vi.fn(),
  createGeneral: vi.fn(),
  redisplay: vi.fn(async () => ({ ok: true, value: undefined })),
  settle: vi.fn(async () => {}),
  state: null as any,
  residency: { buffers: [] as ArrayBuffer[], extraBytes: 0, settled: true },
  external: { buffers: [] as ArrayBuffer[], extraBytes: 0, settled: true },
  store: { readRevision: vi.fn(), list: vi.fn(async () => []) },
}));
vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const { Vector3 } = await import("three");
  return {
    OrbitControls: class {
      target = new Vector3();
      enabled = false;
      enableDamping = false;
      update() {}
      dispose() {}
    },
  };
});
vi.mock("../io/download", () => ({
  downloadBlob: (...args: unknown[]) => browser.download(...args),
}));
vi.mock("../gaussian/view", () => ({
  createGaussianView: (...args: unknown[]) => browser.createOld(...args),
}));
vi.mock("./render/view", () => ({
  createGeneralView: (...args: unknown[]) => browser.createGeneral(...args),
}));
vi.mock("./migration", () => ({
  readLegacySceneForDisplay: (...args: unknown[]) => browser.decode(...args),
}));
vi.mock("./storage", () => ({ createSceneStore: () => browser.store }));
vi.mock("./controller", async (original) => {
  const actual = await original<typeof import("./controller")>();
  return {
    ...actual,
    createSceneController: (ports: any) => {
      browser.display = ports.display;
      return {
        getResidency: () => browser.residency,
        whenSettled: () => browser.settle(),
        redisplayCurrent: () => browser.redisplay(),
        getCurrentCatalog: () => null,
        cancel() {},
        getState: () =>
          browser.state ?? {
            phase: "idle",
            current: null,
            planning: null,
            lastSave: null,
            issues: [],
            finalization: { kind: "none" },
          },
        subscribe: () => () => {},
      };
    },
  };
});
function fakeElement() {
  return {
    id: "",
    className: "",
    hidden: false,
    textContent: "",
    children: [] as unknown[],
    setAttribute() {},
    append(...items: unknown[]) {
      this.children.push(...items);
    },
    remove() {},
  };
}
async function browserIntegration() {
  vi.stubGlobal("document", { createElement: () => fakeElement() });
  vi.stubGlobal("window", { addEventListener() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const { createGeneralIntegration } = await import("./integration");
  const empty = () => browser.external;
  return createGeneralIntegration({
    viewerHost: fakeElement() as unknown as HTMLElement,
    canSwitch: () => true,
    cancelPending() {},
    pause() {},
    resume() {},
    getCamera: () => ({ position: [6, 5, 6], target: [0, 0, 0] }),
    setCamera() {},
    residency: empty,
    whenQuiescent: async () => {},
    closeEnvironment() {},
    changed() {},
  });
}
const oldSnapshot = () => ({
  original: { bytes: new Uint8Array([1]), digest: "a".repeat(64) },
  originVersion: "wetland-f0-v1",
  camera: { position: [6, 5, 6], target: [0, 0, 0] },
});
const decodedScene = () => ({
  scene: {
    terrain: { count: 1, data: new Float32Array(14) },
    water: null,
    assets: [],
    instances: [],
  },
});
test("decoded original is removed from residency when cancellation lands at decode return", async () => {
  const app = await browserIntegration(),
    abort = new AbortController();
  app.panelPorts.enterMode();
  browser.decode.mockImplementationOnce(async () => {
    abort.abort();
    return decodedScene();
  });
  try {
    await expect(
      browser.display.showLegacy(oldSnapshot(), abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(app.diagnostics().residency.buffers).toHaveLength(0);
    expect(browser.createOld).not.toHaveBeenCalled();
  } finally {
    await app.dispose();
    browser.decode.mockReset();
    browser.createOld.mockReset();
    vi.unstubAllGlobals();
  }
});
test("late readonly renderer creation is disposed without installing into a different mode", async () => {
  const app = await browserIntegration(),
    abort = new AbortController();
  app.panelPorts.enterMode();
  browser.decode.mockResolvedValueOnce(decodedScene());
  const made = deferred(),
    next = {
      dispose: vi.fn(),
      whenReleased: async () => {},
      residency: () => ({ buffers: [], extraBytes: 0, settled: true }),
      prepareScene: vi.fn(),
    };
  browser.createOld.mockImplementationOnce(async () => {
    await made.promise;
    return next;
  });
  const pending = browser.display
    .showLegacy(oldSnapshot(), abort.signal)
    .catch((e: Error) => e.name);
  try {
    await flush();
    expect(browser.createOld).toHaveBeenCalledTimes(1);
    app.panelPorts.leaveMode();
    made.resolve();
    expect(await pending).toBe("AbortError");
    expect(next.dispose).toHaveBeenCalledTimes(1);
    expect(next.prepareScene).not.toHaveBeenCalled();
    expect(app.diagnostics().readonlyView).toBe(null);
    expect(app.diagnostics().residency.buffers).toHaveLength(0);
  } finally {
    made.resolve();
    await app.dispose();
    browser.decode.mockReset();
    browser.createOld.mockReset();
    vi.unstubAllGlobals();
  }
});
test("mode observers release UI operation ownership synchronously on external activation", async () => {
  const app = await browserIntegration(),
    events: string[] = [];
  const unsub = app.panelPorts.subscribeMode((mode) => events.push(mode));
  try {
    app.panelPorts.enterMode();
    app.enterLegacy();
    expect(events).toEqual(["legacy", "general", "legacy"]);
    unsub();
    app.panelPorts.enterMode();
    expect(events).toHaveLength(3);
  } finally {
    await app.dispose();
    vi.unstubAllGlobals();
  }
});

test("activated legacy IO rechecks ownership after actual general cleanup settles", async () => {
  const app = await browserIntegration(),
    cleanup = deferred(),
    read = vi.fn(async () => {});
  app.panelPorts.enterMode();
  browser.settle.mockImplementationOnce(() => cleanup.promise);
  const pending = app
    .runLegacyIO("activate", read, 0, "legacy")
    .catch((e: Error) => e.name);
  try {
    await flush();
    app.panelPorts.enterMode();
    cleanup.resolve();
    expect(await pending).toBe("AbortError");
    expect(read).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    await app.dispose();
    browser.settle.mockReset().mockResolvedValue(undefined);
    vi.unstubAllGlobals();
  }
});
test("metadata cannot escape a cancelled mode generation even with unchanged current revision", async () => {
  const app = await browserIntegration(),
    read = deferred();
  app.panelPorts.enterMode();
  browser.state = {
    phase: "idle",
    current: {
      revisionId: "same",
      sceneId: "scene",
      access: "editable",
      issues: [],
    },
  };
  browser.store.readRevision.mockImplementationOnce(async () => {
    await read.promise;
    return {
      revisionId: "same",
      sceneId: "scene",
      terrain: { bytes: new Float32Array(16) },
    };
  });
  const pending = app.panelPorts.controller
    .metadata()
    .catch((e: Error) => e.name);
  try {
    await flush();
    expect(browser.store.readRevision).toHaveBeenCalled();
    app.panelPorts.controller.cancel();
    read.resolve();
    expect(await pending).toBe("AbortError");
    expect(app.diagnostics().residency.buffers).toHaveLength(0);
  } finally {
    read.resolve();
    browser.state = null;
    await app.dispose();
    browser.store.readRevision.mockReset();
    vi.unstubAllGlobals();
  }
});
test("phase reservations replace earlier estimates and shared external backings count once", async () => {
  const shared = new ArrayBuffer(1024);
  browser.residency = { buffers: [shared], extraBytes: 0, settled: true };
  browser.external = { buffers: [shared], extraBytes: 0, settled: true };
  const app = await browserIntegration();
  try {
    await app.runLegacyIO(
      "background",
      async (reserve) => {
        reserve(256 * 1024 ** 2 - 1024);
        expect(app.diagnostics().residency.buffers).toEqual([shared]);
        expect(app.diagnostics().residency.extraBytes).toBe(
          256 * 1024 ** 2 - 1024,
        );
        reserve(1);
        expect(app.diagnostics().residency.extraBytes).toBe(1);
        expect(() => reserve(256 * 1024 ** 2 - 1023)).toThrow(/预算/);
      },
      0,
    );
    expect(app.diagnostics().residency.extraBytes).toBe(0);
  } finally {
    browser.residency = { buffers: [], extraBytes: 0, settled: true };
    browser.external = { buffers: [], extraBytes: 0, settled: true };
    await app.dispose();
    vi.unstubAllGlobals();
  }
});
test("stream chunks reserve complete distinct backing before reading another chunk", async () => {
  const app = await browserIntegration();
  browser.residency = {
    buffers: [],
    extraBytes: 256 * 1024 ** 2 - 512 * 1024,
    settled: true,
  };
  const chunk = new Uint8Array(new ArrayBuffer(1024 * 1024), 0, 10),
    read = vi
      .fn()
      .mockResolvedValueOnce({ value: chunk, done: false })
      .mockResolvedValue({ done: true }),
    cancel = vi.fn(async () => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-length": "10" }),
      body: { getReader: () => ({ read, cancel, releaseLock() {} }) },
    })),
  );
  try {
    await expect(
      app.panelPorts.controller.catalog(new AbortController().signal),
    ).rejects.toThrow(/预算/);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(app.diagnostics().residency.buffers).toHaveLength(0);
  } finally {
    browser.residency = { buffers: [], extraBytes: 0, settled: true };
    await app.dispose();
    vi.unstubAllGlobals();
  }
});

test("background IO whose cleanup crosses a mode switch requeues without losing its intent", async () => {
  const app = await browserIntegration(),
    cleanup = deferred(),
    read = vi.fn(async () => "saved");
  browser.settle.mockImplementationOnce(() => cleanup.promise);
  const pending = app.runLegacyIO("background", read, 0);
  try {
    await flush();
    app.panelPorts.enterMode();
    cleanup.resolve();
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(app.diagnostics().lease).toEqual({ running: null, queued: 1 });
    app.enterLegacy();
    expect(await pending).toBe("saved");
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    cleanup.resolve();
    await app.dispose();
    browser.settle.mockReset().mockResolvedValue(undefined);
    vi.unstubAllGlobals();
  }
});

test("repeated original downloads retain one shared File backing until its last URL retires", async () => {
  vi.useFakeTimers();
  const app = await browserIntegration(),
    file = new File([new Uint8Array(128)], "original.zip");
  try {
    expect((await app.panelPorts.controller.downloadOriginal(file)).ok).toBe(
      true,
    );
    expect(app.diagnostics().residency.extraBytes).toBe(128);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await app.panelPorts.controller.downloadOriginal(file)).ok).toBe(
      true,
    );
    expect(app.diagnostics().residency.extraBytes).toBe(128);
    await vi.advanceTimersByTimeAsync(4100);
    expect(app.diagnostics().residency.extraBytes).toBe(128);
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.diagnostics().residency.extraBytes).toBe(0);
    expect(browser.download).toHaveBeenCalledTimes(2);
  } finally {
    await app.dispose();
    browser.download.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

function generalViewControl() {
  let camera = { position: [6, 5, 6], target: [0, 0, 0] };
  return {
    activity: () => ({ preparing: false, available: true }),
    getCamera: () => camera,
    setCamera: (value: typeof camera) => {
      camera = value;
    },
    stats: () => ({
      sourceCount: 0,
      instanceCount: 0,
      activeSplats: 0,
      ownedBytes: 0,
    }),
    render() {},
    dispose: vi.fn(async () => {}),
    whenPreparationSettled: async () => {},
  };
}
test("returning to general restores the actual current scene through the allocation lease", async () => {
  const app = await browserIntegration(),
    made = generalViewControl();
  browser.state = {
    phase: "idle",
    current: { sceneId: "kept", revisionId: "saved" },
  };
  browser.createGeneral.mockResolvedValueOnce(made);
  browser.redisplay.mockImplementationOnce(async () => {
    expect(app.diagnostics().lease.running).toBe("general");
    expect(browser.display.current()).toBe(made);
    return { ok: true, value: undefined };
  });
  try {
    expect(app.panelPorts.enterMode()).toBe(true);
    for (let i = 0; i < 8; i++) await flush();
    expect(browser.redisplay).toHaveBeenCalledTimes(1);
    expect(browser.store.readRevision).not.toHaveBeenCalled();
    expect(app.panelPorts.controller.getState().current?.revisionId).toBe(
      "saved",
    );
    expect(app.diagnostics().mode).toBe("general");
  } finally {
    browser.state = null;
    await app.dispose();
    browser.redisplay
      .mockReset()
      .mockResolvedValue({ ok: true, value: undefined });
    browser.createGeneral.mockReset();
    vi.unstubAllGlobals();
  }
});
test("a queued mode-entry restore cannot create a renderer after switching back", async () => {
  const app = await browserIntegration(),
    cleanup = deferred();
  browser.state = {
    phase: "idle",
    current: { sceneId: "kept", revisionId: "saved" },
  };
  browser.settle.mockImplementationOnce(() => cleanup.promise);
  try {
    app.panelPorts.enterMode();
    await flush();
    app.enterLegacy();
    cleanup.resolve();
    for (let i = 0; i < 8; i++) await flush();
    expect(browser.createGeneral).not.toHaveBeenCalled();
    expect(browser.redisplay).not.toHaveBeenCalled();
    expect(app.diagnostics().mode).toBe("legacy");
    expect(app.diagnostics().lease.running).toBe(null);
  } finally {
    cleanup.resolve();
    browser.state = null;
    await app.dispose();
    browser.settle.mockReset().mockResolvedValue(undefined);
    vi.unstubAllGlobals();
  }
});

test("mode return restores browsing camera only while the retained revision is unchanged", async () => {
  const app = await browserIntegration(),
    first = generalViewControl(),
    second = generalViewControl(),
    third = generalViewControl();
  const moved = { position: [3, 4, 7], target: [1, 0, 1] };
  browser.state = {
    phase: "idle",
    current: { sceneId: "kept", revisionId: "saved" },
  };
  browser.createGeneral
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
    .mockResolvedValueOnce(third);
  try {
    app.panelPorts.enterMode();
    for (let i = 0; i < 8; i++) await flush();
    first.setCamera(moved);
    app.enterLegacy();
    app.panelPorts.enterMode();
    for (let i = 0; i < 8; i++) await flush();
    expect(second.getCamera()).toEqual(moved);
    app.enterLegacy();
    browser.state = {
      phase: "idle",
      current: { sceneId: "kept", revisionId: "later-save" },
    };
    app.panelPorts.enterMode();
    for (let i = 0; i < 8; i++) await flush();
    expect(third.getCamera()).toEqual({
      position: [6, 5, 6],
      target: [0, 0, 0],
    });
    expect(browser.redisplay).toHaveBeenCalledTimes(3);
  } finally {
    browser.state = null;
    await app.dispose();
    browser.redisplay
      .mockReset()
      .mockResolvedValue({ ok: true, value: undefined });
    browser.createGeneral.mockReset();
    vi.unstubAllGlobals();
  }
});

test("a failed renderer retirement remains owned and blocks subsequent renderer allocation", async () => {
  const app = await browserIntegration(),
    first = generalViewControl(),
    second = generalViewControl();
  first.dispose.mockImplementation(() => {
    throw Error("controlled dispose failure");
  });
  browser.state = {
    phase: "idle",
    current: { sceneId: "kept", revisionId: "saved" },
  };
  browser.createGeneral.mockResolvedValueOnce(first).mockResolvedValue(second);
  try {
    app.panelPorts.enterMode();
    for (let i = 0; i < 8; i++) await flush();
    app.enterLegacy();
    for (let i = 0; i < 8; i++) await flush();
    app.panelPorts.enterMode();
    for (let i = 0; i < 8; i++) await flush();
    expect(browser.createGeneral).toHaveBeenCalledTimes(1);
    const retry = await app.panelPorts.controller.redisplayCurrent();
    expect(retry.ok).toBe(false);
    await expect(
      app.runLegacyIO("activate", async () => {}, 0),
    ).rejects.toThrow(/释放/);
    expect(app.panelPorts.controller.getState().current?.revisionId).toBe(
      "saved",
    );
  } finally {
    browser.state = null;
    await app.dispose();
    browser.redisplay
      .mockReset()
      .mockResolvedValue({ ok: true, value: undefined });
    browser.createGeneral.mockReset();
    vi.unstubAllGlobals();
  }
});
