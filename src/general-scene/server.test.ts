import { afterEach, expect, test, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
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
import * as planningModule from "./planner.ts";
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
  vi.restoreAllMocks();
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
  return new Promise<{
    status: number;
    body: any;
    headers: Record<string, unknown>;
  }>((resolve, reject) => {
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
            if (res.headers["content-type"]?.startsWith("application/json"))
              body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode!, body, headers: res.headers });
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
test("without a configured catalog the bundled starter library is used when present", async () => {
  const root = mkdtempSync(join(tmpdir(), "t5-starter-"));
  dirs.push(root);
  const empty = serverModule.createGeneralLibrarySource(undefined, root);
  expect((await empty(new AbortController().signal)).manifests).toHaveLength(0);
  const f = await generalFixture();
  await registerAsset({
    root: join(root, "starter-library"),
    packageBytes: await prepareAssetPackage(f.manifest, f.members),
    review: constructedReview(f.manifest),
  });
  const starter = serverModule.createGeneralLibrarySource(undefined, root);
  expect((await starter(new AbortController().signal)).manifests).toHaveLength(
    1,
  );
});
test("the shipped starter library loads with accepted, redistributable entries", async () => {
  const source = serverModule.createGeneralLibrarySource();
  const lib = await source(new AbortController().signal);
  expect(lib.manifests.map((m) => m.category).sort()).toEqual([
    "grass",
    "reed",
    "rock",
  ]);
  for (const item of [...lib.manifests, ...lib.styles]) {
    expect(item.quality.status).toBe("accepted");
    expect(item.provenance.license.redistributable).toBe(true);
  }
  expect(lib.styles).toHaveLength(1);
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

function openStream(base: string) {
  return new Promise<{
    status: number;
    contentType: string | undefined;
    reader: ReadableStreamDefaultReader<Uint8Array>;
  }>((resolve, reject) => {
    const req = httpRequest(
      base + general,
      {
        method: "POST",
        headers: { ...headers, accept: "application/x-ndjson" },
      },
      (res) =>
        resolve({
          status: res.statusCode!,
          contentType: res.headers["content-type"],
          reader: (
            Readable.toWeb(res) as ReadableStream<Uint8Array>
          ).getReader(),
        }),
    );
    req.on("error", reject);
    req.end(JSON.stringify(request()));
  });
}
const streamEvents = (body: unknown) => {
  expect(typeof body).toBe("string");
  expect((body as string).endsWith("\n")).toBe(true);
  return (body as string)
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
};
const streamOptions = { headers: { accept: "application/x-ndjson" } };

test("opt-in stream sends live bound phases before inference finishes and exactly one final outcome", async () => {
  const lib = await library(),
    p = await draft(lib);
  let release!: (value: any) => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const held = new Promise<any>((resolve) => (release = resolve));
  const transport = vi.fn(async (r: any) => {
    if (r.stage === "intent") return reply(intent());
    entered();
    return held;
  });
  const url = await start({ generalTransport: transport });
  const pending = openStream(url);
  await ready;
  // A non-streaming server will not resolve headers until the held final reply.
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  void pending.then((value) => (stream = value)).catch(() => {});
  try {
    await vi.waitFor(() => expect(stream).toBeDefined());
    expect(stream!.contentType).toMatch(/^application\/x-ndjson/);
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes('"phase":"planning"')) {
      const chunk = await stream!.reader.read();
      expect(chunk.done).toBe(false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).not.toContain('"type":"final"');
    release(reply(p));
    while (true) {
      const chunk = await stream!.reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const events = streamEvents(text);
    expect(
      events.map((event) =>
        event.type === "phase" ? event.phase : event.type,
      ),
    ).toEqual(["parsing", "querying", "planning", "final"]);
    expect(
      events.every(
        (event) =>
          event.operationId === request().operationId &&
          event.baseRevisionId === null,
      ),
    ).toBe(true);
    expect(events[3].outcome.ok).toBe(true);
    expect(events[3].outcome.request).toEqual(request());
    expect(events[3].outcome.value.evidence).toHaveLength(2);
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    release(reply(p));
    const opened = await pending;
    await opened.reader.cancel().catch(() => {});
  }
});

test("stream preserves catalog failure as one bound final without invented phases", async () => {
  const url = await start({
    generalLibrary: async () => {
      throw Error("catalog revoked");
    },
  });
  const result = await call(url, general, request(), streamOptions);
  expect(result.status).toBe(200);
  const events = streamEvents(result.body);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "final",
    operationId: "op-1",
    baseRevisionId: null,
    outcome: {
      ok: false,
      request: request(),
      mode: "manual",
      partial: { intent: null, draft: null, evidence: [] },
    },
  });
  expect(events[0].outcome.issues[0].message).toContain("catalog revoked");
});

test("stream failure during parsing has no artificial querying or planning events", async () => {
  const transport = vi.fn(async () => {
    throw Error("local model unavailable");
  });
  const url = await start({ generalTransport: transport });
  const result = await call(url, general, request(), streamOptions);
  const events = streamEvents(result.body);
  expect(events.map((event) => event.phase ?? event.type)).toEqual([
    "parsing",
    "final",
  ]);
  expect(events[1].outcome.ok).toBe(false);
  expect(events[1].outcome.partial.evidence).toHaveLength(1);
  expect(events[1].outcome.partial.evidence[0].raw).toBeNull();
  expect(transport).toHaveBeenCalledTimes(1);
});

test("stream counts multibyte final plus earlier phase records against the cumulative 2MiB cap", async () => {
  const limit = 2 * 1024 * 1024,
    outcome: planningModule.PlanningOutcome = {
      ok: false,
      request: request(),
      query: null,
      inputs: [],
      mode: "manual",
      partial: { intent: null, draft: null, evidence: [] },
      issues: [{ code: "large-result", path: "", message: "" }],
    },
    final = {
      type: "final",
      operationId: "op-1",
      baseRevisionId: null,
      outcome,
    };
  // The final alone fits; only real preceding protocol bytes push it over the limit.
  const overhead = Buffer.byteLength(JSON.stringify(final) + "\n", "utf8");
  outcome.issues[0].message = "水".repeat(Math.floor((limit - overhead) / 3));
  expect(
    Buffer.byteLength(JSON.stringify(final) + "\n", "utf8"),
  ).toBeLessThanOrEqual(limit);
  vi.spyOn(planningModule, "planRequest").mockImplementationOnce(
    async (_request, ports) => {
      for (const phase of ["parsing", "querying", "planning"] as const)
        ports.onPhase?.(phase);
      return outcome;
    },
  );
  const url = await start();
  const result = await call(url, general, request(), streamOptions);
  expect(Buffer.byteLength(result.body, "utf8")).toBeLessThanOrEqual(limit);
  const events = streamEvents(result.body);
  expect(events.map((event) => event.phase ?? event.type)).toEqual([
    "parsing",
    "querying",
    "planning",
    "final",
  ]);
  expect(events[3].outcome).toMatchObject({
    ok: false,
    request: request(),
    mode: "manual",
  });
  expect(events[3].outcome.issues[0].code).toBe("response-budget");
});

test("canceling the actual response reader aborts token counting and releases shared busy lock", async () => {
  let observed: AbortSignal | undefined;
  const url = await start({
    generalCountTokens: async (_input: string, signal: AbortSignal) => {
      observed = signal;
      return new Promise(() => {});
    },
  });
  const pending = openStream(url);
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  void pending.then((value) => (stream = value)).catch(() => {});
  await vi.waitFor(() => expect(stream).toBeDefined());
  await vi.waitFor(() => expect(observed).toBeDefined());
  expect(
    (await call(url, "/api/planner/generate", { prompt: "湿地" })).status,
  ).toBe(429);
  const first = await stream!.reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"phase":"parsing"');
  await stream!.reader.cancel();
  await vi.waitFor(() => expect(observed?.aborted).toBe(true));
  await vi.waitFor(async () =>
    expect(
      (await call(url, general, { ...request(), path: "forbidden" })).status,
    ).toBe(400),
  );
});

test.each([
  undefined,
  "application/json",
  "application/x-ndjson;q=0",
  "text/application/x-ndjson",
])("Accept %s retains the existing JSON outcome", async (accept) => {
  const url = await start();
  const result = await call(
    url,
    general,
    request(),
    accept ? { headers: { accept } } : {},
  );
  expect(result.status).toBe(200);
  expect(result.headers["content-type"]).toMatch(/^application\/json/);
  expect(result.body.ok).toBe(true);
});

test("opt-in does not bypass request authority, request size, or same-origin guards", async () => {
  const transport = vi.fn(async () => reply(intent()));
  const url = await start({ generalTransport: transport });
  expect(
    (await call(url, general, { ...request(), candidates: [] }, streamOptions))
      .status,
  ).toBe(400);
  expect(
    (
      await call(
        url,
        general,
        { ...request(), prompt: "a".repeat(65536) },
        streamOptions,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(url, general, request(), {
        headers: { ...streamOptions.headers, origin: "https://outside.test" },
      })
    ).status,
  ).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});

test("stream binds every event to a non-null parent revision and preserves the actual final request", async () => {
  const lib = await library(),
    input = { ...request(), baseRevisionId: "parent-revision" },
    parsed = {
      ...intent(),
      operation: "patch",
      baseRevisionId: input.baseRevisionId,
    },
    planned = await draft(lib, parsed);
  const url = await start({
    generalTransport: async (r: any) =>
      reply(r.stage === "intent" ? parsed : planned),
  });
  const result = await call(url, general, input, {
    headers: { accept: "application/json, Application/X-NDJSON; q=0.7" },
  });
  const events = streamEvents(result.body);
  expect(events).toHaveLength(4);
  expect(
    events.every(
      (event) =>
        event.operationId === input.operationId &&
        event.baseRevisionId === input.baseRevisionId,
    ),
  ).toBe(true);
  expect(events[3].outcome.ok).toBe(true);
  expect(events[3].outcome.request).toEqual(input);
  expect(events[3].outcome.value.intent.baseRevisionId).toBe(
    input.baseRevisionId,
  );
});

test("stream retains observed evidence when the guarded catalog changes before stage two", async () => {
  const lib = await library();
  let loads = 0;
  const transport = vi.fn(async () => reply(intent()));
  const url = await start({
    generalLibrary: async () =>
      ++loads < 3 ? lib : { ...lib, digest: "f".repeat(64) },
    generalTransport: transport,
  });
  const result = await call(url, general, request(), streamOptions);
  const events = streamEvents(result.body);
  expect(events.map((event) => event.phase ?? event.type)).toEqual([
    "parsing",
    "querying",
    "planning",
    "final",
  ]);
  expect(events[3].outcome.ok).toBe(false);
  expect(events[3].outcome.partial.intent.raw).toBe(request().prompt);
  expect(events[3].outcome.partial.evidence[0].raw).toBe(reply(intent()).raw);
  expect(events[3].outcome.partial.evidence[1].raw).toBeNull();
  expect(events[3].outcome.partial.evidence[1].failureReason).toContain(
    "素材目录",
  );
  expect(transport).toHaveBeenCalledTimes(1);
});
