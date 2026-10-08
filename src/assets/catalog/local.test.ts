import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { preparedFixture } from "../../../tests/support/prepared-fixture";
const fault = vi.hoisted(() => ({ failLink: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {...actual, linkSync: (...args: Parameters<typeof actual.linkSync>) => {
    if (fault.failLink) throw Error("injected disk publish failure");
    return actual.linkSync(...args);
  }};
});
const dirs: string[] = [];
afterEach(() => {
  fault.failLink = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temporary() {
  mkdirSync(".local", { recursive: true });
  const d = mkdtempSync(join(process.cwd(), ".local/catalog-test-"));
  dirs.push(d);
  return d;
}
const reviewFor = (contentVersion: string) => ({
  contentVersion,
  licenseChecked: true,
  decision: "trial" as const,
  limitations: ["Test"],
  recordReference: "docs/validation/riverside-integration.md",
});
test("register is exclusive, load is frozen, changed disk content is rejected", async () => {
  const { registerPreparedGround, loadLocalCatalog } = await import("./local");
  const { zip, asset } = await preparedFixture(),
    root = join(temporary(), "library"),
    args = {
      root,
      packageBytes: zip,
      review: reviewFor(asset.definition.metadata.contentVersion),
      candidateScope: "combined" as const,
    };
  const index = await registerPreparedGround(args),
    saved = readFileSync(index),
    loaded = await loadLocalCatalog(index);
  expect(loaded.context.prepared?.metadata.id).toBe("test-prepared-ground");
  await expect(registerPreparedGround(args)).rejects.toThrow();
  expect(readFileSync(index)).toEqual(saved);
  const m = JSON.parse(saved.toString()),
    assetPath = join(root, m.entries[0].package);
  const corrupt = zip.slice();
  corrupt[100] ^= 1;
  writeFileSync(assetPath, corrupt);
  await expect(loadLocalCatalog(index)).rejects.toThrow();
  expect(loaded.packageBytes).toEqual(zip);
  expect((await loadLocalCatalog()).context.prepared).toBe(null);
});
test("unreviewed registration leaves no directory and path escapes never load", async () => {
  const { registerPreparedGround, loadLocalCatalog } = await import("./local");
  const { zip, asset } = await preparedFixture(),
    parent = temporary(),
    root = join(parent, "library"),
    review = reviewFor(asset.definition.metadata.contentVersion);
  await expect(
    registerPreparedGround({
      root,
      packageBytes: zip,
      review: { ...review, decision: "pending" },
      candidateScope: "combined",
    }),
  ).rejects.toThrow();
  expect(readdirSync(parent)).toEqual([]);
  const index = await registerPreparedGround({
      root,
      packageBytes: zip,
      review,
      candidateScope: "combined",
    }),
    original = JSON.parse(readFileSync(index, "utf8"));
  for (const name of [
    "../outside.zip",
    "/tmp/outside.zip",
    "https://example.invalid/a.zip",
  ]) {
    const m = structuredClone(original);
    m.entries[0].package = name;
    writeFileSync(index, JSON.stringify(m));
    await expect(loadLocalCatalog(index)).rejects.toThrow();
  }
  writeFileSync(index, JSON.stringify(original));
  const source = join(root, original.entries[0].package);
  rmSync(source);
  writeFileSync(join(parent, "outside.zip"), zip);
  symlinkSync(join(parent, "outside.zip"), source);
  await expect(loadLocalCatalog(index)).rejects.toThrow();
});
test("real CLI refuses a second output without changing the first", async () => {
  const { input, asset } = await preparedFixture(),
    dir = temporary();
  writeFileSync(join(dir, "source.ply"), input.ply);
  writeFileSync(join(dir, "native.json"), JSON.stringify(input.native));
  for (const [name, b] of input.files) writeFileSync(join(dir, name), b);
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(input.metadata));
  writeFileSync(join(dir, "height.json"), JSON.stringify(input.heightProxy));
  writeFileSync(join(dir, "license.txt"), input.licenseText);
  const args = [
    "scripts/prepare-ground.ts",
    "prepare",
    "--ply",
    join(dir, "source.ply"),
    "--native",
    join(dir, "native.json"),
    "--metadata",
    join(dir, "metadata.json"),
    "--height-proxy",
    join(dir, "height.json"),
    "--license",
    join(dir, "license.txt"),
    "--purpose",
    "workflow-test",
    "--out",
    join(dir, "new.zip"),
  ];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(first.stderr).toBe("");
  expect(first.status).toBe(0);
  const before = readFileSync(join(dir, "new.zip"));
  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(second.status).not.toBe(0);
  expect(readFileSync(join(dir, "new.zip"))).toEqual(before);
  const review = join(dir, "review.json");
  writeFileSync(
    review,
    JSON.stringify(reviewFor(asset.definition.metadata.contentVersion)),
  );
  const registered = spawnSync(
    process.execPath,
    [
      "scripts/prepare-ground.ts",
      "register",
      "--package",
      join(dir, "new.zip"),
      "--review",
      review,
      "--root",
      join(dir, "registered"),
    ],
    { encoding: "utf8" },
  );
  expect(registered.status, registered.stderr).toBe(0);
});

test("mid-write publication failure removes only owned output and preserves input", async () => {
  const {registerPreparedGround}=await import("./local");
  const {zip,asset}=await preparedFixture(),parent=temporary(),input=join(parent,"input.zip");
  writeFileSync(input,zip);fault.failLink=true;
  await expect(registerPreparedGround({root:join(parent,"new-library"),packageBytes:zip,review:reviewFor(asset.definition.metadata.contentVersion),candidateScope:"combined"})).rejects.toThrow("injected");
  expect(readdirSync(parent)).toEqual(["input.zip"]);expect(readFileSync(input)).toEqual(Buffer.from(zip));
});
