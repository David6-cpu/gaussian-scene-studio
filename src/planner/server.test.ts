import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import {
  createPlannerMiddleware,
  createOllamaTransport,
  readOllamaStatus,
  createLlamaTransport,
  readLlamaStatus,
} from "./server";
import { MODEL, LLAMA_MODEL, LLAMA_SMALL_MODEL, planScene, type Transport } from "./service";
import { parseDraft } from "./history";
import { proposalFromRecipe } from "./contract";
import { defaultRecipe } from "../recipe";
const raw = JSON.stringify(proposalFromRecipe(defaultRecipe));
const good = { raw, model: MODEL, done: true, doneReason: "stop" };
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});
async function start(
  transport: Transport = async () => good,
  extra: Parameters<typeof createPlannerMiddleware>[0] = {},
) {
  const middleware = createPlannerMiddleware({
    transport,
    status: async () => ({ available: false, model: MODEL, reason: "未安装" }),
    ...extra,
  });
  const s = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
function httpFetch(
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: init.method, headers: init.headers, signal: init.signal },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), { status: res.statusCode }),
          ),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
const headers = {
  host: "127.0.0.1:4173",
  origin: "http://127.0.0.1:4173",
  "content-type": "application/json",
};
it("v2 review endpoint preserves river intent and rejects conflicts before inference", async () => {
  const { defaultReviewRequestV2 } = await import("../review-v2/requirements");
  const request = { ...defaultReviewRequestV2, water: { mode: "river", explicitLevel: null } };
  let calls = 0;
  const url = await start(undefined, { reviewTransport: async () => { calls++; return { ...good, model: LLAMA_SMALL_MODEL, raw: JSON.stringify(request) }; } });
  const send = (prompt: string) => httpFetch(url + "/api/planner/review/requirements-v2", { method: "POST", headers, body: JSON.stringify({ prompt }) });
  const response = await send("河岸上放一些低矮草丛和石头");
  expect(response.status).toBe(200);
  expect((await response.json()).request.water).toEqual({ mode: "river", explicitLevel: null });
  expect(calls).toBe(1);
  const conflict = await send("水位0，不放水");
  expect(conflict.status).toBe(400);
  expect((await conflict.json()).error).toMatch(/澄清/);
  expect(calls).toBe(1);
  const badOrigin = await httpFetch(url + "/api/planner/review/requirements-v2", { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body: JSON.stringify({ prompt: "河岸" }) });
  expect(badOrigin.status).toBe(403);
  expect(calls).toBe(1);
});
it("serves only the frozen local catalog and allowlisted asset bytes", async()=>{
  const {preparedFixture}=await import("../../tests/support/prepared-fixture");
  const {makeCatalogContext}=await import("../assets/catalog/context");
  const {asset,zip}=await preparedFixture(),version=asset.definition.metadata.contentVersion;
  const context=await makeCatalogContext(asset,{contentVersion:version,licenseChecked:true,decision:"trial",limitations:["Test"],recordReference:"docs/validation/riverside-integration.md"});
  const url=await start(undefined,{catalog:{context,packageBytes:zip}});
  const cat=await httpFetch(url+"/api/planner/assets/catalog",{headers});expect(cat.status).toBe(200);expect(await cat.json()).toEqual(context);
  const path=`/api/planner/assets/package/test-prepared-ground/${version}`;
  const pkg=await httpFetch(url+path,{headers});expect(pkg.status).toBe(200);expect(new Uint8Array(await pkg.arrayBuffer())).toEqual(zip);
  for(const route of ["/api/planner/assets/catalog",path]){
    expect((await httpFetch(url+route,{method:"POST",headers,body:"{}"})).status).toBe(405);
    expect((await httpFetch(url+route,{headers:{...headers,origin:"https://evil.test"}})).status).toBe(403);
  }
  expect((await httpFetch(url+path+"bad",{headers})).status).toBe(404);
  const license=await httpFetch(url+"/assets/local-ground/test-prepared-ground/LICENSE.txt",{headers});expect(await license.text()).toBe(asset.definition.licenseText);
  expect((await httpFetch(url+"/assets/local-ground/test-prepared-ground/../../private",{headers})).status).toBe(404);
});
describe("local planner HTTP boundary", () => {
  it("routes explicit 3B separately and rejects invalid backend/model pairs", async () => {
    const small = "qwen2.5-3b-instruct-q4_k_m";
    const url = await start(async () => { throw Error("wrong Ollama route"); }, {
      llamaTransport: async () => { throw Error("wrong 7B route"); },
      llamaSmallTransport: async () => ({...good, model: small}),
      llamaSmallStatus: async () => ({model: small, available: true}),
    });
    const send = (body: unknown) => httpFetch(url + "/api/planner/generate", {method: "POST", headers, body: JSON.stringify(body)});
    const response = await send({prompt: "湿地", backend: "llama.cpp", model: small});
    expect(response.status).toBe(200);
    expect(parseDraft(await response.json())).toMatchObject({source: "llama.cpp", model: small});
    for (const body of [{prompt: "湿地", model: small}, {prompt: "湿地", backend: "ollama", model: small}, {prompt: "湿地", backend: "llama.cpp", model: "evil"}])
      expect((await send(body)).status).toBe(400);
    expect(await (await httpFetch(url + "/api/planner/status?backend=llama.cpp&model=" + small, {headers})).json()).toMatchObject({model: small, available: true});
  });

  it("routes only the explicitly selected backend, including failed attempts and status", async () => {
    let ollamaCalls = 0,
      llamaCalls = 0;
    const url = await start(
      async () => {
        ollamaCalls++;
        return good;
      },
      {
        llamaTransport: async () => {
          llamaCalls++;
          throw Error("llama offline");
        },
        llamaStatus: async () => ({
          backend: "llama.cpp",
          available: false,
          model: LLAMA_MODEL,
          reason: "offline",
        }),
      },
    );
    const generate = (body: unknown) =>
      httpFetch(url + "/api/planner/generate", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const llama = await generate({ prompt: "湿地", backend: "llama.cpp" });
    expect(await llama.json()).toMatchObject({
      source: "default",
      backend: "llama.cpp",
      attempts: [{ model: null }],
    });
    expect(ollamaCalls).toBe(0);
    expect(llamaCalls).toBe(1);
    expect((await (await generate({ prompt: "湿地" })).json()).backend).toBe(
      "ollama",
    );
    expect(
      (await (await generate({ prompt: "湿地", backend: "ollama" })).json())
        .source,
    ).toBe("ollama");
    for (const backend of [null, "other", "http://evil.test", {}, 1])
      expect((await generate({ prompt: "湿地", backend })).status).toBe(400);
    expect(ollamaCalls).toBe(2);
    const status = await httpFetch(
      url + "/api/planner/status?backend=llama.cpp",
      { headers },
    );
    expect(await status.json()).toMatchObject({
      backend: "llama.cpp",
      model: LLAMA_MODEL,
    });
    expect(
      (await httpFetch(url + "/api/planner/status?backend=evil", { headers }))
        .status,
    ).toBe(404);
  });
  it("accepts only a prompt and returns a separately reviewable proposal", async () => {
    const url = await start();
    const r = await httpFetch(url + "/api/planner/generate", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "湿地" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).source).toBe("ollama");
  });
  it.each([
    { origin: "https://evil.test" },
    { host: "evil.test" },
    { origin: "http://localhost:4173" },
    { origin: "null" },
    { "content-type": "text/plain" },
  ])("rejects cross-origin or non-JSON calls %j", async (change) => {
    const url = await start();
    const r = await httpFetch(url + "/api/planner/generate", {
      method: "POST",
      headers: { ...headers, ...change },
      body: '{"prompt":"湿地"}',
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  it("rejects missing Origin, excess fields and oversized input", async () => {
    const url = await start();
    for (const [body, h] of [
      [
        '{"prompt":"湿地"}',
        { host: headers.host, "content-type": "application/json" },
      ],
      ['{"prompt":"湿地","url":"https://evil.test"}', headers],
      ["x".repeat(8193), headers],
    ] as const) {
      const r = await httpFetch(url + "/api/planner/generate", {
        method: "POST",
        headers: h,
        body,
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
  });
  it("exposes only read-only model status", async () => {
    const url = await start();
    const r = await httpFetch(url + "/api/planner/status", {
      headers: { host: headers.host },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ available: false, model: MODEL });
  });
  it("allows one generation and propagates disconnected-client cancellation", async () => {
    let signal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const url = await start(async (_r, s) => {
      signal = s;
      entered();
      return new Promise(() => {});
    });
    const abort = new AbortController();
    const first = httpFetch(url + "/api/planner/generate", {
      method: "POST",
      headers,
      body: '{"prompt":"湿地"}',
      signal: abort.signal,
    }).catch(() => null);
    await started;
    const second = await httpFetch(url + "/api/planner/generate", {
      method: "POST",
      headers,
      body: '{"prompt":"湿地","backend":"llama.cpp"}',
    });
    expect(second.status).toBe(429);
    abort.abort();
    await first;
    await expect.poll(() => signal?.aborted).toBe(true);
  });
});
describe("Ollama adapter (controlled HTTP fixtures, not real inference)", () => {
  it("uses fixed loopback/model/schema and bounded resources", async () => {
    const transport = createOllamaTransport(async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/generate");
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: MODEL,
        stream: false,
        keep_alive: 0,
        options: { num_ctx: 4096, num_predict: 1024, temperature: 0 },
      });
      expect(body.format.additionalProperties).toBe(false);
      expect(body.system).toContain("20");
      return Response.json({
        response: raw,
        model: MODEL,
        done: true,
        done_reason: "stop",
      });
    });
    expect(
      await transport({ prompt: "湿地" }, new AbortController().signal),
    ).toEqual(good);
  });
  it("rejects oversized and malformed protocol replies", async () => {
    for (const r of [
      new Response("x".repeat(65537)),
      Response.json({ response: raw }),
      new Response("down", { status: 503 }),
    ]) {
      await expect(
        createOllamaTransport(async () => r)(
          { prompt: "湿地" },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
  });
  it("checks exact installed tag without pulling or calling generate", async () => {
    const status = await readOllamaStatus(async (url) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/tags");
      return Response.json({ models: [{ name: MODEL }] });
    });
    expect(status.available).toBe(true);
    expect(
      (
        await readOllamaStatus(async () => {
          throw Error("offline");
        })
      ).available,
    ).toBe(false);
  });
});

describe("llama.cpp adapter (controlled fixtures, not actual weights)", () => {
  it.each(["ollama", "llama.cpp"] as const)(
    "empty model identity becomes a reviewable transport fallback for %s",
    async (backend) => {
      const transport =
        backend === "ollama"
          ? createOllamaTransport(async () =>
              Response.json({
                model: "",
                response: raw,
                done: true,
                done_reason: "stop",
              }),
            )
          : createLlamaTransport(async () =>
              Response.json({
                model: "",
                choices: [
                  {
                    finish_reason: "stop",
                    message: { role: "assistant", content: raw },
                  },
                ],
              }),
            );
      const result = await planScene(
        "湿地",
        transport,
        new AbortController().signal,
        backend,
      );
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].model).toBeNull();
      expect(parseDraft(result)).toMatchObject({ source: "default", backend });
    },
  );
  it("sends bounded non-streaming chat with nested schema, repair context and fixed loopback alias", async () => {
    const signal = new AbortController().signal;
    const reply = await createLlamaTransport(async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:8080/v1/chat/completions");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBe(signal);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: LLAMA_MODEL,
        stream: false,
        max_tokens: 1024,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: { schema: { additionalProperties: false } },
        },
      });
      expect(body.messages[0].role).toBe("system");
      expect(JSON.parse(body.messages[1].content)).toEqual({
        description: "湿地",
        repair: { raw: "{}", error: "missing fields" },
      });
      expect(body).not.toHaveProperty("tools");
      return Response.json({
        model: LLAMA_MODEL,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: raw },
          },
        ],
      });
    })(
      { prompt: "湿地", repair: { raw: "{}", error: "missing fields" } },
      signal,
    );
    expect(reply).toEqual({ ...good, model: LLAMA_MODEL });
  });
  it.each([
    { model: LLAMA_MODEL, choices: [] },
    {
      model: LLAMA_MODEL,
      choices: [
        { finish_reason: "stop", message: { content: raw } },
        { finish_reason: "stop", message: { content: raw } },
      ],
    },
    {
      model: LLAMA_MODEL,
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: raw, tool_calls: [{}] },
        },
      ],
    },
    {
      model: LLAMA_MODEL,
      choices: [
        { finish_reason: null, message: { role: "assistant", content: raw } },
      ],
    },
    {
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: raw } },
      ],
    },
  ])("rejects unusable protocol replies %j", async (data) => {
    await expect(
      createLlamaTransport(async () => Response.json(data))(
        { prompt: "湿地" },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it("preserves truncation and actual alias for the independent validator", async () => {
    const reply = await createLlamaTransport(async () =>
      Response.json({
        model: "wrong-alias",
        choices: [
          {
            finish_reason: "length",
            message: { role: "assistant", content: raw },
          },
        ],
      }),
    )({ prompt: "湿地" }, new AbortController().signal);
    expect(reply).toMatchObject({ model: "wrong-alias", doneReason: "length" });
  });
  it("bounds response size and fails HTTP errors including redirects", async () => {
    for (const response of [
      new Response("x".repeat(65537)),
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com" },
      }),
      new Response(null, { status: 503 }),
    ])
      await expect(
        createLlamaTransport(async () => response)(
          { prompt: "湿地" },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
  });
  it("reports alias availability without claiming weight identity or triggering inference", async () => {
    const status = await readLlamaStatus(async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:8080/v1/models");
      expect(init?.redirect).toBe("error");
      return Response.json({ data: [{ id: LLAMA_MODEL }] });
    });
    expect(status).toMatchObject({
      backend: "llama.cpp",
      available: true,
      model: LLAMA_MODEL,
    });
    expect(status.reason).toContain("未核验");
    expect(
      (
        await readLlamaStatus(async () =>
          Response.json({ data: [{ id: "other" }] }),
        )
      ).available,
    ).toBe(false);
  });
});

it('asset stages use new routes while sharing same-origin and busy protection with legacy planning', async () => {
 const request = {biome:'wetland',unit:'display-unit',groundOrigin:'captured',rockOrigin:'either',plantOrigin:'either',rockCount:0,plantKind:'none',plantCount:0,seed:42,waterLevel:null,clarification:''};
 let release!:()=>void,entered!:()=>void;
 const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 const url=await start(undefined,{assetTransport:async(stage)=>{if(stage==='requirements'){entered();await held;}return {raw:JSON.stringify(stage==='requirements'?request:{choices:[{key:'ground',assetId:'riverside-ground-v1'}]}),model:'qwen2.5-3b-instruct-q4_k_m',done:true,doneReason:'stop'};}});
 const send=(path:string,body:unknown,origin=headers.origin)=>httpFetch(url+path,{method:'POST',headers:{...headers,origin},body:JSON.stringify(body)});
 expect((await send('/api/planner/assets/requirements',{prompt:'湿地'},'https://evil.test')).status).toBe(403);
 expect((await send('/api/planner/assets/choose',{request})).status).toBe(200);
 const first=send('/api/planner/assets/requirements',{prompt:'湿地'});await started;
 expect((await send('/api/planner/generate',{prompt:'湿地'})).status).toBe(429);release();
 expect((await first).status).toBe(200);
 const chosen=await send('/api/planner/assets/choose',{request});expect(chosen.status).toBe(200);expect((await chosen.json()).choices).toEqual([{key:'ground',assetId:'riverside-ground-v1'}]);
});
it('extended choose requires the frozen catalog fingerprint and refuses supplied candidates',async()=>{
 const {preparedFixture}=await import('../../tests/support/prepared-fixture');const {makeCatalogContext}=await import('../assets/catalog/context');const {defaultAssetRequest}=await import('../selection/contract');
 const {asset,zip}=await preparedFixture(),context=await makeCatalogContext(asset,{contentVersion:asset.definition.metadata.contentVersion,licenseChecked:true,decision:'trial',limitations:['test'],recordReference:'docs/validation/test.md'},'prepared-ground-only');
 let calls=0;const url=await start(undefined,{catalog:{context,packageBytes:zip},assetTransport:async()=>{calls++;return {raw:JSON.stringify({choices:[{key:'ground',assetId:asset.definition.metadata.id},{key:'rocks',assetId:'river-rock-v1'},{key:'plants',assetId:'river-low-grass-v2'}]}),model:LLAMA_SMALL_MODEL,done:true,doneReason:'stop'};}});
 for(const body of [{request:defaultAssetRequest},{request:defaultAssetRequest,catalogVersion:'asset-catalog-v1'},{request:defaultAssetRequest,catalogVersion:context.catalogVersion,entries:[]}])expect((await httpFetch(url+'/api/planner/assets/choose',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400);
 expect(calls).toBe(0);const res=await httpFetch(url+'/api/planner/assets/choose',{method:'POST',headers,body:JSON.stringify({request:defaultAssetRequest,catalogVersion:context.catalogVersion})});expect(res.status).toBe(200);expect((await res.json()).catalogVersion).toBe(context.catalogVersion);expect(calls).toBe(1);
});
