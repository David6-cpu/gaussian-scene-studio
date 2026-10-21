#!/usr/bin/env node
// Local engineering media only: this tool never signs style/material admission.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--cases" || args[2] !== "--dpr")
  throw Error(
    "Usage: node scripts/review-general-surfaces.mjs --cases flat,slope,river --dpr 1,2",
  );
const cases = args[1].split(","),
  dprs = args[3].split(",").map(Number);
if (
  !cases.length ||
  new Set(cases).size !== cases.length ||
  cases.some((c) => !["flat", "slope", "river"].includes(c)) ||
  !dprs.length ||
  new Set(dprs).size !== dprs.length ||
  dprs.some((d) => ![1, 2].includes(d))
)
  throw Error("Unsupported case/DPR");
const sha = (b) => createHash("sha256").update(b).digest("hex"),
  stamp = new Date().toISOString().replaceAll(":", "-"),
  output = resolve(root, ".local/general-surface-reviews", stamp);
await mkdir(output, { recursive: true });
const files = [
  "src/general-scene/surface.ts",
  "src/general-scene/surface.test.ts",
  "src/general-scene/terrain.ts",
  "src/general-scene/water.ts",
  "src/general-scene/water-profile.ts",
  "src/general-scene/contracts.ts",
  "src/general-scene/asset-manifest.ts",
  "src/general-scene/asset-library.ts",
  "src/general-scene/render/types.ts",
  "src/general-scene/render/source-bank.ts",
  "src/general-scene/render/view.ts",
  "src/gaussian/spark-budget.ts",
  "src/assets/river-props.ts",
  "src/general-scene/test-fixtures.ts",
  "tests/general-harness.ts",
  "tests/general-harness.html",
  "tests/e2e/general-surfaces.spec.ts",
  "scripts/review-general-surfaces.mjs",
  "tests/fixtures/general-scene-properties.json",
  "tests/fixtures/general-scene-requests.json",
  "package.json",
  "node_modules/@sparkjsdev/spark/dist/spark.module.js",
];
const report = {
  format: "general-surface-inspection",
  version: 1,
  createdAt: new Date().toISOString(),
  command: process.argv.join(" "),
  sourceVersion: {
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    status: execFileSync("git", ["status", "--short"], {
      cwd: root,
      encoding: "utf8",
    }),
    files: Object.fromEntries(
      await Promise.all(
        files.map(async (f) => [f, sha(await readFile(resolve(root, f)))]),
      ),
    ),
  },
  evidenceKind: "constructed-surface-and-candidate-object-inspection",
  humanReview: null,
  visualDecision:
    "pending independent observations and human review; never automatic pass",
  cases: [],
  errors: [],
};
const persist = () =>
  writeFile(
    resolve(output, "evidence.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
// Read actual video presentation timestamps without installing a decoder. This is
// duration/encoded-frame evidence, not a visual quality score or claimed frame rate.
function webmTiming(bytes) {
  let scale = 1000000;
  const times = [];
  const vint = (at, id = false) => {
    const b = bytes[at];
    if (!b) throw Error("Invalid EBML vint");
    let mask = 128,
      length = 1;
    while (!(b & mask)) {
      mask >>= 1;
      length++;
      if (length > 8) throw Error("EBML vint too long");
    }
    let value = id ? b : b & (mask - 1),
      unknown = !id && value === mask - 1;
    for (let i = 1; i < length; i++) {
      const next = bytes[at + i];
      if (next === undefined) throw Error("Truncated EBML");
      value = value * 256 + next;
      unknown = unknown && next === 255;
    }
    return { length, value, unknown };
  };
  const uint = (a, b) => {
    let n = 0;
    for (let i = a; i < b; i++) n = n * 256 + bytes[i];
    return n;
  };
  const walk = (start, end, cluster = 0) => {
    for (let at = start; at < end;) {
      const id = vint(at, true);
      at += id.length;
      const size = vint(at);
      at += size.length;
      const next = size.unknown ? end : at + size.value;
      if (next > end || next <= at) throw Error("Invalid EBML element");
      if (id.value === 0x2ad7b1) scale = uint(at, next);
      else if (id.value === 0xe7) cluster = uint(at, next);
      else if (id.value === 0xa3 || id.value === 0xa1) {
        const track = vint(at),
          offset = at + track.length;
        if (offset + 3 > next) throw Error("Truncated block");
        times.push(cluster + bytes.readInt16BE(offset));
      } else if ([0x18538067, 0x1549a966, 0x1f43b675, 0xa0].includes(id.value))
        walk(at, next, cluster);
      at = next;
    }
  };
  walk(0, bytes.length);
  if (times.length < 2) throw Error("No video frame timestamps");
  const first = Math.min(...times),
    last = Math.max(...times);
  return {
    encodedFrames: times.length,
    firstTimestampMs: (first * scale) / 1e6,
    lastTimestampMs: (last * scale) / 1e6,
    presentationSpanMs: ((last - first) * scale) / 1e6,
    timecodeScaleNs: scale,
  };
}
await persist();
let server, browser;
try {
  server = await createServer({
    configFile: false,
    root,
    server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  report.browserVersion = browser.version();
  for (const name of cases)
    for (const dpr of dprs) {
      const item = {
        name,
        dpr,
        captures: [],
        errors: [],
        defects: [],
        humanReview: null,
        visualDecision: "unreviewed",
      };
      report.cases.push(item);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: dpr,
        acceptDownloads: true,
      });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.origin === origin
          ? route.continue()
          : route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => item.errors.push(String(e)));
      page.setDefaultTimeout(20000);
      let orbitDeadline;
      try {
        await page.goto(origin + "/tests/general-harness.html");
        await page.waitForFunction(() => window.general?.ready);
        item.summary = await page.evaluate(
          (name) => window.general.surfaceCase(name),
          name,
        );
        item.environment = await page.evaluate(() =>
          window.general.diagnostics(),
        );
        if (item.summary.drawnNodes !== item.summary.stats.instanceCount)
          throw Error("Actual draw does not contain the installed nodes");
        for (const proposed of item.summary.views) {
          await page.evaluate(
            (camera) => window.general.camera(camera),
            proposed.camera,
          );
          const filename = `${name}-dpr${dpr}-${proposed.name}.png`,
            png = await page.locator("#general").screenshot({
              style: "label,#debug{visibility:hidden!important}",
            });
          await writeFile(resolve(output, filename), png, { flag: "wx" });
          const decoded = PNG.sync.read(png);
          let visiblePixels = 0;
          for (let i = 0; i < decoded.data.length; i += 4)
            if (
              Math.max(
                decoded.data[i],
                decoded.data[i + 1],
                decoded.data[i + 2],
              ) > 40
            )
              visiblePixels++;
          if (!visiblePixels)
            throw Error(`No visible Gaussian pixels: ${filename}`);
          item.captures.push({
            file: filename,
            sha256: sha(png),
            view: proposed.name,
            camera: proposed.camera,
            visiblePixels,
            displayError: await page.evaluate(
              (camera) =>
                window.general.surfaceDisplayError(
                  camera.position.map(Math.abs),
                ),
              proposed.camera,
            ),
            kind: "normal",
            visualDecision: "unreviewed; visible pixels only confirm rendering",
          });
          await page.evaluate(
            (camera) => window.general.camera(camera, true),
            proposed.camera,
          );
          const overlayFilename = `${name}-dpr${dpr}-${proposed.name}-mask.png`,
            overlay = await page.screenshot({
              style: "label{visibility:hidden!important}",
            });
          await writeFile(resolve(output, overlayFilename), overlay, {
            flag: "wx",
          });
          item.captures.push({
            file: overlayFilename,
            sha256: sha(overlay),
            kind: "analytic-mask-overlay",
            view: proposed.name,
            camera: proposed.camera,
            overlayDigest: item.summary.bindings.overlayDigest,
          });
        }
        console.log(
          JSON.stringify({
            case: name,
            dpr,
            stage: "six-views",
            pointCount: item.summary.pointCount,
          }),
        );
        // Attach rejection handlers immediately: navigation or capture failures
        // must reach the case catch/finally, even while screenshots are awaited.
        const settle = (promise) =>
          promise.then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          );
        const deadline = new Promise((_, reject) => {
          orbitDeadline = setTimeout(() => {
            const error = Error(
              "Surface orbit exceeded 45-second wall-clock deadline",
            );
            item.errors.push(String(error));
            reject(error);
            // Interrupt screenshot/download waits too, not only the evaluate.
            // This is this case's owned context; the outer finally is idempotent.
            void context.close().catch((e) => item.errors.push(String(e)));
          }, 45000);
        });
        const downloadPromise = settle(
            page.waitForEvent("download", {
              timeout: 45000,
            }),
          ),
          orbitPromise = settle(
            Promise.race([
              page.evaluate(() => window.general.surfaceOrbit()),
              deadline,
            ]),
          );
        // Four actual normal frames sampled from the same visible continuous orbit.
        for (let i = 0; i < 4; i++) {
          await page.waitForTimeout(7600);
          const filename = `${name}-dpr${dpr}-orbit-${i}.png`,
            png = await page.locator("#general").screenshot({
              style: "label,#debug{visibility:hidden!important}",
            });
          await writeFile(resolve(output, filename), png, { flag: "wx" });
          item.captures.push({
            file: filename,
            sha256: sha(png),
            kind: "orbit-frame",
            observed: await page.evaluate(() => ({
              camera: window.general.view.getCamera(),
              now: performance.now(),
            })),
          });
        }
        const orbitResult = await orbitPromise;
        if (!orbitResult.ok) throw orbitResult.error;
        item.orbit = orbitResult.value;
        const downloadResult = await downloadPromise;
        if (!downloadResult.ok) throw downloadResult.error;
        const download = downloadResult.value,
          videoName = `${name}-dpr${dpr}-orbit.webm`;
        await download.saveAs(resolve(output, videoName));
        const bytes = await readFile(resolve(output, videoName));
        item.orbit.media = {
          file: videoName,
          sha256: sha(bytes),
          bytes: bytes.length,
          ...webmTiming(bytes),
        };
        if (item.orbit.media.presentationSpanMs < 30000)
          throw Error("Encoded visible orbit spans less than 30 seconds");
        item.after = await page.evaluate(() => window.general.surfaceState());
        if (item.summary.sourceDigest !== item.after.sourceDigest)
          throw Error("Camera movement changed source bytes");
        await page.evaluate(() => window.general.release());
        if (item.errors.length) throw Error(item.errors.join("\n"));
        console.log(
          JSON.stringify({
            case: name,
            dpr,
            stage: "orbit-complete",
            duration: item.orbit.media.presentationSpanMs,
            frames: item.orbit.media.encodedFrames,
          }),
        );
      } catch (e) {
        item.errors.push(String(e));
        report.errors.push(`${name}/DPR${dpr}: ${e}`);
        process.exitCode = 1;
        console.error(String(e));
      } finally {
        clearTimeout(orbitDeadline);
        await context.close();
        await persist();
      }
    }
} catch (e) {
  report.errors.push(String(e));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await persist();
}
const rows = report.cases
  .map(
    (c) =>
      `| ${c.name} | ${c.dpr} | ${c.summary?.pointCount ?? "failed"} | ${c.orbit?.media?.presentationSpanMs ?? "missing"} | ${c.captures.length} | ${c.errors.length ? "engineering capture failed" : "captured; visual pending"} |`,
  )
  .join("\n");
await writeFile(
  resolve(output, "review.md"),
  `# Gaussian surface inspection\n\nEngineering media only. Style and object remain candidates; humanReview=null. No automatic visual acceptance. Additional constructed inputs do not replace rejected frozen cases.\n\n| Case | DPR | Surface points | Encoded orbit span (ms) | PNGs | Status |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\n## Defect observations\n\nPending independent visual inspection. Record reviewer, case/DPR/view, location, defect, severity/scope and media. Normal views exclude the separate mask overlay. Inspect seams, holes, shore halos/sheet edges, grounding, back faces and view-dependent movement.\n\nExact input/solution/style/source/file identities, real renderer configuration, GPU/browser data, bound camera route and second-pack positional error are in evidence.json. No full-scene performance/admission claim.\n\nErrors: ${JSON.stringify(report.errors)}\n`,
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      output: relative(root, output),
      cases: report.cases.length,
      errors: report.errors,
    },
    null,
    2,
  ),
);
