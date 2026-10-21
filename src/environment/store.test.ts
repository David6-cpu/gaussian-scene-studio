import { afterEach, expect, test, vi } from "vitest";
import { createEnvironmentStore } from "./store";
import { importEnvironment, type EnvironmentRecord } from "./asset";
import {
  environmentSpz,
  environmentWorld,
  jsonBytes,
} from "../../tests/support/environment-fixture";

function database(values: unknown[]) {
  const calls: string[] = [];
  const db = {
    close() {},
    onversionchange: null,
    transaction() {
      const tx = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore() {
          return {
            count: () => request("count", values.length),
            getAllKeys: () =>
              request(
                "keys",
                values.map((_, i) => String(i)),
              ),
            get: (key: string) => request(`get:${key}`, values[Number(key)]),
            getAll: () => request("getAll", values),
          };
        },
      };
      function request(kind: string, result: unknown) {
        calls.push(kind);
        const r = { result };
        queueMicrotask(() => tx.oncomplete?.());
        return r;
      }
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      const request = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  return calls;
}
const record = async (date: string): Promise<EnvironmentRecord> => ({
  asset: await importEnvironment(
    jsonBytes({ ...environmentWorld(), id: `fixture-${date}` }),
    environmentSpz(),
  ),
  camera: { position: [4, 3, 8], target: [0, 0, 0] },
  savedAt: date,
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("list validates one record at a time, preserves saved ordering, and observes each actual backing", async () => {
  const first = await record("2026-10-17T00:00:00.000Z"),
    last = await record("2026-10-18T00:00:00.000Z");
  const calls = database([first, last]),
    held = new Set<ArrayBuffer>(),
    observations: number[] = [];
  const records = await createEnvironmentStore().list({
    reserve: (next) => {
      observations.push([...held].reduce((n, b) => n + b.byteLength, next));
    },
    retain: (b) => {
      held.add(b);
    },
    release: (b) => {
      held.delete(b);
    },
  });
  expect(calls).toEqual(["count", "keys", "get:0", "get:1"]);
  expect(records.map((r) => r.savedAt)).toEqual([last.savedAt, first.savedAt]);
  expect(observations.length).toBeGreaterThanOrEqual(4);
  expect(held).toEqual(new Set(records.map((r) => r.asset.spz.buffer)));
  expect(held.has(first.asset.spz.buffer as ArrayBuffer)).toBe(false);
});

test("oversized backing is rejected before validation clone even for a short SPZ view", async () => {
  const value = await record("2026-10-18T00:00:00.000Z");
  const large = new Uint8Array(64 * 1024 ** 2 + 1);
  large.set(value.asset.spz);
  value.asset.spz = large.subarray(0, value.asset.spz.length);
  database([value]);
  const clone = vi.spyOn(globalThis, "structuredClone");
  await expect(createEnvironmentStore().list()).rejects.toThrow(
    /缓冲|backing|超限/,
  );
  expect(clone).not.toHaveBeenCalled();
});

test("count rejects a ninth record without materializing values", async () => {
  const calls = database(Array(9).fill(null));
  await expect(createEnvironmentStore().list()).rejects.toThrow(/8条/);
  expect(calls).toEqual(["count"]);
});

test("a stage budget rejection happens before clone and releases the in-flight read root", async () => {
  const value = await record("2026-10-18T00:00:00.000Z");
  database([value]);
  const held = new Set<ArrayBuffer>(),
    clone = vi.spyOn(globalThis, "structuredClone");
  await expect(
    createEnvironmentStore().list({
      reserve: () => {
        if (held.size) throw Error("stage budget");
      },
      retain: (b) => {
        held.add(b);
      },
      release: (b) => {
        held.delete(b);
      },
    }),
  ).rejects.toThrow("stage budget");
  expect(clone).not.toHaveBeenCalled();
  expect(held.size).toBe(0);
});

test("a legal subarray reserves its complete backing before the validation clone", async () => {
  const value = await record("2026-10-18T00:00:00.000Z"),
    whole = new Uint8Array(2 * 1024 ** 2);
  whole.set(value.asset.spz);
  value.asset.spz = whole.subarray(0, value.asset.spz.length);
  database([value]);
  const held = new Set<ArrayBuffer>(),
    allocationChecks: number[] = [];
  const result = await createEnvironmentStore().list({
    reserve: (increment) => {
      if (held.has(whole.buffer)) allocationChecks.push(increment);
    },
    retain: (buffer) => {
      held.add(buffer);
    },
    release: (buffer) => {
      held.delete(buffer);
    },
  });
  expect(allocationChecks).toEqual([36 * 1024 ** 2]);
  expect(result[0].asset.spz.buffer.byteLength).toBe(2 * 1024 ** 2);
});

test("a record disappearing between the keys and value reads safely rejects", async () => {
  const calls = database([undefined]),
    held = new Set<ArrayBuffer>();
  const clone = vi.spyOn(globalThis, "structuredClone");
  await expect(
    createEnvironmentStore().list({
      reserve() {},
      retain: (b) => {
        held.add(b);
      },
      release: (b) => {
        held.delete(b);
      },
    }),
  ).rejects.toThrow();
  expect(calls).toEqual(["count", "keys", "get:0"]);
  expect(clone).not.toHaveBeenCalled();
  expect(held.size).toBe(0);
});

test("cumulative full backing capacity rejects the third copy before cloning it", async () => {
  const values = await Promise.all(
    [
      "2026-10-16T00:00:00.000Z",
      "2026-10-17T00:00:00.000Z",
      "2026-10-18T00:00:00.000Z",
    ].map(record),
  );
  const backing = new Uint8Array(64 * 1024 ** 2);
  backing.set(values[0].asset.spz);
  for (const value of values)
    value.asset.spz = backing.subarray(0, value.asset.spz.length);
  database(values);
  const clone = vi.spyOn(globalThis, "structuredClone");
  await expect(createEnvironmentStore().list()).rejects.toThrow(/缓冲|超限/);
  expect(clone).toHaveBeenCalledTimes(2);
});

function writeDatabase(
  values: EnvironmentRecord[],
  holdWriteCompletion = false,
) {
  const calls: string[] = [];
  let completeWrite: (() => void) | undefined;
  const db = {
    close: vi.fn(),
    onversionchange: null,
    transaction(_name: string, mode: string) {
      calls.push(`transaction:${mode}`);
      let pending = 0,
        aborted = false,
        completed = false;
      const additions: EnvironmentRecord[] = [];
      const tx = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        abort() {
          aborted = true;
          calls.push("abort");
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore() {
          return {
            count: () => request("count", values.length),
            getAllKeys: () =>
              request(
                "keys",
                values.map((v) => v.asset.id),
              ),
            get: (key: string) =>
              request(
                "get",
                values.find((v) => v.asset.id === key),
              ),
            getAll: () => request("getAll", values),
            add: (value: EnvironmentRecord) => {
              additions.push(value);
              return request("add", value.asset.id);
            },
            openCursor() {
              calls.push("cursor");
              pending++;
              let index = 0;
              const r = {
                result: null as unknown,
                onsuccess: null as (() => void) | null,
              };
              const emit = () => {
                if (aborted) return;
                let continued = false;
                calls.push(`cursor:${index}`);
                r.result =
                  index < values.length
                    ? {
                        value: values[index],
                        continue() {
                          continued = true;
                          index++;
                          queueMicrotask(emit);
                        },
                      }
                    : null;
                r.onsuccess?.();
                if (!continued) {
                  pending--;
                  finish();
                }
              };
              queueMicrotask(emit);
              return r;
            },
          };
        },
      };
      function finish() {
        if (pending || aborted || completed) return;
        const complete = () => {
          if (aborted || completed) return;
          completed = true;
          values.push(...additions);
          calls.push("complete");
          tx.oncomplete?.();
        };
        if (mode === "readwrite" && holdWriteCompletion)
          completeWrite = complete;
        else queueMicrotask(complete);
      }
      function request(kind: string, result: unknown) {
        calls.push(kind);
        pending++;
        const r = { result, onsuccess: null as (() => void) | null };
        queueMicrotask(() => {
          if (aborted) return;
          r.onsuccess?.();
          pending--;
          finish();
        });
        return r;
      }
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      const r = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => r.onsuccess?.());
      return r;
    },
  });
  return { calls, values, complete: () => completeWrite?.(), db };
}
function backed(value: EnvironmentRecord, bytes: number) {
  const buffer = new Uint8Array(bytes);
  buffer.set(value.asset.spz);
  value.asset.spz = buffer.subarray(0, value.asset.spz.length);
  return value;
}
const settle = async () => {
  // Hashing uses WebCrypto; allow its completion as well as IDB-shaped callbacks.
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

test("save rejects an oversized input backing before validation cloning", async () => {
  const value = backed(
    await record("2026-10-18T00:00:00.000Z"),
    64 * 1024 ** 2 + 1,
  );
  const db = writeDatabase([]),
    clone = vi.spyOn(globalThis, "structuredClone");
  await expect(createEnvironmentStore().save(value)).rejects.toThrow(
    /缓冲|超限/,
  );
  expect(clone).not.toHaveBeenCalled();
  expect(db.calls).toEqual([]);
});

test("save counts full backing capacity before adding a third legal short view", async () => {
  const values = await Promise.all(
    [
      "2026-10-16T00:00:00.000Z",
      "2026-10-17T00:00:00.000Z",
      "2026-10-18T00:00:00.000Z",
    ].map(record),
  );
  const existing = values.slice(0, 2).map((v) => backed(v, 64 * 1024 ** 2));
  const db = writeDatabase(existing);
  await expect(createEnvironmentStore().save(values[2])).rejects.toThrow(
    /128MiB|超限/,
  );
  expect(db.calls).not.toContain("getAll");
  expect(db.calls).not.toContain("add");
  expect(db.calls.filter((c) => c.startsWith("transaction:"))).toEqual([
    "transaction:readwrite",
  ]);
  expect(existing).toHaveLength(2);
});

test("an old oversized library is stopped at the first cumulative cursor violation", async () => {
  const values = await Promise.all(
    [
      "2026-10-14T00:00:00.000Z",
      "2026-10-15T00:00:00.000Z",
      "2026-10-16T00:00:00.000Z",
      "2026-10-17T00:00:00.000Z",
    ].map(record),
  );
  const db = writeDatabase(values.map((v) => backed(v, 64 * 1024 ** 2)));
  const incoming = await record("2026-10-18T00:00:00.000Z");
  await expect(createEnvironmentStore().save(incoming)).rejects.toThrow(
    /128MiB|超限/,
  );
  expect(db.calls).not.toContain("getAll");
  expect(db.calls).toContain("cursor:2");
  expect(db.calls).not.toContain("cursor:3");
  expect(db.calls).not.toContain("add");
});

test("save success waits for transaction completion and the next list reopens the saved record", async () => {
  const first = await record("2026-10-17T00:00:00.000Z"),
    next = await record("2026-10-18T00:00:00.000Z");
  const db = writeDatabase([first], true),
    store = createEnvironmentStore();
  let done = false;
  const saving = store.save(next).then((result) => {
    done = true;
    return result;
  });
  await settle();
  expect(db.calls).toContain("add");
  expect(done).toBe(false);
  expect(db.values).toHaveLength(1);
  db.complete();
  await expect(saving).resolves.toEqual({ duplicate: false });
  const result = await store.list();
  expect(result.map((r) => r.asset.id)).toEqual([
    next.asset.id,
    first.asset.id,
  ]);
  const originalCamera = structuredClone(next.camera);
  const changedCamera = structuredClone(next);
  changedCamera.camera.position = [20, 10, 12];
  const duplicate = store.save(changedCamera);
  await settle();
  db.complete();
  await expect(duplicate).resolves.toEqual({ duplicate: true });
  expect(db.values).toHaveLength(2);
  expect(db.values[1].camera).toEqual(originalCamera);
});

test("save observes actual clone and cursor roots and can reject before the native add copy", async () => {
  const value = await record("2026-10-18T00:00:00.000Z"),
    held = new Set<ArrayBuffer>();
  const db = writeDatabase([]);
  await expect(
    createEnvironmentStore().save(value, {
      reserve(increment) {
        if (held.size && increment < 64 * 1024 ** 2)
          throw Error("native add budget");
      },
      retain: (b) => {
        held.add(b);
      },
      release: (b) => {
        held.delete(b);
      },
    }),
  ).rejects.toThrow("native add budget");
  expect(db.calls).not.toContain("add");
  expect(held.size).toBe(0);
});
