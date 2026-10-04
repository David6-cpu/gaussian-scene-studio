import { expect, test } from "vitest";
import { utils } from "@sparkjsdev/spark";
import { sha256 } from "./hash";
import { packBundle, unpackBundle } from "./archive";
import { prepareSh3Variant, readSh3Variant } from "./sh3-variant";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const keys = ["ext0", "ext1", "sh1", "sh2", "sh3a", "sh3b"] as const;
async function fixture(reversed = false) {
  const fields = [
    "x",
    "y",
    "z",
    ...[0, 1, 2].map((i) => `f_dc_${i}`),
    ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
    "opacity",
    ...[0, 1, 2].map((i) => `scale_${i}`),
    ...[0, 1, 2, 3].map((i) => `rot_${i}`),
  ];
  if (reversed) fields.reverse();
  const header = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex 2\n${fields.map((f) => `property float ${f}\n`).join("")}end_header\n`,
  );
  const ply = new Uint8Array(header.length + 2 * 236);
  ply.set(header);
  const v = new DataView(ply.buffer),
    files = new Map<string, Uint8Array>();
  const coefficient = (c: number, k: number, i: number) =>
    Math.fround((c === 1 ? -1 : 1) * (0.6 + 0.01 * (k + 15 * c) + 0.005 * i));
  for (let i = 0; i < 2; i++)
    fields.forEach((f, j) => {
      const rest = /^f_rest_(\d+)$/.exec(f);
      const n = rest ? Number(rest[1]) : 0;
      v.setFloat32(
        header.length + i * 236 + j * 4,
        rest
          ? coefficient(Math.floor(n / 15), n % 15, i)
          : f === "x"
            ? i + 1
            : 0,
        true,
      );
    });
  for (const key of keys) files.set(`${key}.u32`, new Uint8Array(2048 * 16));
  const centres = new DataView(files.get("ext0.u32")!.buffer);
  for (let i = 0; i < 2; i++) {
    centres.setFloat32(i * 16, i + 1, true);
    for (let k = 0; k < 15; k++) {
      const key = keys[2 + Math.floor(k / 4)],
        bytes = files.get(`${key}.u32`)!;
      new DataView(bytes.buffer).setUint32(
        i * 16 + (k % 4) * 4,
        utils.encodeExtRgb(
          coefficient(0, k, i),
          coefficient(1, k, i),
          coefficient(2, k, i),
        ),
        true,
      );
    }
  }
  const native = {
    inputSha256: await sha256(ply),
    numSplats: 2,
    shBands: 3,
    capacity: 2048,
    display: {
      quaternionXYZW: [0, 0, 0, 1],
      position: [0, 0, 0],
      uniformScale: 1,
    },
    outputs: await Promise.all(
      keys.map(async (key) => ({
        key,
        filename: `${key}.u32`,
        bytes: 2048 * 16,
        sha256: await sha256(files.get(`${key}.u32`)!),
      })),
    ),
  };
  return { ply, native, files, coefficient };
}

test("default import preserves all native bytes and point count", async () => {
  const f = await fixture();
  const result = await prepareSh3Variant(
    f.ply,
    f.native,
    f.files,
    "Test fixture; no third-party asset",
  );
  const decoded = await readSh3Variant(packBundle(result));
  expect(decoded.manifest.mode).toBe("native");
  expect(decoded.manifest.count).toBe(2);
  for (const key of keys)
    expect(new Uint8Array(decoded.arrays[key].buffer)).toEqual(
      f.files.get(`${key}.u32`),
    );
});

test("range-safe import maps all 45 SH fields by name and preserves geometry", async () => {
  const f = await fixture(true),
    before = f.ply.slice();
  const result = await prepareSh3Variant(
    f.ply,
    f.native,
    f.files,
    "Test fixture",
    "range-safe",
  );
  const decoded = await readSh3Variant(packBundle(result));
  expect(decoded.manifest.mode).toBe("range-safe");
  for (const key of ["ext0", "ext1"] as const)
    expect(new Uint8Array(decoded.arrays[key].buffer)).toEqual(
      f.files.get(`${key}.u32`),
    );
  for (let i = 0; i < 2; i++)
    for (let k = 0; k < 15; k++) {
      const key = keys[2 + Math.floor(k / 4)];
      const word = decoded.arrays[key][i * 4 + (k % 4)];
      const rgb = utils.decodeExtRgb(word).toArray(),
        step = 2 ** ((word >>> 27) - 15) / 255;
      for (let c = 0; c < 3; c++)
        expect(Math.abs(rgb[c] - f.coefficient(c, k, i))).toBeLessThanOrEqual(
          step / 2 + 1e-12,
        );
    }
  expect(f.ply).toEqual(before);
  for (const entry of f.native.outputs)
    expect(await sha256(f.files.get(entry.filename)!)).toBe(entry.sha256);
  expect(decoded.arrays.sh3b[7]).toBe(0); // reserved word, not a 16th coefficient
});

test("range-safe package save/reopen retains encoding, credit, SH and every array byte", async () => {
  const f = await fixture(),
    bundle = await prepareSh3Variant(
      f.ply,
      f.native,
      f.files,
      "Author / CC BY 4.0 / source URL",
      "range-safe",
    );
  const zip = packBundle(bundle),
    a = await readSh3Variant(zip),
    b = await readSh3Variant(zip.slice());
  expect(a).toEqual(b);
  expect(a.manifest.credit).toContain("CC BY 4.0");
  expect(a.manifest.shBands).toBe(3);
  expect(unpackBundle(zip).files.size).toBe(6);
});

test("source identity and six-array integrity are required before re-encoding", async () => {
  const f = await fixture();
  f.ply[f.ply.length - 1] ^= 1;
  await expect(
    prepareSh3Variant(f.ply, f.native, f.files, "credit", "range-safe"),
  ).rejects.toThrow(/source.*hash/i);
  f.ply[f.ply.length - 1] ^= 1;
  f.files.get("sh2.u32")![0] ^= 1;
  await expect(
    prepareSh3Variant(f.ply, f.native, f.files, "credit", "range-safe"),
  ).rejects.toThrow(/array.*hash/i);
});

test("the 250k input budget, SH3 degree and unknown modes are rejected", async () => {
  const f = await fixture();
  for (const count of [0, -1, 250001, 1.5])
    await expect(
      prepareSh3Variant(
        f.ply,
        { ...f.native, numSplats: count },
        f.files,
        "credit",
      ),
    ).rejects.toThrow();
  await expect(
    prepareSh3Variant(f.ply, { ...f.native, shBands: 0 }, f.files, "credit"),
  ).rejects.toThrow();
  await expect(
    prepareSh3Variant(f.ply, f.native, f.files, "credit", "auto" as never),
  ).rejects.toThrow();
});

test("reopen rejects changed bytes, over-budget point counts, invalid codecs and missing SH", async () => {
  const f = await fixture(),
    bundle = await prepareSh3Variant(
      f.ply,
      f.native,
      f.files,
      "credit",
      "range-safe",
    );
  for (const mutation of ["bytes", "count", "mode", "missing"]) {
    const copy = unpackBundle(packBundle(bundle)),
      manifest = JSON.parse(copy.manifest);
    if (mutation === "bytes") copy.files.get("sh1.u32")![0] ^= 1;
    if (mutation === "count") manifest.count = 250001;
    if (mutation === "mode") manifest.mode = "float32";
    if (mutation === "missing") copy.files.delete("sh3b.u32");
    copy.manifest = JSON.stringify(manifest);
    await expect(readSh3Variant(packBundle(copy))).rejects.toThrow();
  }
});

test("CLI creates native by default, allows explicit correction and never overwrites an archive", async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), "sh3-import-test-"));
  try {
    const ply = join(dir, "crop.ply"),
      native = join(dir, "native.json"),
      out = join(dir, "result.zip");
    writeFileSync(ply, f.ply);
    writeFileSync(native, JSON.stringify(f.native));
    for (const [name, bytes] of f.files) writeFileSync(join(dir, name), bytes);
    const args = [
      "scripts/prepare-sh3-variant.ts",
      "--ply",
      ply,
      "--native",
      native,
      "--out",
      out,
      "--credit",
      "Test fixture",
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    expect((await readSh3Variant(readFileSync(out))).manifest.mode).toBe(
      "native",
    );
    const before = readFileSync(out);
    const duplicate = spawnSync(
      process.execPath,
      [...args, "--mode", "range-safe"],
      { encoding: "utf8" },
    );
    expect(duplicate.status).toBe(1);
    expect(readFileSync(out)).toEqual(before);
    args[args.indexOf(out)] = join(dir, "safe.zip");
    const safe = spawnSync(
      process.execPath,
      [...args, "--mode", "range-safe"],
      { encoding: "utf8" },
    );
    expect(safe.status, safe.stderr).toBe(0);
    expect(
      (await readSh3Variant(readFileSync(join(dir, "safe.zip")))).manifest.mode,
    ).toBe("range-safe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsupported, nonfinite, out-of-range and reordered source data cannot be repaired silently", async () => {
  for (const kind of ["missing-sh", "nonfinite", "range", "order"]) {
    const f = await fixture();
    const offset = new TextDecoder().decode(f.ply).indexOf("end_header\n") + 11;
    if (kind === "missing-sh") {
      const text = new TextDecoder()
        .decode(f.ply.subarray(0, offset))
        .replace("f_rest_44", "f_rest_43");
      f.ply.set(new TextEncoder().encode(text));
    } else
      new DataView(f.ply.buffer).setFloat32(
        offset + (kind === "order" ? 0 : 6 * 4),
        kind === "nonfinite" ? NaN : kind === "range" ? 65537 : 3,
        true,
      );
    f.native.inputSha256 = await sha256(f.ply);
    await expect(
      prepareSh3Variant(f.ply, f.native, f.files, "credit", "range-safe"),
    ).rejects.toThrow();
  }
});
