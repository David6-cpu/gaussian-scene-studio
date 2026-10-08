// Isolated, offline renderer evidence. Playwright owns and closes its browser/server.
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const dir = resolve(
  `.local/riverbank-review-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(dir, { recursive: true });
const args = [
  "--no-install",
  "playwright",
  "test",
  "tests/e2e/riverbank-visual.spec.ts",
  "--project=functional",
  "--grep",
  "offline river visibility",
];
const child = spawn("npx", args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, REVIEW_VISUAL_DIR: dir },
});
let log = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    log += chunk;
    process.stdout.write(chunk);
  });
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
await writeFile(`${dir}/run.log`, log);
const cases = [];
for (const name of await readdir(dir))
  if (name.endsWith(".json"))
    cases.push(JSON.parse(await readFile(`${dir}/${name}`, "utf8")));
await writeFile(
  `${dir}/summary.json`,
  JSON.stringify(
    {
      engineering: code === 0 ? "visibility checks passed" : "failed",
      visual: "pending human inspection",
      realModel: "not tested; constructed HTTP responses",
      cases,
    },
    null,
    2,
  ),
);
console.log(`Evidence: ${dir}`);
process.exitCode = typeof code === "number" ? code : 1;
