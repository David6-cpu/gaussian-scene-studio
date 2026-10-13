import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { fetchBytes, apiJson } from "./http.mjs";
test("HTTP rejection retains numeric status without exposing response body, URL, headers or status text", async () => {
  const secret = "offline-sensitive-marker";
  await assert.rejects(
    apiJson("/worlds:generate", {
      key: secret,
      body: "{}",
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: secret, request_id: secret }), {
          status: 422,
          statusText: secret,
          headers: { "x-request-id": secret, "set-cookie": secret },
        }),
    }),
    (error) => {
      assert.equal(error.httpStatus, 422);
      assert.match(error.message, /HTTP 422/);
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});
test("real fetch accepts gzip JSON with compressed Content-Length and still enforces decoded size", async (t) => {
  const body = JSON.stringify({ operation_id: "op-compressed", done: false });
  const packed = gzipSync(body);
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": String(packed.length),
    });
    res.end(packed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/gzip-fixture`;
  const value = await apiJson("/worlds:generate", {
    key: "local-test-only",
    body: "{}",
    fetchImpl: (_url, init) => fetch(url, init),
  });
  assert.deepEqual(value, { operation_id: "op-compressed", done: false });
  const expanded = "a".repeat(1000);
  await assert.rejects(
    fetchBytes(
      "https://example.invalid/gzip",
      {},
      200,
      async () =>
        new Response(expanded, {
          headers: { "Content-Encoding": "gzip", "Content-Length": "29" },
        }),
    ),
    /response-size-rejected/,
  );
});
test("streaming byte limit cancels an oversized response without trusting Content-Length", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    fetchBytes("https://example.invalid/test", {}, 8, async () => response),
    /response-size-rejected/,
  );
  assert.equal(cancelled, true);
});
test("declared length mismatch is rejected", async () => {
  await assert.rejects(
    fetchBytes(
      "https://example.invalid/test",
      {},
      8,
      async () => new Response("x", { headers: { "content-length": "2" } }),
    ),
    /response-length-mismatch/,
  );
});
test("real local stalled HTTP response is aborted within the configured deadline", async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write("partial");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  const started = Date.now();
  await assert.rejects(
    fetchBytes(url, {}, 1024, fetch, 50),
    /network-or-timeout/,
  );
  assert.ok(Date.now() - started < 2000);
});
test("real local HTTP redirect is never followed, including for an authenticated API simulation", async (t) => {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(302, { Location: "/leak-target" });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  await assert.rejects(
    apiJson("/operations/op-1", {
      key: "local-test-only",
      fetchImpl: (_url, init) => fetch(url, init),
    }),
    /network-or-timeout/,
  );
  assert.deepEqual(paths, ["/fixture"]);
});
