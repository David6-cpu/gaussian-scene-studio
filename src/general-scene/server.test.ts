import { afterEach, expect, test, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as serverModule from "../planner/server.ts";
import {
  library,
  draft,
  intent,
  reply,
  request,
} from "../../tests/support/general-planning-fixture.ts";
import {
  generalFixture,
  constructedReview,
} from "../../tests/support/general-fixture.ts";
import { prepareAssetPackage } from "./asset-package.ts";
import { registerAsset } from "./asset-library-server.ts";
const servers: Server[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const headers = {
  host: "127.0.0.1:4173",
  origin: "http://127.0.0.1:4173",
  "content-type": "application/json",
};
async function start(extra: any = {}) {
  const lib = await library(),
    p = await draft(lib);
  const middleware = serverModule.createPlannerMiddleware({
    generalLibrary: async () => lib,
    generalTransport: async (r: any) =>
      reply(r.stage === "intent" ? intent() : p),
    generalCountTokens: async () => 100,
    ...extra,
  } as any);
  const s = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return `http://127.0.0.1:${(s.address() as any).port}`;
}
function call(
  base: string,
  path: string,
  body?: any,
  options: { headers?: any; signal?: AbortSignal } = {},
) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest(
      base + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, ...options.headers },
        signal: options.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let body: any = text;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode!, body });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const general = "/api/planner/general/plan";
test("general POST returns reviewable draft and read routes expose only catalog/member data", async () => {
  const url = await start();
  const r = await call(url, general, request());
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  const catalog = await call(url, "/api/planner/general/catalog");
  expect(catalog.status).toBe(200);
  expect(Object.keys(catalog.body).sort()).toEqual([
    "digest",
    "manifests",
    "styles",
  ]);
  const member = await call(
    url,
    "/api/planner/general/assets/test-rock/sha256-" +
      "a".repeat(64) +
      "/assets%2Fconstructed%2Fdata.ply",
  );
  expect(member.status).toBe(200);
  expect(
    (await call(url, "/api/planner/general/assets/test-rock/unknown/x")).status,
  ).toBe(404);
  expect(
    (
      await call(url, "/api/planner/general/catalog", undefined, {
        headers: { origin: "https://elsewhere.test" },
      })
    ).status,
  ).toBe(403);
});
test.each(["path", "catalogDigest", "candidates", "model", "url"])(
  "client cannot provide %s authority",
  async (key) => {
    const transport = vi.fn(async () => reply(intent()));
    const url = await start({ generalTransport: transport });
    expect(
      (await call(url, general, { ...request(), [key]: "attacker" })).status,
    ).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  },
);
test("new 64KiB intake permits bounded overrides while old 8KiB intake stays unchanged", async () => {
  const url = await start();
  const r = request();
  r.manualOverrides = [
    {
      key: "note",
      value: "a".repeat(10000),
      source: "manual",
      span: null,
      strength: "suggestion",
      negated: false,
    },
  ];
  const generalResult = await call(url, general, r);
  expect(generalResult.status).toBe(200);
  expect(
    generalResult.body.issues?.some((i: any) => /64KiB|8KiB/.test(i.message)) ??
      false,
  ).toBe(false);
  expect(
    (await call(url, "/api/planner/generate", { prompt: "a".repeat(10000) }))
      .status,
  ).toBe(400);
  expect(
    (await call(url, general, { ...request(), prompt: "a".repeat(65536) }))
      .status,
  ).toBe(400);
});
test.each([
  "/api/planner/generate",
  "/api/planner/assets/requirements",
  "/api/planner/assets/choose",
  "/api/planner/review/requirements-v2",
])("general count holds same lock against %s", async (path) => {
  let entered!: () => void, release!: (n: number) => void;
  const enteredPromise = new Promise<void>((r) => (entered = r));
  const held = new Promise<number>((r) => (release = r));
  const url = await start({
    generalCountTokens: async () => {
      entered();
      return held;
    },
  });
  const pending = call(url, general, request());
  void pending.catch(() => {});
  await Promise.race([
    enteredPromise,
    pending.then((r) => expect(r.status).toBe(200)),
  ]);
  try {
    expect((await call(url, path, { prompt: "湿地" })).status).toBe(429);
    expect((await call(url, "/api/planner/general/catalog")).status).toBe(200);
  } finally {
    release(100);
    await pending;
  }
});
test("old generation holds same lock against general planning", async () => {
  let entered!: () => void, release!: (v: any) => void;
  const enteredPromise = new Promise<void>((r) => (entered = r));
  const held = new Promise<any>((r) => (release = r));
  const url = await start({
    transport: async () => {
      entered();
      return held;
    },
  });
  const pending = call(url, "/api/planner/generate", { prompt: "湿地" });
  void pending.catch(() => {});
  await enteredPromise;
  try {
    expect((await call(url, general, request())).status).toBe(429);
  } finally {
    release(reply("{}"));
    await pending;
  }
});
test("disconnect aborts token counting and frees shared lock", async () => {
  let entered!: () => void, observed: AbortSignal | undefined;
  const ready = new Promise<void>((r) => (entered = r));
  const url = await start({
      generalCountTokens: async (_body: string, s: AbortSignal) => {
        observed = s;
        entered();
        return new Promise(() => {});
      },
    }),
    c = new AbortController();
  const pending = call(url, general, request(), { signal: c.signal }).catch(
    () => null,
  );
  await Promise.race([ready, pending.then((r) => expect(r?.status).toBe(200))]);
  c.abort();
  await pending;
  await vi.waitFor(() => expect(observed?.aborted).toBe(true));
  const r = await call(url, general, { ...request(), path: "invalid" });
  expect(r.status).toBe(400);
});
test("authority reload before stage two stops changed catalog and preserves first evidence", async () => {
  const lib = await library(),
    p = await draft(lib);
  let loads = 0;
  const transport = vi.fn(async (r: any) =>
    reply(r.stage === "intent" ? intent() : p),
  );
  const url = await start({
    generalLibrary: async () =>
      ++loads < 3 ? lib : { ...lib, digest: "f".repeat(64) },
    generalTransport: transport,
  });
  const out = await call(url, general, request());
  expect(out.body.ok).toBe(false);
  expect(out.body.partial.intent.raw).toBe(request().prompt);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(loads).toBe(3);
});
test("server-owned catalog source confines paths and reloads exact package bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "t5-library-"));
  dirs.push(root);
  const local = join(root, ".local");
  mkdirSync(local);
  const f = await generalFixture();
  const index = await registerAsset({
    root: join(local, "library"),
    packageBytes: await prepareAssetPackage(f.manifest, f.members),
    review: constructedReview(f.manifest),
  });
  const createSource = (serverModule as any).createGeneralLibrarySource;
  expect(typeof createSource).toBe("function");
  const source = createSource(index, root);
  const lib = await source(new AbortController().signal);
  expect(lib.manifests).toHaveLength(1);
  const data = JSON.parse(readFileSync(index, "utf8")),
    packagePath = join(local, "library", data.entries[0].package),
    bytes = readFileSync(packagePath);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(packagePath, bytes);
  await expect(source(new AbortController().signal)).rejects.toThrow(
    /digest|changed/,
  );
  const outside = join(root, "outside.json");
  writeFileSync(outside, "{}");
  expect(() => createSource(outside, root)).toThrow(/local/);
  const link = join(local, "escape.json");
  symlinkSync(outside, link);
  expect(() => createSource(link, root)).toThrow(/local/);
});

test("actual package replacement after counting is rejected before a generation request", async () => {
  const root = mkdtempSync(join(tmpdir(), "t5-authority-"));
  dirs.push(root);
  mkdirSync(join(root, ".local"));
  const f = await generalFixture(),
    index = await registerAsset({
      root: join(root, ".local", "library"),
      packageBytes: await prepareAssetPackage(f.manifest, f.members),
      review: constructedReview(f.manifest),
    });
  const source = serverModule.createGeneralLibrarySource(index, root),
    transport = vi.fn(async () => reply(intent()));
  const url = await start({
    generalLibrary: source,
    generalTransport: transport,
    generalCountTokens: async () => {
      const data = JSON.parse(readFileSync(index, "utf8")),
        path = join(root, ".local", "library", data.entries[0].package),
        bytes = readFileSync(path);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(path, bytes);
      return 100;
    },
  });
  const out = await call(url, general, request());
  expect(out.body.ok).toBe(false);
  expect(transport).not.toHaveBeenCalled();
  expect(out.body.partial.evidence[0].raw).toBeNull();
  expect(out.body.partial.evidence[0].failureReason).toMatch(/changed|digest/);
});
test("catalog load failure preserves validated request and provides manual failure outcome", async () => {
  const url = await start({
    generalLibrary: async () => {
      throw Error("revoked local catalog");
    },
  });
  const out = await call(url, general, request());
  expect(out.body).toMatchObject({
    ok: false,
    request: request(),
    partial: { intent: null, draft: null, evidence: [] },
    mode: "manual",
  });
});
