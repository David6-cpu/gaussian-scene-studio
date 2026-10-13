import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../worldlabs-trial.mjs";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "wetland-cli-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("help is the default and has no disk or credential side effects", async (t) => {
  const dir = await setup(t);
  const env = new Proxy(
    {},
    {
      get() {
        throw Error("must not read credentials");
      },
    },
  );
  const result = await runCli([], { dir, env });
  assert.match(result, /prepare/);
  assert.match(result, /submit/);
  assert.deepEqual(await readdir(dir), []);
});
test("prepare and status remain offline and only report credential presence", async (t) => {
  const dir = await setup(t);
  const env = new Proxy(
    { WLT_API_KEY: "never-read-this-value" },
    {
      get() {
        throw Error("must not read credentials");
      },
    },
  );
  const prepared = JSON.parse(await runCli(["prepare"], { dir, env }));
  const status = JSON.parse(await runCli(["status"], { dir, env }));
  assert.equal(prepared.status, "prepared");
  assert.equal(status.status, "prepared");
  assert.equal(status.credentialPresent, true);
  assert.equal(status.attemptConsumed, false);
  assert.ok(!JSON.stringify(status).includes("never-read-this-value"));
});
for (const args of [
  ["submit"],
  ["download", "--approve-paid-once"],
  ["prepare", "--key", "secret"],
  ["reset"],
  ["poll", "--operation-id"],
  ["submit", "--confirm-request", "a", "--confirm-request", "b"],
])
  test(`invalid CLI invocation rejects before credentials: ${args[0]}`, async (t) => {
    const dir = await setup(t);
    const env = new Proxy(
      {},
      {
        get() {
          throw Error("credential-read-not-allowed");
        },
      },
    );
    await assert.rejects(
      runCli(args, { dir, env }),
      (e) =>
        !e.message.includes("credential-read-not-allowed") &&
        !e.message.includes("secret"),
    );
    assert.deepEqual(await readdir(dir), []);
  });
