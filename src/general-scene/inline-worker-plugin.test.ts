import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import {
  inlineWorkerLifetimePlugin,
  ownInlineWorkerUrl,
} from "./inline-worker-plugin";

// Use the actual pinned Vite generator, not a successful fake product worker.
const viteCode = readFileSync(
  join(dirname(fileURLToPath(import.meta.resolve("vite"))), "chunks/node.js"),
  "utf8",
);
const anchor = 'code: workerConstructor === "Worker" ? ',
  start = viteCode.indexOf(anchor) + anchor.length,
  end = viteCode.indexOf(" : `${jsContent}", start);
if (start < anchor.length || end < start)
  throw Error("Installed Vite inline wrapper generator changed");
function wrapper(source = "self.onmessage = () => {};", workerType = "module") {
  return runInNewContext(viteCode.slice(start, end), {
    jsContent: `const jsContent = ${JSON.stringify(source)};`,
    workerType,
    workerConstructor: "Worker",
    workerTypeOption: `{
          type: "module",
          name: options?.name
        }`,
  }) as string;
}
function runtime(
  options: {
    rejectBlob?: boolean;
    rejectData?: boolean;
    rejectTerminate?: boolean;
  } = {},
) {
  const live = new Set<string>(),
    events: string[] = [];
  let next = 0;
  const url = {
    createObjectURL() {
      const value = `blob:constructed-${++next}`;
      live.add(value);
      events.push(`create:${value}`);
      return value;
    },
    revokeObjectURL(value: string) {
      live.delete(value);
      events.push(`revoke:${value}`);
    },
  };
  class WorkerDouble {
    listeners = new Map<string, () => void>();
    constructor(
      readonly url: string,
      readonly options: WorkerOptions,
    ) {
      events.push(`construct:${url.startsWith("blob:") ? "blob" : "data"}`);
      if (options.type !== "module") throw Error("Unexpected worker type");
      if (url.startsWith("blob:") && rejectBlob) throw Error("blob refused");
      if (url.startsWith("data:") && rejectData) throw Error("data refused");
    }
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, listener);
    }
    terminate() {
      events.push("native-terminate");
      if (rejectTerminate) throw Error("terminate failed");
    }
  }
  const { rejectBlob, rejectData, rejectTerminate } = options;
  const context: { factory?: new () => WorkerDouble; [key: string]: unknown } =
    {
      self: { Blob, URL: url },
      Blob,
      Worker: WorkerDouble,
    };
  runInNewContext(
    ownInlineWorkerUrl(wrapper()).replace(
      "export default function WorkerWrapper",
      "globalThis.factory = function WorkerWrapper",
    ),
    context,
  );
  return { create: () => new context.factory!(), live, events, url };
}

test("early termination releases the still-readable URL after native termination", () => {
  const r = runtime(),
    worker = r.create();
  expect(r.live.has(worker.url)).toBe(true);
  worker.terminate();
  expect(r.live.size).toBe(0);
  expect(r.events.slice(-2)).toEqual([
    "native-terminate",
    `revoke:${worker.url}`,
  ]);
});
test("normal worker entry revocation remains safe with subsequent termination", () => {
  const r = runtime(),
    worker = r.create();
  r.url.revokeObjectURL(worker.url);
  worker.terminate();
  expect(r.live.size).toBe(0);
});
test("worker error and double termination retain native calls and release the URL once", () => {
  const r = runtime(),
    worker = r.create();
  worker.listeners.get("error")!();
  expect(r.live.size).toBe(0);
  worker.terminate();
  worker.terminate();
  expect(r.events.filter((v) => v === "native-terminate")).toHaveLength(2);
  expect(r.events.filter((v) => v.startsWith("revoke:"))).toHaveLength(1);
});
test("termination failure still releases its URL", () => {
  const r = runtime({ rejectTerminate: true }),
    worker = r.create();
  expect(() => worker.terminate()).toThrow("terminate failed");
  expect(r.live.size).toBe(0);
});
test("constructor failure releases the Blob URL before the original data fallback", () => {
  const r = runtime({ rejectBlob: true }),
    worker = r.create();
  expect(worker.url).toMatch(/^data:text\/javascript/);
  expect(r.live.size).toBe(0);
  expect(r.events).toEqual([
    "create:blob:constructed-1",
    "construct:blob",
    "revoke:blob:constructed-1",
    "construct:data",
  ]);
});
test("failure of both constructors leaves no URL allocated", () => {
  const r = runtime({ rejectBlob: true, rejectData: true });
  expect(() => r.create()).toThrow("data refused");
  expect(r.live.size).toBe(0);
});
test("source text containing wrapper-looking strings is preserved byte for byte", () => {
  const source = 'const text = "return worker;\\nlet objURL;\\n} catch(e) {";',
    code = wrapper(source),
    rewritten = ownInlineWorkerUrl(code),
    header = code.slice(0, code.indexOf("\n"));
  expect(rewritten.slice(0, rewritten.indexOf("\n"))).toBe(header);
  expect(JSON.parse(header.slice("const jsContent = ".length, -1))).toBe(
    source,
  );
});
test.each([
  (code: string) =>
    code.replace("return worker;", "return worker; return worker;"),
  (code: string) => code.replace("let objURL;", "let renamedUrl;"),
  (code: string) => code.replace('type: "module",', 'type: "classic",'),
  (code: string) => code + "\n// upstream changed",
  (code: string) =>
    code.replace("const jsContent = ", "const jsContent = null; "),
])("unknown generated shape fails closed", (change) => {
  expect(() => ownInlineWorkerUrl(change(wrapper()))).toThrow();
});
test("the plugin is production-only and ignores every other worker/query", () => {
  const plugin = inlineWorkerLifetimePlugin();
  expect(plugin.apply).toBe("build");
  expect(plugin.enforce).toBe("pre");
  const transform = plugin.transform;
  if (typeof transform !== "function") throw Error("Expected transform hook");
  const invoke = (id: string) => transform.call({} as any, wrapper(), id);
  const entry = fileURLToPath(new URL("./build.worker.ts", import.meta.url));
  for (const id of [
    entry,
    entry + "?worker",
    entry + "?worker&inline&url",
    "other?worker&inline",
  ])
    expect(invoke(id)).toBeNull();
  expect(invoke(entry + "?worker&inline")).toEqual({
    code: ownInlineWorkerUrl(wrapper()),
    map: null,
    meta: { generalSceneInlineUrlOwned: true },
  });
});

test.each([
  null,
  { meta: {} },
  { meta: { generalSceneInlineUrlOwned: false } },
])("a bundle without the verified target module fails closed", (module) => {
  const hook = inlineWorkerLifetimePlugin().generateBundle;
  if (typeof hook !== "function") throw Error("Expected generateBundle hook");
  expect(() =>
    hook.call({ getModuleInfo: () => module } as any, {} as any, {}, false),
  ).toThrow(/ownership was not applied/);
});

test("bundle verification reads the exact target module ownership metadata", () => {
  const hook = inlineWorkerLifetimePlugin().generateBundle;
  if (typeof hook !== "function") throw Error("Expected generateBundle hook");
  const entry =
    fileURLToPath(new URL("./build.worker.ts", import.meta.url)) +
    "?worker&inline";
  const reads: string[] = [];
  hook.call(
    {
      getModuleInfo: (id: string) => {
        reads.push(id);
        return { meta: { generalSceneInlineUrlOwned: true } };
      },
    } as any,
    {} as any,
    {},
    false,
  );
  expect(reads).toEqual([entry]);
});
