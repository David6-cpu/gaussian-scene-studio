/** Offline T2 CLI: no conversion, network, key access, or existing source replacement. */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBoundedFile } from "../src/assets/catalog/local.ts";
import { GENERAL_LIMITS } from "../src/general-scene/core.ts";
import {
  parseAssetJson,
  prepareAssetPackage,
  verifyAssetManifest,
} from "../src/general-scene/asset-package.ts";
import { registerAsset } from "../src/general-scene/asset-library-server.ts";
import { sha256 } from "../src/io/hash.ts";
try {
  const [action, ...args] = process.argv.slice(2),
    options = new Map<string, string>();
  const allowed =
    action === "prepare"
      ? ["--input", "--manifest", "--license", "--out"]
      : action === "register"
        ? ["--package", "--review", "--root"]
        : [];
  if (!allowed.length)
    throw Error(
      "Use prepare --input DIR --manifest JSON --license TEXT --out ZIP or register --package ZIP --review JSON --root DIR",
    );
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || options.has(args[i]))
      throw Error("Unknown, missing or duplicate option");
    options.set(args[i], args[i + 1]);
  }
  const need = (key: string) => {
    const v = options.get(key);
    if (!v) throw Error(`Missing ${key}`);
    return v;
  };
  if (action === "prepare") {
    const m = await verifyAssetManifest(
        parseAssetJson(
          readBoundedFile(need("--manifest"), GENERAL_LIMITS.maxJsonBytes),
        ),
      ),
      root = resolve(need("--input")),
      members = new Map<string, Uint8Array>();
    for (const f of m.files)
      members.set(
        f.path,
        f.path === "license.txt"
          ? readBoundedFile(
              need("--license"),
              Math.min(f.bytes, GENERAL_LIMITS.maxJsonBytes),
            )
          : readBoundedFile(join(root, f.path), f.bytes, root),
      );
    const bytes = await prepareAssetPackage(m, members);
    writeFileSync(need("--out"), bytes, { flag: "wx" });
    console.log(
      JSON.stringify({
        output: need("--out"),
        bytes: bytes.length,
        sha256: await sha256(bytes),
        asset: { id: m.id, contentVersion: m.contentVersion },
        status: m.quality.status,
      }),
    );
  } else {
    const index = await registerAsset({
      root: need("--root"),
      packageBytes: readBoundedFile(
        need("--package"),
        GENERAL_LIMITS.maxCompressedPackageBytes,
      ),
      review: parseAssetJson(
        readBoundedFile(need("--review"), GENERAL_LIMITS.maxJsonBytes),
      ),
    });
    console.log(JSON.stringify({ index }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
