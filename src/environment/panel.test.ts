import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mountEnvironmentPanel } from "./panel";
import type { EnvironmentReadContext } from "./store";
import {
  importEnvironment,
  type EnvironmentRecord,
  type EnvironmentAsset,
} from "./asset";
import {
  environmentSpz,
  environmentWorld,
  jsonBytes,
} from "../../tests/support/environment-fixture";

const state = vi.hoisted(() => ({
  list: vi.fn<() => Promise<EnvironmentRecord[]>>(),
  save: vi.fn<
    (
      record: EnvironmentRecord,
      context?: EnvironmentReadContext,
    ) => Promise<{ duplicate: boolean }>
  >(),
  viewAssets: [] as EnvironmentAsset[],
  viewReleaseReady: Promise.resolve() as Promise<unknown>,
  viewBacking: new ArrayBuffer(64),
}));
vi.mock("./store", () => ({
  createEnvironmentStore: () => ({ list: state.list, save: state.save }),
}));
vi.mock("./view", () => ({
  createEnvironmentView: () => {
    let asset: EnvironmentAsset | undefined,
      closed = false;
    let releasePromise = Promise.resolve();
    let backing: ArrayBuffer | undefined = state.viewBacking;
    const camera = () => ({
      position: [4, 3, 8] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
    });
    return {
      camera,
      reset() {},
      async stage(next: EnvironmentAsset, signal: AbortSignal) {
        asset = next;
        state.viewAssets.push(next);
        return {
          commit() {},
          rollback() {
            asset = undefined;
          },
          usable: () => !signal.aborted,
          camera,
        };
      },
      residency: () => ({
        buffers: [
          ...(asset ? [asset.spz.buffer] : []),
          ...(backing ? [backing] : []),
        ],
        extraBytes: 0,
        settled: !closed || backing === undefined,
      }),
      whenQuiescent: () => releasePromise,
      whenReleased: () => releasePromise,
      dispose() {
        closed = true;
        releasePromise = state.viewReleaseReady.then(() => {
          asset = undefined;
          backing = undefined;
        });
      },
    };
  },
}));
vi.mock("../io/download", () => ({ downloadBlob: vi.fn() }));

class Element {
  textContent = "";
  innerHTML = "";
  className = "";
  id = "";
  disabled = false;
  files?: File[];
  onclick?: () => void;
  onchange?: () => void;
  children: Element[] = [];
  elements = new Map<string, Element>();
  querySelector(selector: string) {
    if (!this.elements.has(selector))
      this.elements.set(selector, new Element());
    return this.elements.get(selector)!;
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute() {}
  remove() {}
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(condition()).toBe(true);
};
function gate() {
  const pending: { kind: string; run(): Promise<void> }[] = [];
  let owner = false;
  const checks: number[] = [],
    initials: number[] = [];
  return {
    pending,
    checks,
    initials,
    get owner() {
      return owner;
    },
    runIO<T>(
      kind: "activate" | "background",
      work: (reserve: (bytes: number) => void) => Promise<T>,
      initial?: number,
    ): Promise<T> {
      initials.push(initial ?? 0);
      return new Promise((resolve, reject) =>
        pending.push({
          kind,
          async run() {
            expect(owner).toBe(false);
            owner = true;
            try {
              resolve(
                await work((bytes) => {
                  checks.push(bytes);
                }),
              );
            } catch (e) {
              reject(e);
            } finally {
              owner = false;
            }
          },
        }),
      );
    },
    start() {
      const next = pending.shift();
      if (!next) throw Error("Missing queued IO");
      return next.run();
    },
  };
}
let host: Element,
  lease: ReturnType<typeof gate>,
  panel: ReturnType<typeof mountEnvironmentPanel>;
const element = (id: string) => host.querySelector(`#environment-${id}`);
beforeEach(() => {
  state.list.mockReset().mockResolvedValue([]);
  state.save.mockReset().mockResolvedValue({ duplicate: false });
  state.viewAssets = [];
  state.viewReleaseReady = Promise.resolve();
  state.viewBacking = new ArrayBuffer(64);
  vi.stubGlobal("document", { createElement: () => new Element() });
  host = new Element();
  lease = gate();
  panel = mountEnvironmentPanel(
    host as unknown as HTMLElement,
    new Element() as unknown as HTMLElement,
    { enter() {}, leave() {}, runIO: lease.runIO },
  );
});
afterEach(() => {
  panel.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function file(bytes: Uint8Array, held?: Promise<ArrayBuffer>) {
  return {
    size: bytes.byteLength,
    arrayBuffer: vi.fn(() => held ?? Promise.resolve(bytes.slice().buffer)),
  } as unknown as File;
}
function importFiles(spz = file(environmentSpz())) {
  const world = file(jsonBytes(environmentWorld()));
  element("world-file").files = [world];
  element("spz-file").files = [spz];
  element("import").onclick!();
  return { world, spz };
}

test("queued list and import do not allocate or block true quiescence", async () => {
  const { world, spz } = importFiles();
  await flush();
  expect(state.list).not.toHaveBeenCalled();
  expect(world.arrayBuffer).not.toHaveBeenCalled();
  expect(spz.arrayBuffer).not.toHaveBeenCalled();
  expect(panel.ioState()).toEqual({ running: 0, queued: 2 });
  let quiet = false;
  void panel.whenQuiescent().then(() => {
    quiet = true;
  });
  await flush();
  expect(quiet).toBe(true);
  await lease.start();
  await lease.start();
  await waitFor(() => !element("save").disabled);
  expect(state.viewAssets).toHaveLength(1);
});

test("close cancels UI but a started file read remains owned until it actually settles", async () => {
  await lease.start();
  const wait = deferred<ArrayBuffer>();
  importFiles(file(environmentSpz(), wait.promise));
  const work = lease.start();
  await flush();
  expect(panel.ioState().running).toBe(1);
  panel.close();
  expect(panel.active).toBe(false);
  let quiet = false;
  void panel.whenQuiescent().then(() => {
    quiet = true;
  });
  await flush();
  expect(quiet).toBe(false);
  expect(panel.residency().settled).toBe(false);
  wait.resolve(environmentSpz().buffer as ArrayBuffer);
  await work;
  await panel.whenQuiescent();
  expect(state.viewAssets).toHaveLength(0);
  expect(panel.ioState().running).toBe(0);
});

test("list callback SPZ buffers stay counted and dispose releases its own callbacks", async () => {
  const asset = await importEnvironment(
    jsonBytes(environmentWorld()),
    environmentSpz(),
  );
  state.list.mockResolvedValueOnce([
    {
      asset,
      camera: { position: [4, 3, 8], target: [0, 0, 0] },
      savedAt: "2026-10-18T00:00:00.000Z",
    },
  ]);
  await lease.start();
  expect(panel.residency().buffers).toContain(asset.spz.buffer);
  panel.dispose();
  expect(panel.residency().buffers).not.toContain(asset.spz.buffer);
  expect(element("list").children).toHaveLength(0);
});

test("a background save survives close and refresh starts only after its lease has returned", async () => {
  await lease.start();
  importFiles();
  await lease.start();
  await waitFor(() => !element("save").disabled);
  const save = deferred<{ duplicate: boolean }>();
  state.save.mockReturnValueOnce(save.promise);
  element("save").onclick!();
  await flush();
  expect(state.save).not.toHaveBeenCalled();
  const work = lease.start();
  await flush();
  expect(state.save).toHaveBeenCalledTimes(1);
  const persistedAsset = state.save.mock.calls[0][0].asset;
  panel.close();
  expect(panel.residency().buffers).toContain(persistedAsset.spz.buffer);
  expect(lease.pending).toHaveLength(0);
  save.resolve({ duplicate: false });
  await work;
  await flush();
  expect(lease.owner).toBe(false);
  expect(lease.pending).toHaveLength(1);
  expect(lease.pending[0].kind).toBe("background");
  await lease.start();
  await panel.whenQuiescent();
  expect(panel.active).toBe(false);
  expect(state.list).toHaveBeenCalledTimes(2);
});

test("closing a view retains its real backing until delayed renderer release", async () => {
  await lease.start();
  importFiles();
  await lease.start();
  await waitFor(() => !element("save").disabled);
  const asset = state.viewAssets[0],
    wait = deferred<void>();
  state.viewReleaseReady = wait.promise;
  panel.close();
  expect(panel.active).toBe(false);
  expect(panel.residency().buffers).toContain(state.viewBacking);
  expect(panel.residency().settled).toBe(false);
  let quiet = false;
  void panel.whenQuiescent().then(() => {
    quiet = true;
  });
  await flush();
  expect(quiet).toBe(false);
  wait.resolve();
  await panel.whenQuiescent();
  expect(panel.residency().buffers).not.toContain(asset.spz.buffer);
});

test("queued export keeps its source and the downloaded blob is held for its URL lifetime", async () => {
  await lease.start();
  importFiles();
  await lease.start();
  await waitFor(() => !element("save").disabled);
  vi.useFakeTimers();
  const asset = state.viewAssets[0];
  element("export").onclick!();
  panel.close();
  await flush();
  expect(panel.ioState()).toEqual({ running: 0, queued: 1 });
  expect(panel.residency().buffers).toContain(asset.spz.buffer);
  await lease.start();
  await panel.whenQuiescent();
  expect(panel.residency().extraBytes).toBeGreaterThan(asset.spz.byteLength);
  await vi.advanceTimersByTimeAsync(4999);
  expect(panel.residency().extraBytes).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(panel.residency().extraBytes).toBe(0);
});

test.each(["preview", "save", "export"] as const)(
  "%s reserves full backing clones from a valid short library view",
  async (kind) => {
    const asset = await importEnvironment(
      jsonBytes(environmentWorld()),
      environmentSpz(),
    );
    const backing = new Uint8Array(16 * 1024 ** 2);
    backing.set(asset.spz);
    asset.spz = backing.subarray(0, asset.spz.length);
    state.list.mockResolvedValueOnce([
      {
        asset,
        camera: { position: [4, 3, 8], target: [0, 0, 0] },
        savedAt: "2026-10-18T00:00:00.000Z",
      },
    ]);
    await lease.start();
    element("list").children[0].children[0].onclick!();
    await lease.start();
    await waitFor(() => !element("save").disabled);
    expect(state.viewAssets[0].spz.buffer.byteLength).toBe(16 * 1024 ** 2);
    if (kind === "preview") {
      expect(lease.checks.at(-1)).toBeGreaterThanOrEqual(16 * 1024 ** 2);
    } else if (kind === "save") {
      const first = lease.initials.length;
      element("save").onclick!();
      expect(lease.initials[first]).toBe(50 * 1024 ** 2);
      await lease.start();
      // The real store now owns stage-specific cursor/add reservations.
      expect(state.save.mock.calls[0][1]).toEqual({
        reserve: expect.any(Function),
        retain: expect.any(Function),
        release: expect.any(Function),
      });
    } else {
      vi.useFakeTimers();
      const first = lease.checks.length;
      element("export").onclick!();
      await lease.start();
      expect(lease.checks[first]).toBeGreaterThanOrEqual(56 * 1024 ** 2);
      await vi.advanceTimersByTimeAsync(5000);
    }
  },
);
