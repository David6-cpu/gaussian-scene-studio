import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareTrial,
  readTrial,
  submitTrial,
  pollTrial,
  downloadTrial,
} from "./trial.mjs";
import { TRIAL_REQUEST, REQUEST_SHA } from "./request.mjs";
import { sha256 } from "./request.mjs";
import { simulatedWorld, simulatedOperation } from "./test-support.mjs";
import { environmentSpz } from "../../tests/support/environment-fixture.ts";

const date = "2026-10-09";
const approved = (fetchImpl) => ({
  approvePaidOnce: true,
  requestSha: REQUEST_SHA,
  priceDate: date,
  now: new Date(`${date}T12:00:00Z`),
  key: "offline-test-key",
  fetchImpl,
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
for (const code of [400, 401, 402, 403, 404, 422, 429, 500])
  test(`HTTP ${code} records safe diagnostics without mutating attempt evidence or enabling another POST`, async (t) => {
    const dir = await setup(t);
    let calls = 0,
      markerHash;
    const options = approved(async () => {
      calls++;
      markerHash = sha256(await readFile(join(dir, "submission.json")));
      return new Response(
        JSON.stringify({
          detail: "offline-test-key",
          request_id: "offline-test-key",
        }),
        { status: code, statusText: "offline-test-key" },
      );
    });
    await assert.rejects(submitTrial(dir, options), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${code}`));
      assert.ok(!error.message.includes("offline-test-key"));
      return true;
    });
    const diagnostic = JSON.parse(
      await readFile(join(dir, "submit-error.json"), "utf8"),
    );
    assert.equal(diagnostic.httpStatus, code);
    assert.equal(diagnostic.requestSha, REQUEST_SHA);
    assert.equal(diagnostic.responseBodyStored, false);
    assert.ok(!JSON.stringify(diagnostic).includes("offline-test-key"));
    assert.equal(
      sha256(await readFile(join(dir, "submission.json"))),
      markerHash,
    );
    assert.equal((await readTrial(dir)).status, "submission-unknown");
    assert.equal((await readTrial(dir)).actualCredits, null);
    await assert.rejects(submitTrial(dir, options));
    assert.equal(calls, 1);
  });
test("failure to save safe diagnostics still reports HTTP status and never overwrites existing evidence", async (t) => {
  const dir = await setup(t);
  let calls = 0;
  await writeFile(join(dir, "submit-error.json"), "existing-evidence");
  const options = approved(async () => {
    calls++;
    return json({}, 403);
  });
  await assert.rejects(
    submitTrial(dir, options),
    /HTTP 403.*diagnostic-not-saved/,
  );
  assert.equal(
    await readFile(join(dir, "submit-error.json"), "utf8"),
    "existing-evidence",
  );
  await assert.rejects(submitTrial(dir, options));
  assert.equal(calls, 1);
});
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "wetland-trial-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await prepareTrial(dir);
  return dir;
}
test("prepare is repeatable and freezes one private text request without contacting a provider", async (t) => {
  const dir = await setup(t);
  const state = await prepareTrial(dir);
  assert.equal(state.status, "prepared");
  assert.equal(state.requestSha, REQUEST_SHA);
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "request.json"), "utf8")),
    TRIAL_REQUEST,
  );
  assert.equal(TRIAL_REQUEST.model, "marble-1.1");
  assert.equal(TRIAL_REQUEST.world_prompt.type, "text");
  assert.equal(TRIAL_REQUEST.world_prompt.disable_recaption, true);
  assert.deepEqual(TRIAL_REQUEST.permission, {
    public: false,
    allow_id_access: false,
    allowed_readers: [],
    allowed_writers: [],
  });
  assert.equal(state.estimatedUsd, 1.264);
  assert.equal(state.budgetUsd, 1.3);
  assert.equal(state.actualCredits, null);
});
test("submit requires consent, matching digest, current price review and key before consuming the attempt", async (t) => {
  const dir = await setup(t);
  let calls = 0;
  const options = approved(async () => {
    calls++;
    return json({ operation_id: "op-1", done: false });
  });
  for (const change of [
    { approvePaidOnce: false },
    { requestSha: "0".repeat(64) },
    { priceDate: "2026-10-08" },
    { key: "" },
  ]) {
    await assert.rejects(submitTrial(dir, { ...options, ...change }));
    assert.equal((await readTrial(dir)).status, "prepared");
  }
  assert.equal(calls, 0);
  await submitTrial(dir, options);
  assert.equal(calls, 1);
});
test("simultaneous submits and process restart can only send one POST with exact body", async (t) => {
  const dir = await setup(t);
  const calls = [];
  const options = approved(async (url, init) => {
    calls.push({ url, init });
    return json({ operation_id: "op-1", done: false });
  });
  const results = await Promise.allSettled([
    submitTrial(dir, options),
    submitTrial(dir, options),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.worldlabs.ai/marble/v1/worlds:generate",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), TRIAL_REQUEST);
  assert.equal(calls[0].init.headers["WLT-Api-Key"], "offline-test-key");
  const marker = JSON.parse(
    await readFile(join(dir, "submission.json"), "utf8"),
  );
  assert.equal(marker.requestSha, REQUEST_SHA);
  assert.equal((await readTrial(dir)).operationId, "op-1");
  await prepareTrial(dir);
  await assert.rejects(submitTrial(dir, options));
  assert.equal(calls.length, 1);
});
for (const [label, response] of [
  [
    "connection failure",
    async () => {
      throw Error("offline-test-key https://bad.invalid/?secret=test");
    },
  ],
  ["HTTP rejection", async () => json({ secret: "offline-test-key" }, 429)],
  ["malformed JSON", async () => new Response("{oops")],
  ["missing operation ID", async () => json({ done: false })],
])
  test(`${label} preserves a spent attempt and never retries or prints response content`, async (t) => {
    const dir = await setup(t);
    let calls = 0;
    const options = approved(async (...args) => {
      calls++;
      return response(...args);
    });
    await assert.rejects(
      submitTrial(dir, options),
      (error) => !error.message.includes("offline-test-key"),
    );
    assert.equal((await readTrial(dir)).status, "submission-unknown");
    await assert.rejects(submitTrial(dir, options));
    assert.equal(calls, 1);
    assert.ok(
      !(await readFile(join(dir, "state.json"), "utf8")).includes(
        "offline-test-key",
      ),
    );
  });
test("edited frozen request is rejected before network or attempt marker", async (t) => {
  const dir = await setup(t);
  let calls = 0;
  await writeFile(
    join(dir, "request.json"),
    JSON.stringify({ ...TRIAL_REQUEST, model: "marble-1.1-plus" }),
  );
  await assert.rejects(
    submitTrial(
      dir,
      approved(async () => {
        calls++;
        return json({ operation_id: "op-1", done: false });
      }),
    ),
  );
  assert.equal(calls, 0);
});
async function submitted(t) {
  const dir = await setup(t);
  await submitTrial(
    dir,
    approved(async () => json({ operation_id: "op-1", done: false })),
  );
  return dir;
}
async function completed(t, operation = simulatedOperation()) {
  const dir = await submitted(t);
  await pollTrial(dir, {
    key: "offline-test-key",
    fetchImpl: async () => json(operation),
  });
  return dir;
}
test("poll after restart is one GET, then downloads only100k without API key, caches verified bytes", async (t) => {
  const dir = await submitted(t);
  const calls = [];
  await pollTrial(dir, {
    key: "offline-test-key",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json(simulatedOperation());
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.worldlabs.ai/marble/v1/operations/op-1",
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal((await readTrial(dir)).actualCredits, 1580);
  const assetCalls = [];
  const result = await downloadTrial(dir, {
    fetchImpl: async (url, init) => {
      assetCalls.push({ url, init });
      return new Response(environmentSpz(3, 3));
    },
  });
  assert.equal(result.status, "downloaded");
  assert.equal(result.quality, "visual-pending");
  assert.equal(assetCalls.length, 1);
  assert.equal(
    assetCalls[0].url,
    simulatedWorld().assets.splats.spz_urls["100k"],
  );
  assert.equal(
    new Headers(assetCalls[0].init.headers).has("WLT-Api-Key"),
    false,
  );
  const sidecar = JSON.parse(
    await readFile(join(dir, "request-record.json"), "utf8"),
  );
  assert.equal(sidecar.status, "completed");
  assert.equal(sidecar.request_id, "op-1");
  assert.deepEqual(sidecar.request, TRIAL_REQUEST);
  await downloadTrial(dir, {
    fetchImpl: async () => {
      throw Error("cache must avoid network");
    },
  });
  assert.equal(
    JSON.parse(await readFile(join(dir, "download.json"), "utf8")).count,
    3,
  );
  const files = [
    "request.json",
    "state.json",
    "world.json",
    "request-record.json",
    "submission.json",
    "download.json",
  ];
  for (const f of files)
    assert.ok(
      !(await readFile(join(dir, f), "utf8")).includes("offline-test-key"),
    );
});
test("running and failed operations do not download; no cost does not mean zero", async (t) => {
  const dir = await submitted(t);
  await pollTrial(dir, {
    key: "offline-test-key",
    fetchImpl: async () => json({ operation_id: "op-1", done: false }),
  });
  assert.equal((await readTrial(dir)).status, "running");
  await assert.rejects(
    downloadTrial(dir, {
      fetchImpl: async () => {
        throw Error("must not download");
      },
    }),
  );
  await pollTrial(dir, {
    key: "offline-test-key",
    fetchImpl: async () =>
      json({
        operation_id: "op-1",
        done: true,
        error: { message: "offline-test-key" },
      }),
  });
  assert.equal((await readTrial(dir)).status, "provider-failed");
  assert.equal((await readTrial(dir)).actualCredits, null);
  await assert.rejects(
    submitTrial(
      dir,
      approved(async () => {
        throw Error("no repeat");
      }),
    ),
  );
});
test("ambiguous submit recovers with explicit operation ID and request hash using GET only", async (t) => {
  const dir = await setup(t);
  await assert.rejects(
    submitTrial(
      dir,
      approved(async () => {
        throw Error("disconnect");
      }),
    ),
  );
  const calls = [];
  const options = {
    key: "offline-test-key",
    operationId: "op-1",
    requestSha: REQUEST_SHA,
    fetchImpl: async (url, init) => {
      calls.push(init.method);
      return json(simulatedOperation());
    },
  };
  await assert.rejects(pollTrial(dir, { ...options, requestSha: "invalid" }));
  assert.deepEqual(calls, []);
  await pollTrial(dir, options);
  assert.deepEqual(calls, ["GET"]);
  assert.equal((await readTrial(dir)).operationId, "op-1");
});
test("incomplete completion snapshot uses GET world, normalizes direct and legacy wrapper shape", async (t) => {
  for (const wrapper of [false, true]) {
    const dir = await submitted(t);
    const calls = [];
    await pollTrial(dir, {
      key: "offline-test-key",
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method });
        if (calls.length === 1)
          return json({
            operation_id: "op-1",
            done: true,
            response: { world_id: "offline-world-1" },
          });
        const world = simulatedWorld();
        if (wrapper) {
          world.id = world.world_id;
          delete world.world_id;
          return json({ world });
        }
        return json(world);
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(
      calls[1].url,
      "https://api.worldlabs.ai/marble/v1/worlds/offline-world-1",
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "GET"],
    );
    assert.equal((await readTrial(dir)).status, "completed");
    assert.equal((await readTrial(dir)).actualCredits, null);
  }
});
for (const [name, mutate] of [
  [
    "wrong operation",
    (op) => {
      op.operation_id = "op-other";
    },
  ],
  [
    "wrong model",
    (op) => {
      op.response.model = "marble-1.1-plus";
    },
  ],
  [
    "wrong prompt",
    (op) => {
      op.response.world_prompt.text_prompt = "unrelated task";
    },
  ],
  [
    "public world",
    (op) => {
      op.response.permission.public = true;
    },
  ],
  [
    "ID access enabled",
    (op) => {
      op.response.permission.allow_id_access = true;
    },
  ],
  [
    "missing privacy",
    (op) => {
      delete op.response.permission;
    },
  ],
  [
    "conflicting world IDs",
    (op) => {
      op.response.id = "different-world";
    },
  ],
  [
    "invalid transform",
    (op) => {
      op.response.assets.splats.semantics_metadata.metric_scale_factor = 0;
    },
  ],
])
  test(`${name} cannot admit a completed world`, async (t) => {
    const dir = await submitted(t);
    const op = simulatedOperation();
    mutate(op);
    await assert.rejects(
      pollTrial(dir, {
        key: "offline-test-key",
        fetchImpl: async () => json(op),
      }),
    );
    assert.notEqual((await readTrial(dir)).status, "completed");
  });
for (const url of [
  "http://cdn.marble.worldlabs.ai/a.spz",
  "https://worldlabs.ai.evil.invalid/a.spz",
  "https://a:b@cdn.marble.worldlabs.ai/a.spz",
  "https://127.0.0.1/a.spz",
  "https://cdn.marble.worldlabs.ai/a.spz#x",
])
  test(`rejects untrusted asset URL ${url}`, async (t) => {
    const op = simulatedOperation();
    op.response.assets.splats.spz_urls["100k"] = url;
    const dir = await submitted(t);
    await assert.rejects(
      pollTrial(dir, {
        key: "offline-test-key",
        fetchImpl: async () => json(op),
      }),
    );
    await assert.rejects(
      downloadTrial(dir, {
        fetchImpl: async () => {
          throw Error("never download");
        },
      }),
    );
  });
test("missing100k is not substituted by500k", async (t) => {
  const op = simulatedOperation();
  delete op.response.assets.splats.spz_urls["100k"];
  const dir = await submitted(t);
  await assert.rejects(
    pollTrial(dir, {
      key: "offline-test-key",
      fetchImpl: async () => json(op),
    }),
  );
});
for (const [name, make] of [
  ["unsupportedSPZ", () => new Response(new Uint8Array(32))],
  [
    "corruptCRC",
    () => {
      const b = environmentSpz();
      b[b.length - 8] ^= 1;
      return new Response(b);
    },
  ],
  [
    "excess declared length",
    () =>
      new Response("x", {
        headers: { "content-length": String(64 * 1024 ** 2 + 1) },
      }),
  ],
  [
    "truncated stream",
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2]));
            c.error(Error("offline-test-key"));
          },
        }),
      ),
  ],
  [
    "redirected asset",
    () => {
      const r = new Response(environmentSpz());
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
  ],
])
  test(`${name} leaves no accepted download and never regenerates`, async (t) => {
    const dir = await completed(t);
    let calls = 0;
    await assert.rejects(
      downloadTrial(dir, {
        fetchImpl: async (url, init) => {
          calls++;
          assert.equal(init.method, "GET");
          return make();
        },
      }),
      (error) => !error.message.includes("offline-test-key"),
    );
    assert.equal(calls, 1);
    assert.equal((await readTrial(dir)).status, "download-rejected");
    await assert.rejects(readFile(join(dir, "request-record.json")));
    await assert.rejects(
      submitTrial(
        dir,
        approved(async () => {
          throw Error("never regenerate");
        }),
      ),
    );
  });
test("tampered verified cache cannot be reused", async (t) => {
  const dir = await completed(t);
  await downloadTrial(dir, {
    fetchImpl: async () => new Response(environmentSpz()),
  });
  await writeFile(join(dir, "environment-100k.spz"), environmentSpz(3, 3));
  await assert.rejects(
    downloadTrial(dir, {
      fetchImpl: async () => {
        throw Error("never silently replace");
      },
    }),
  );
});
test("persistent attempt marker exists before any network call and stale lock fails closed", async (t) => {
  const dir = await setup(t);
  await mkdir(join(dir, ".operation-lock"));
  await assert.rejects(
    submitTrial(
      dir,
      approved(async () => {
        throw Error("no request");
      }),
    ),
    /trial-locked/,
  );
  await rm(join(dir, ".operation-lock"), { recursive: true });
  await submitTrial(
    dir,
    approved(async () => {
      const marker = JSON.parse(
        await readFile(join(dir, "submission.json"), "utf8"),
      );
      assert.equal(marker.requestSha, REQUEST_SHA);
      assert.equal((await readTrial(dir)).status, "submission-unknown");
      return json({ operation_id: "op-1", done: false });
    }),
  );
});
test("cost overrun is recorded separately, never silently treated as within budget", async (t) => {
  const op = simulatedOperation();
  op.cost.total_credits = 1700;
  const dir = await completed(t, op);
  const state = await readTrial(dir);
  assert.equal(state.actualCredits, 1700);
  assert.equal(state.budgetExceeded, true);
  await assert.rejects(
    submitTrial(
      dir,
      approved(async () => {
        throw Error("no second POST");
      }),
    ),
  );
});
test("a wrong running recovery ID remains replaceable until World identity is verified", async (t) => {
  const dir = await setup(t);
  await assert.rejects(
    submitTrial(
      dir,
      approved(async () => {
        throw Error("disconnect");
      }),
    ),
  );
  await pollTrial(dir, {
    key: "offline-test-key",
    operationId: "wrong-op",
    requestSha: REQUEST_SHA,
    fetchImpl: async () => json({ operation_id: "wrong-op", done: false }),
  });
  assert.equal((await readTrial(dir)).operationId, null);
  assert.equal((await readTrial(dir)).candidateOperationId, "wrong-op");
  const methods = [];
  await pollTrial(dir, {
    key: "offline-test-key",
    operationId: "op-1",
    requestSha: REQUEST_SHA,
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      return json(simulatedOperation());
    },
  });
  assert.deepEqual(methods, ["GET"]);
  assert.equal((await readTrial(dir)).operationId, "op-1");
  assert.equal((await readTrial(dir)).candidateOperationId, null);
});
test("wrong completed recovery metadata does not bind ID or attribute its cost to this trial", async (t) => {
  const dir = await setup(t);
  await assert.rejects(
    submitTrial(
      dir,
      approved(async () => {
        throw Error("disconnect");
      }),
    ),
  );
  const wrong = simulatedOperation();
  wrong.operation_id = "wrong-op";
  wrong.response.model = "wrong-model";
  wrong.cost.total_credits = 9000;
  await assert.rejects(
    pollTrial(dir, {
      key: "offline-test-key",
      operationId: "wrong-op",
      requestSha: REQUEST_SHA,
      fetchImpl: async () => json(wrong),
    }),
  );
  const state = await readTrial(dir);
  assert.equal(state.operationId, null);
  assert.equal(state.actualCredits, null);
  assert.equal(state.candidateOperationId, "wrong-op");
  assert.equal(state.candidateCredits, 9000);
  await pollTrial(dir, {
    key: "offline-test-key",
    operationId: "op-1",
    requestSha: REQUEST_SHA,
    fetchImpl: async () => json(simulatedOperation()),
  });
  assert.equal((await readTrial(dir)).actualCredits, 1580);
});
for (const [label, mutate] of [
  [
    "model",
    (op) => {
      op.response.model = "marble-1.1-plus";
    },
  ],
  [
    "private permission",
    (op) => {
      op.response.permission.public = true;
    },
  ],
  [
    "public permission with missing model",
    (op) => {
      delete op.response.model;
      op.response.permission.public = true;
    },
  ],
  [
    "prompt",
    (op) => {
      op.response.world_prompt.text_prompt = "another task";
    },
  ],
])
  test(`conflicting ${label} in completion is not hidden by a matching World GET`, async (t) => {
    const dir = await submitted(t);
    const op = simulatedOperation();
    mutate(op);
    let calls = 0;
    await assert.rejects(
      pollTrial(dir, {
        key: "offline-test-key",
        fetchImpl: async () => json(++calls === 1 ? op : simulatedWorld()),
      }),
    );
    assert.equal(calls, 1);
    assert.equal((await readTrial(dir)).status, "completion-unverified");
    assert.equal((await readTrial(dir)).actualCredits, 1580);
  });
