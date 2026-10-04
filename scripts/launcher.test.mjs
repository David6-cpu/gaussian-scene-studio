import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createServer as httpServer, request } from "node:http";

// An unsafe launcher would start despite these errors, or stop unrelated work.
const subject = await import("./launcher-core.mjs").catch(() => ({}));
test("launcher preflight and lifecycle exist before any model can start", () => {
  for (const name of [
    "verifyModel",
    "resourceProblem",
    "assertPortsFree",
    "claimSession",
    "requestStop",
    "releaseSession",
    "stopChild",
  ])
    assert.equal(typeof subject[name], "function", `${name} is missing`);
});
const implemented = typeof subject.verifyModel === "function";
async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wetland-launcher-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test(
  "missing, truncated and altered models fail without modifying the original",
  { skip: !implemented },
  async () => {
    await temporary(async (root) => {
      const bytes = Buffer.from("fixture model data");
      const config = {
        relativeFile: "weights/model.gguf",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      await assert.rejects(subject.verifyModel(root, config), /模型文件缺失/);
      await mkdir(join(root, "weights"));
      await writeFile(join(root, config.relativeFile), bytes.subarray(1));
      await assert.rejects(subject.verifyModel(root, config), /大小不符/);
      const altered = Buffer.from(bytes);
      altered[0] ^= 1;
      await writeFile(join(root, config.relativeFile), altered);
      await assert.rejects(subject.verifyModel(root, config), /SHA-256不符/);
      assert.deepEqual(
        await readFile(join(root, config.relativeFile)),
        altered,
      );
      await writeFile(join(root, config.relativeFile), bytes);
      assert.equal(
        (await subject.verifyModel(root, config)).sha256,
        config.sha256,
      );
    });
  },
);
test(
  "resource gate rejects unknown, pressured or insufficient estimates",
  { skip: !implemented },
  () => {
    assert.match(
      subject.resourceProblem({ pressure: 2, freeFileGiB: 9 }),
      /内存压力/,
    );
    assert.match(
      subject.resourceProblem({ pressure: 1, freeFileGiB: 3.7 }),
      /3.75/,
    );
    assert.match(
      subject.resourceProblem({ pressure: 1, freeFileGiB: NaN }),
      /读取/,
    );
    assert.equal(
      subject.resourceProblem({ pressure: 1, freeFileGiB: 4.5 }),
      null,
    );
  },
);
test(
  "a foreign listener survives port conflict and no-instance stop",
  { skip: !implemented },
  async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      await assert.rejects(
        subject.assertPortsFree([port]),
        new RegExp(`${port}.*占用`),
      );
      await temporary(async (dir) =>
        assert.equal(await subject.requestStop(dir), false),
      );
      assert.equal(server.listening, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
test(
  "duplicate launch preserves its owner and stop is an instance-specific file, not a PID signal",
  { skip: !implemented },
  async () => {
    await temporary(async (dir) => {
      const first = await subject.claimSession(dir);
      await assert.rejects(subject.claimSession(dir), /已在运行/);
      const saved = JSON.parse(
        await readFile(join(dir, "session.json"), "utf8"),
      );
      assert.equal(saved.id, first.id);
      assert.equal(await subject.requestStop(dir), true);
      assert.equal(
        await readFile(join(dir, `stop-${first.id}`), "utf8"),
        first.id,
      );
      await subject.releaseSession(dir, first);
      const second = await subject.claimSession(dir);
      assert.notEqual(second.id, first.id);
      await subject.releaseSession(dir, first); // stale owner cannot delete the new instance
      assert.equal(
        JSON.parse(await readFile(join(dir, "session.json"), "utf8")).id,
        second.id,
      );
      await subject.releaseSession(dir, second);
    });
  },
);
test(
  "normal child stop waits for exit and leaves a separate process alive",
  { skip: !implemented },
  async () => {
    const owned = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    try {
      const result = await subject.stopChild(owned);
      assert.equal(result.forced, false);
      assert.equal(owned.signalCode, "SIGTERM");
      assert.equal(other.exitCode, null);
      assert.equal(other.signalCode, null);
      process.kill(other.pid, 0);
    } finally {
      other.kill("SIGTERM");
    }
  },
);
test(
  "a stop caller in another locale recognizes the same live launcher",
  { skip: !implemented },
  async () => {
    await temporary(async (dir) => {
      const code = `import {claimSession, releaseSession} from ${JSON.stringify(new URL("./launcher-core.mjs", import.meta.url).href)};
      const dir=process.argv[1]; const owner=await claimSession(dir); process.send(owner);
      process.on('message',async()=>{await releaseSession(dir,owner);process.exit(0)});`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", code, dir],
        {
          env: { ...process.env, LC_ALL: "zh_CN.UTF-8" },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      try {
        await new Promise((resolve, reject) => {
          child.once("message", resolve);
          child.once("error", reject);
          child.once("exit", () => reject(Error("owner exited early")));
        });
        assert.equal(await subject.requestStop(dir), true);
      } finally {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.send("close");
        await exited;
      }
    });
  },
);
test("status and stop routes reject foreign origins and expose live launcher state", async () => {
  const api = await import("./launcher-status.mjs").catch(() => ({}));
  assert.equal(
    typeof api.statusMiddleware,
    "function",
    "statusMiddleware is missing",
  );
  let requested = false;
  const state = { phase: "checking", message: "正在校验", model: "3B" };
  const middleware = api.statusMiddleware(state, () => {
    requested = true;
  });
  const server = httpServer((req, res) =>
    middleware(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Node fetch rewrites Host; use the HTTP client to exercise explicit Host validation.
  const fetch = (url, options) =>
    new Promise((resolve, reject) => {
      const req = request(url, options, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: async () => JSON.parse(body),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  const headers = {
    host: "127.0.0.1:4173",
    origin: "http://127.0.0.1:4173",
    "content-type": "application/json",
  };
  try {
    assert.equal(
      (
        await fetch(base + "/_local/status.json", {
          headers: { host: "evil.invalid:4173" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/_local/status.json", { headers })).status,
      200,
    );
    assert.equal(
      (await (await fetch(base + "/_local/status.json", { headers })).json())
        .phase,
      "checking",
    );
    state.phase = "ready";
    assert.equal(
      (await (await fetch(base + "/_local/status.json", { headers })).json())
        .phase,
      "ready",
    );
    assert.equal(
      (
        await fetch(base + "/_local/stop", {
          method: "POST",
          headers: { ...headers, origin: "http://other.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(requested, false);
    assert.equal(
      (await fetch(base + "/_local/stop", { method: "GET", headers })).status,
      404,
    );
    assert.equal(
      (await fetch(base + "/_local/stop", { method: "POST", headers })).status,
      202,
    );
    assert.equal(requested, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
