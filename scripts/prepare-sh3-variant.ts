/** Offline only. A new variant ZIP never changes catalog assets or scene history. */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  prepareSh3Variant,
  readSh3Variant,
  type ShImportMode,
} from "../src/io/sh3-variant.ts";
import { packBundle } from "../src/io/archive.ts";

const usage =
  "node scripts/prepare-sh3-variant.ts --ply crop.ply --native native.json --out new-variant.zip --credit 'Author / license URL / source / crop changes' [--mode native|range-safe]";
try {
  const args = process.argv.slice(2),
    options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--ply", "--native", "--out", "--credit", "--mode"].includes(args[i]) ||
      !args[i + 1] ||
      options.has(args[i])
    )
      throw new Error(usage);
    options.set(args[i], args[i + 1]);
  }
  for (const key of ["--ply", "--native", "--out", "--credit"])
    if (!options.has(key)) throw new Error(usage);
  const mode = options.get("--mode") ?? "native";
  if (mode !== "native" && mode !== "range-safe") throw new Error(usage);
  const boundedRead = (path: string, limit: number) => {
    if (statSync(path).size > limit)
      throw new Error(`Input exceeds byte budget: ${path}`);
    const bytes = readFileSync(path);
    if (bytes.length > limit) throw new Error("Input grew past byte budget");
    return new Uint8Array(bytes);
  };
  const nativePath = options.get("--native")!;
  const native = JSON.parse(
    new TextDecoder().decode(boundedRead(nativePath, 1024 * 1024)),
  );
  if (!Array.isArray(native.outputs) || native.outputs.length !== 6)
    throw new Error("Expected six native arrays");
  const files = new Map<string, Uint8Array>();
  for (const o of native.outputs) {
    if (
      typeof o.filename !== "string" ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.u32$/.test(o.filename) ||
      files.has(o.filename)
    )
      throw new Error("Invalid native array filename");
    files.set(
      o.filename,
      boundedRead(join(dirname(nativePath), o.filename), 251904 * 16),
    );
  }
  const started = performance.now();
  const bundle = await prepareSh3Variant(
    boundedRead(options.get("--ply")!, 64 * 1024 * 1024),
    native,
    files,
    options.get("--credit")!,
    mode as ShImportMode,
  );
  const zip = packBundle(bundle);
  const restored = await readSh3Variant(zip);
  // Exclusive creation: preserve every existing source, archive and candidate.
  writeFileSync(options.get("--out")!, zip, { flag: "wx" });
  console.log(
    JSON.stringify({
      output: options.get("--out"),
      mode: restored.manifest.mode,
      count: restored.manifest.count,
      shBands: 3,
      bytes: zip.byteLength,
      milliseconds: performance.now() - started,
      reopened: true,
      note: "Offline SH3 variant package; not a main-scene ZIP or catalog admission.",
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
