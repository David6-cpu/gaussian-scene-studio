/** Developer-only preparation/registration. No network, installs, or source replacement. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareGroundPackage } from "../src/io/prepared-ground.ts";
import {
  readBoundedFile,
  registerPreparedGround,
} from "../src/assets/catalog/local.ts";
const decode = (path: string) =>
  JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      readBoundedFile(path, 1048576),
    ),
  );
try {
  const [action, ...args] = process.argv.slice(2),
    options = new Map<string, string>();
  const allowed =
    action === "prepare"
      ? [
          "--ply",
          "--native",
          "--metadata",
          "--height-proxy",
          "--license",
          "--purpose",
          "--out",
          "--mode",
        ]
      : action === "register"
        ? ["--package", "--review", "--root", "--candidate-scope"]
        : [];
  if (!allowed.length) throw Error("Use prepare or register");
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || options.has(args[i]))
      throw Error("Unknown, missing or duplicate option");
    options.set(args[i], args[i + 1]);
  }
  const need = (key: string) => {
    const value = options.get(key);
    if (!value) throw Error(`Missing ${key}`);
    return value;
  };
  if (action === "prepare") {
    const path = need("--native"),
      native = decode(path),
      files = new Map<string, Uint8Array>();
    if (!Array.isArray(native.outputs) || native.outputs.length !== 6)
      throw Error("Expected six native outputs");
    for (const f of native.outputs) {
      if (
        typeof f.filename !== "string" ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.u32$/.test(f.filename) ||
        files.has(f.filename)
      )
        throw Error("Invalid array filename");
      files.set(
        f.filename,
        readBoundedFile(
          join(dirname(path), f.filename),
          251904 * 16,
          dirname(path),
        ),
      );
    }
    const purpose = need("--purpose"),
      mode = options.get("--mode") ?? "native";
    if (
      !["workflow-test", "candidate"].includes(purpose) ||
      !["native", "range-safe"].includes(mode)
    )
      throw Error("Invalid purpose or SH mode");
    const bytes = await prepareGroundPackage({
      ply: readBoundedFile(need("--ply"), 64 * 1024 ** 2),
      native,
      files,
      metadata: decode(need("--metadata")),
      heightProxy: decode(need("--height-proxy")),
      licenseText: new TextDecoder("utf-8", { fatal: true }).decode(
        readBoundedFile(need("--license"), 65536),
      ),
      purpose: purpose as "workflow-test" | "candidate",
      mode: mode as "native" | "range-safe",
    });
    writeFileSync(need("--out"), bytes, { flag: "wx" });
    console.log(
      JSON.stringify({
        output: need("--out"),
        bytes: bytes.length,
        registered: false,
      }),
    );
  } else {
    const scope = options.get("--candidate-scope") ?? "combined";
    if (!["combined", "prepared-ground-only"].includes(scope))
      throw Error("Invalid scope");
    const index = await registerPreparedGround({
      root: need("--root"),
      packageBytes: readBoundedFile(need("--package"), 64 * 1024 ** 2),
      review: decode(need("--review")),
      candidateScope: scope as "combined" | "prepared-ground-only",
    });
    console.log(index);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
