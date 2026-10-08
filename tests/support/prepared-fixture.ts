import { utils } from "@sparkjsdev/spark";
import { sha256 } from "../../src/io/hash.ts";
import type { AssetMetadata } from "../../src/assets/catalog/metadata.ts";

export async function preparedInput() {
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
  const header = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex 2\n${fields.map((f) => `property float ${f}\n`).join("")}end_header\n`,
  );
  const ply = new Uint8Array(header.length + 472);
  ply.set(header);
  const view = new DataView(ply.buffer);
  const keys = ["ext0", "ext1", "sh1", "sh2", "sh3a", "sh3b"] as const;
  const arrays = Object.fromEntries(
    keys.map((k) => [k, new Uint32Array(2048 * 4)]),
  ) as Record<(typeof keys)[number], Uint32Array>;
  for (let i = 0; i < 2; i++) {
    fields.forEach((f, j) =>
      view.setFloat32(
        header.length + i * 236 + j * 4,
        f === "x"
          ? i / 4
          : f === "rot_0"
            ? 1
            : f.startsWith("scale_")
              ? -3
              : f.startsWith("f_rest_")
                ? 0.75
                : 0,
        true,
      ),
    );
    utils.encodeExtSplat(
      [arrays.ext0, arrays.ext1],
      i,
      i / 4,
      0,
      0,
      Math.exp(-3),
      Math.exp(-3),
      Math.exp(-3),
      0,
      0,
      0,
      1,
      0.5,
      0.5,
      0.5,
      0.5,
    );
    for (let k = 0; k < 15; k++)
      arrays[keys[2 + Math.floor(k / 4)]][i * 4 + (k % 4)] = utils.encodeExtRgb(
        0.75,
        0.75,
        0.75,
      );
  }
  const files = new Map(
    keys.map((k) => [`${k}.u32`, new Uint8Array(arrays[k].buffer)]),
  );
  const outputs = await Promise.all(
    keys.map(async (key) => ({
      key,
      filename: `${key}.u32`,
      bytes: 32768,
      sha256: await sha256(files.get(`${key}.u32`)!),
    })),
  );
  const metadata: Omit<AssetMetadata, "contentVersion"> = {
    schemaVersion: 1,
    id: "test-prepared-ground",
    title: "Constructed test fixture — not captured evidence",
    category: "ground",
    biomes: ["wetland"],
    tags: ["ground"],
    origin: "captured",
    spatial: {
      unit: "display-unit",
      metricScale: false,
      scaleEvidence: null,
      upAxis: "+Y",
      forwardAxis: null,
      handedness: "right",
      dimensions: [4, null, 4],
      dimensionBasis: "usable-ground-area",
      anchor: [0, 0, 0],
      radius: null,
    },
    gaussian: { full: 2, coarse: null, shBands: 3, sourceBytes: 196608 },
    quality: {
      status: "trial",
      report: "docs/validation/riverside-integration.md",
      limitations: [
        "Synthetic fixture for software tests; not a source/quality claim.",
      ],
    },
    provenance: {
      author: "Test fixture",
      source: "https://example.invalid/fixture",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      licenseFile:
        "public/assets/local-ground/test-prepared-ground/LICENSE.txt",
      changes: "Constructed fixture",
      files: outputs.map((o) => ({
        path: `public/assets/local-ground/test-prepared-ground/${o.filename}`,
        bytes: o.bytes,
        sha256: o.sha256,
      })),
    },
    loader: "prepared-sh3-ground-v1" as AssetMetadata["loader"],
  };
  return {
    ply,
    files,
    metadata,
    native: {
      inputSha256: await sha256(ply),
      numSplats: 2,
      capacity: 2048,
      shBands: 3,
      outputs,
      display: {
        quaternionXYZW: [0, 0, 0, 1],
        position: [0, 0, 0],
        uniformScale: 1,
      },
    },
    heightProxy: {
      width: 4,
      depth: 4,
      spacing: 0.1,
      nx: 41,
      nz: 41,
      heights: Array(1681).fill(0),
    },
    licenseText: "Test-only license fixture; does not license a real asset.\n",
    purpose: "workflow-test" as const,
  };
}
export async function preparedFixture() {
  const { prepareGroundPackage, readPreparedGround } =
    await import("../../src/io/prepared-ground.ts");
  const input = await preparedInput(),
    zip = await prepareGroundPackage(input);
  return { input, zip, asset: await readPreparedGround(zip) };
}
