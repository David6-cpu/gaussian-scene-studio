import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
  statSync,
  mkdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { record, oneOf } from "../../data-validation.ts";
import { readPreparedGround } from "../../io/prepared-ground.ts";
import { sha256 } from "../../io/hash.ts";
import {
  makeCatalogContext,
  parseGroundReview,
  BUILTIN_CONTEXT,
  type CatalogContext,
  type LocalCatalogIndex,
  type GroundReview,
} from "./context.ts";

const LIMIT = 64 * 1024 ** 2;
function contained(root: string, path: string): boolean {
  const r = relative(root, path);
  return r !== ".." && !r.startsWith("../") && !isAbsolute(r);
}
export function readBoundedFile(
  path: string,
  limit: number,
  root?: string,
): Uint8Array {
  const real = realpathSync(path);
  if (root && !contained(realpathSync(root), real))
    throw Error("File escapes configured directory");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd),
      named = statSync(real);
    if (
      !before.isFile() ||
      before.size > limit ||
      before.ino !== named.ino ||
      before.dev !== named.dev
    )
      throw Error("Input size or identity invalid");
    const b = Buffer.alloc(before.size + 1);
    let n = 0,
      got = 0;
    do {
      got = readSync(fd, b, n, b.length - n, n);
      n += got;
    } while (got && n < b.length);
    const after = fstatSync(fd),
      current = statSync(realpathSync(path));
    if (
      n !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== current.ino ||
      after.dev !== current.dev ||
      realpathSync(path) !== real
    )
      throw Error("Input changed while reading");
    return new Uint8Array(b.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}
const parseJson = (b: Uint8Array) =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
export interface LoadedCatalog {
  context: CatalogContext;
  packageBytes: Uint8Array | null;
}
export async function loadLocalCatalog(
  indexPath?: string,
): Promise<LoadedCatalog> {
  if (!indexPath) return { context: BUILTIN_CONTEXT, packageBytes: null };
  const index = resolve(indexPath),
    base = resolve(process.cwd(), ".local");
  if (
    !contained(base, index) ||
    !contained(realpathSync(base), realpathSync(index))
  )
    throw Error("Catalog must be under project .local");
  const root = dirname(index),
    m = record(parseJson(readBoundedFile(index, 1048576, root)), [
      "format",
      "version",
      "entries",
      "candidateScope",
    ]);
  oneOf(m.format, ["wetland-local-catalog"]);
  oneOf(m.version, [1]);
  const scope = oneOf(m.candidateScope, [
    "combined",
    "prepared-ground-only",
  ] as const);
  if (!Array.isArray(m.entries) || m.entries.length > 1)
    throw Error("Only one prepared ground is allowed");
  if (!m.entries.length) {
    if (scope !== "combined") throw Error("Missing prepared ground");
    return { context: BUILTIN_CONTEXT, packageBytes: null };
  }
  const e = record(m.entries[0], ["package", "packageSha256", "review"]);
  if (
    typeof e.package !== "string" ||
    !/^[a-z][a-z0-9-]*\.zip$/.test(e.package)
  )
    throw Error("Invalid local package path");
  const bytes = readBoundedFile(join(root, e.package), LIMIT, root);
  if ((await sha256(bytes)) !== e.packageSha256)
    throw Error("Registered package changed");
  const asset = await readPreparedGround(bytes),
    review = parseGroundReview(
      e.review,
      asset.definition.metadata.contentVersion,
    );
  return {
    context: await makeCatalogContext(asset, review, scope),
    packageBytes: bytes,
  };
}
export async function registerPreparedGround(input: {
  root: string;
  packageBytes: Uint8Array;
  review: GroundReview;
  candidateScope: LocalCatalogIndex["candidateScope"];
}): Promise<string> {
  // Validate a private copy before any output exists; no unreviewed pending directory is published.
  const bytes = new Uint8Array(input.packageBytes),
    asset = await readPreparedGround(bytes);
  const review = parseGroundReview(
    input.review,
    asset.definition.metadata.contentVersion,
  );
  await makeCatalogContext(asset, review, input.candidateScope);
  const index: LocalCatalogIndex = {
    format: "wetland-local-catalog",
    version: 1,
    candidateScope: input.candidateScope,
    entries: [
      { package: "ground.zip", packageSha256: await sha256(bytes), review },
    ],
  };
  const root = resolve(input.root);
  mkdirSync(root);
  const owned: string[] = [];
  const write = (name: string, data: string | Uint8Array) => {
    const path = join(root, name);
    const fd = openSync(path, "wx");
    owned.push(path);
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
  };
  try {
    write("ground.zip", bytes);
    write("index-pending.json", JSON.stringify(index, null, 2) + "\n");
    linkSync(join(root, "index-pending.json"), join(root, "index.json"));
    owned.push(join(root, "index.json"));
    unlinkSync(join(root, "index-pending.json"));
    return join(root, "index.json");
  } catch (error) {
    for (const p of owned.reverse()) {
      try {
        unlinkSync(p);
      } catch {}
    }
    try {
      rmdirSync(root);
    } catch {}
    throw error;
  }
}
