import { test, expect } from "vitest";
import {
  preparedInput,
  preparedFixture,
} from "../../tests/support/prepared-fixture";
import { packBundle, unpackBundle } from "./archive";

test("native roundtrip binds identity and license", async () => {
  const { input, asset } = await preparedFixture();
  expect(asset.definition.metadata.contentVersion).toMatch(
    /^sha256-[a-f0-9]{64}$/,
  );
  expect(asset.definition.count).toBe(2);
  expect(asset.definition.heightProxy.heights).toHaveLength(1681);
  expect(asset.definition.licenseText).toBe(input.licenseText);
  for (const [name, bytes] of input.files)
    expect(
      new Uint8Array(
        asset.arrays[name.slice(0, -4) as keyof typeof asset.arrays].buffer,
      ),
    ).toEqual(bytes);
});
test.each([
  "license",
  "author",
  "source",
  "height",
  "capacity",
  "digest",
  "budget",
  "duplicate",
  "encoded",
])("rejects invalid %s without changing inputs", async (kind) => {
  const { prepareGroundPackage } = await import("./prepared-ground");
  const x = await preparedInput();
  if (kind === "license") x.licenseText = "";
  if (kind === "author")
    x.metadata = {
      ...x.metadata,
      provenance: { ...x.metadata.provenance, author: "" },
    };
  if (kind === "source")
    x.metadata = {
      ...x.metadata,
      provenance: { ...x.metadata.provenance, source: "javascript:alert(1)" },
    };
  if (kind === "height") x.heightProxy.heights[0] = NaN;
  if (kind === "capacity") x.native.capacity = 4096;
  if (kind === "digest") x.native.inputSha256 = "0".repeat(64);
  if (kind === "budget") x.native.numSplats = 250001;
  if (kind === "duplicate") x.native.outputs[1] = x.native.outputs[0];
  if (kind === "encoded") {
    new DataView(x.files.get("ext1.u32")!.buffer).setUint32(
      0,
      0xffffffff,
      true,
    );
    const { sha256 } = await import("./hash");
    x.native.outputs[1].sha256 = await sha256(x.files.get("ext1.u32")!);
    x.metadata = {
      ...x.metadata,
      provenance: {
        ...x.metadata.provenance,
        files: x.metadata.provenance.files.map((f, i) =>
          i === 1 ? { ...f, sha256: x.native.outputs[1].sha256 } : f,
        ),
      },
    };
  }
  const before = x.ply.slice();
  await expect(prepareGroundPackage(x)).rejects.toThrow();
  expect(x.ply).toEqual(before);
});
test("canonical identity ignores key order but binds content and mode", async () => {
  const { prepareGroundPackage, readPreparedGround } =
    await import("./prepared-ground");
  const a = await preparedFixture(),
    x = await preparedInput();
  x.metadata = Object.fromEntries(
    Object.entries(x.metadata).reverse(),
  ) as typeof x.metadata;
  expect(
    (await readPreparedGround(await prepareGroundPackage(x))).definition
      .metadata.contentVersion,
  ).toBe(a.asset.definition.metadata.contentVersion);
  x.licenseText += "Additional notice";
  expect(
    (await readPreparedGround(await prepareGroundPackage(x))).definition
      .metadata.contentVersion,
  ).not.toBe(a.asset.definition.metadata.contentVersion);
  const safe = await readPreparedGround(
    await prepareGroundPackage({ ...a.input, mode: "range-safe" }),
  );
  expect(safe.definition.mode).toBe("range-safe");
  expect(safe.arrays.ext0).toEqual(a.asset.arrays.ext0);
  expect(safe.arrays.sh1).not.toEqual(a.asset.arrays.sh1);
});
test("reopen rejects changed bytes, declaration, and unknown members", async () => {
  const { readPreparedGround } = await import("./prepared-ground");
  const { zip } = await preparedFixture();
  const b = unpackBundle(zip);
  b.files.get("sh1.u32")![0] ^= 1;
  await expect(readPreparedGround(packBundle(b))).rejects.toThrow();
  const c = unpackBundle(zip),
    m = JSON.parse(c.manifest);
  m.count = 1;
  c.manifest = JSON.stringify(m);
  await expect(readPreparedGround(packBundle(c))).rejects.toThrow();
});
