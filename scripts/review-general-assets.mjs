#!/usr/bin/env node
// Local, read-only candidate inspection. This script never signs asset admission.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { loadLibrary } from "../src/general-scene/asset-library-server.ts";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--catalog")
  throw Error(
    "Usage: node scripts/review-general-assets.mjs --catalog <index.json>",
  );
const root = fileURLToPath(new URL("../", import.meta.url)),
  catalogPath = resolve(args[1]);
const library = await loadLibrary(catalogPath);
const catalog = {
  digest: library.digest,
  manifests: library.manifests,
  styles: library.styles,
};
const indexBytes = await readFile(catalogPath),
  index = JSON.parse(indexBytes.toString());
const sha = (b) => createHash("sha256").update(b).digest("hex");
const stamp = new Date().toISOString().replaceAll(":", "-");
const output = resolve(root, ".local/general-asset-reviews", stamp);
await mkdir(output, { recursive: true });
const files = [
  "src/general-scene/render/types.ts",
  "src/general-scene/render/source-bank.ts",
  "src/general-scene/render/view.ts",
  "src/general-scene/asset-review.ts",
  "tests/general-harness.html",
  "tests/general-harness.ts",
  "tests/e2e/general-assets.spec.ts",
  "scripts/review-general-assets.mjs",
  "vite.config.ts",
];
const version = {
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
};
const report = {
  format: "general-scene-preview-evidence",
  version: 1,
  createdAt: new Date().toISOString(),
  sourceVersion: version,
  catalogPath,
  catalogSha256: sha(indexBytes),
  catalogDigest: catalog.digest,
  evidenceKind: "candidate-inspection",
  humanReview: null,
  admission:
    "unchanged; only a human can accept an exact immutable asset and validated scope",
  assets: [],
  errors: [],
};
// Isolated Vite entry has no planner/model/service plugin or ordinary UI.
let server, browser;
try {
  server = await createServer({
    configFile: false,
    root,
    server: { host: "127.0.0.1", port: 0, strictPort: true },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer.address(),
    origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const m of catalog.manifests) {
    if (m.kind !== "object") throw Error(`Object candidate expected: ${m.id}`);
    const entry = index.entries.find(
      (e) =>
        e.review.asset.id === m.id &&
        e.review.asset.contentVersion === m.contentVersion,
    );
    const item = {
      ref: { id: m.id, contentVersion: m.contentVersion },
      category: m.category,
      origin: m.origin,
      package: entry?.package,
      packageSha256: entry?.packageSha256,
      files: m.files,
      manifest: m,
      status: m.quality.status,
      operations: m.quality.operations,
      conclusion: "candidate — pending human visual/contact/LOD review",
      defects: [...m.quality.limitations],
      captures: [],
    };
    report.assets.push(item);
    for (const dpr of [1, 2]) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: dpr,
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          await route.abort("blockedbyclient");
          return;
        }
        if (url.pathname !== "/__general-review/member") {
          await route.continue();
          return;
        }
        try {
          const bytes = await library.resolveMember(
            {
              id: url.searchParams.get("id"),
              contentVersion: url.searchParams.get("version"),
            },
            url.searchParams.get("name"),
            new AbortController().signal,
          );
          await route.fulfill({
            status: 200,
            contentType: "application/octet-stream",
            body: Buffer.from(bytes),
          });
        } catch (e) {
          await route.fulfill({ status: 400, body: String(e) });
        }
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      try {
        await page.goto(origin + "/tests/general-harness.html");
        await page.waitForFunction(
          () => window.general?.ready,
          {},
          { timeout: 15000 },
        );
        for (const lod of ["full", ...(m.gaussian.coarse ? ["coarse"] : [])]) {
          const summary = await page.evaluate(
            ({ catalog, id, lod }) => window.general.inspect(catalog, id, lod),
            { catalog, id: m.id, lod },
          );
          for (const proposed of summary.views) {
            await page.evaluate(
              (camera) => window.general.camera(camera),
              proposed.camera,
            );
            const filename = `${m.id}-${lod}-dpr${dpr}-${proposed.name}.png`,
              png = await page.locator("#general").screenshot({
                style: "label, #debug { visibility: hidden !important; }",
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
            if (!visiblePixels) throw Error(`No visible pixels: ${filename}`);
            item.captures.push({
              png: filename,
              pngSha256: sha(png),
              lod,
              view: proposed.name,
              camera: proposed.camera,
              proposedDistance: proposed.distance,
              distanceBasis: proposed.basis,
              transform: summary.instance,
              source: summary.source,
              stats: summary.stats,
              environment: await page.evaluate(() =>
                window.general.diagnostics(),
              ),
              visiblePixels,
              visualDecision:
                "unreviewed; visible pixels are an engineering observation",
            });
          }
          await page.evaluate(
            (camera) => window.general.camera(camera, true),
            summary.views[0].camera,
          );
          const filename = `${m.id}-${lod}-dpr${dpr}-debug.png`;
          await page.screenshot({ path: resolve(output, filename) });
          item.captures.push({
            png: filename,
            lod,
            dpr,
            view: "front-debug",
            camera: summary.views[0].camera,
            debug:
              "orange numerical 3-sigma bounds; green roots / magenta edges; unverified contact",
          });
        }
        await page.evaluate(() => window.general.release());
        if (pageErrors.length) throw Error(pageErrors.join("\n"));
      } finally {
        await context.close();
      }
    }
  }
} catch (e) {
  report.errors.push(String(e));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
}
await writeFile(
  resolve(output, "evidence.json"),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
const rows = report.assets
  .map(
    (a) =>
      `| ${a.ref.id} | ${a.ref.contentVersion} | ${a.captures.length} | ${a.status}; pending human review |`,
  )
  .join("\n");
await writeFile(
  resolve(output, "review.md"),
  `# General Gaussian candidate inspection\n\nEngineering capture only. Asset metadata, operations and admission remain unchanged. No automatic pass or human signature.\n\nCatalog SHA-256: ${report.catalogSha256}\n\nSource HEAD: ${version.head}; exact file hashes and dirty status in evidence.json.\n\n| Asset | Immutable version | PNG count | Decision |\n| --- | --- | --- | --- |\n${rows}\n\nFull/coarse × DPR1/2 × front/back/top/low/proposed minimum distance, plus switchable debug overlay. Proposed cameras are not validated viewing scopes. Existing numerical/contact limitations are retained per asset in evidence.json. Human reviewers must record actual defects and bind any acceptance to final frozen metadata and file hashes.\n\nErrors: ${JSON.stringify(report.errors)}\n`,
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      output: relative(root, output),
      assets: report.assets.length,
      pngs: report.assets.reduce((n, a) => n + a.captures.length, 0),
      errors: report.errors,
    },
    null,
    2,
  ),
);
