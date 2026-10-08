import type {
  SceneBuildResult,
  PreparedBuildResult,
  BuildResult,
  GaussianBuffer,
  GroundArrays,
  GroundArrayKey,
} from "../gaussian/types";
import { encodeBundle, decodeBundle, assertCanonical, toBytes } from "./bundle";
import {
  arrayBytes,
  parsePreparedDefinition,
  validatePreparedArrays,
} from "./prepared-ground";
import { sha256 } from "./hash";
import { parsePreparedRecipe, buildPreparedScene } from "../prepared-scene";
import { record, finite } from "../data-validation";
const keys: GroundArrayKey[] = ["ext0", "ext1", "sh1", "sh2", "sh3a", "sh3b"];
const LIMIT = 64 * 1024 ** 2;
async function encodePrepared(result: PreparedBuildResult) {
  const g = result.scene.ground;
  if (!g || !("kind" in g) || !g.arrays)
    throw Error("Prepared ground bytes are required");
  const files = new Map<string, Uint8Array>();
  for (const k of keys) files.set(`ground-${k}.u32`, arrayBytes(g.arrays[k]));
  const add = (name: string, b: GaussianBuffer) => {
    files.set(name, toBytes(b.data));
    return { file: name, count: b.count };
  };
  const scene = {
    terrain: add("terrain.gsbin", result.scene.terrain),
    water: result.scene.water ? add("water.gsbin", result.scene.water) : null,
    assets: result.scene.assets.map((a) => ({
      ...a,
      lods: {
        full: add(a.id + "-full.gsbin", a.lods.full),
        coarse: add(a.id + "-coarse.gsbin", a.lods.coarse),
      },
    })),
    instances: result.scene.instances,
    ground: {
      id: g.id,
      count: g.count,
      position: g.position,
      rotation: g.rotation,
      scale: g.scale,
    },
  };
  files.set("heightfield.f32", toBytes(result.heightfield.heights));
  return {
    manifest: JSON.stringify(
      {
        format: "wetland-f0",
        version: 3,
        layout: "xyz-sigma-xyzw-linear-rgba-f32le",
        recipe: result.recipe,
        definition: g.definition,
        report: result.report,
        heightfield: { ...result.heightfield, heights: "heightfield.f32" },
        scene,
        files: await Promise.all(
          [...files].map(async ([name, b]) => ({
            name,
            byteLength: b.byteLength,
            sha256: await sha256(b),
          })),
        ),
      },
      null,
      2,
    ),
    files,
  };
}
export async function encodeSceneBundle(result: SceneBuildResult) {
  if (result.recipe.schemaVersion === 1)
    return encodeBundle(result as BuildResult);
  const b = await encodePrepared(result as PreparedBuildResult);
  await decodeSceneBundle(b.manifest, b.files);
  return b;
}
function sameShape(actual: unknown, expected: unknown) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      throw Error("Scene array shape mismatch");
    expected.forEach((v, i) => sameShape(actual[i], v));
  } else if (expected && typeof expected === "object") {
    const e = expected as Record<string, unknown>,
      a = record(actual, Object.keys(e));
    for (const k of Object.keys(e)) sameShape(a[k], e[k]);
  }
}
export async function decodeSceneBundle(
  text: string,
  files: Map<string, Uint8Array>,
): Promise<SceneBuildResult> {
  if (
    new TextEncoder().encode(text).byteLength > 1048576 ||
    files.size > 13 ||
    [...files.values()].reduce((s, b) => s + b.byteLength, 0) > LIMIT
  )
    throw Error("Scene archive exceeds budget");
  const header = JSON.parse(text);
  if (
    header?.format === "wetland-f0" &&
    (header.version === 1 || header.version === 2)
  )
    return decodeBundle(text, files);
  const m = record(header, [
    "format",
    "version",
    "layout",
    "recipe",
    "definition",
    "report",
    "heightfield",
    "scene",
    "files",
  ]);
  if (
    m.format !== "wetland-f0" ||
    m.version !== 3 ||
    m.layout !== "xyz-sigma-xyzw-linear-rgba-f32le"
  )
    throw Error("Unsupported scene version");
  const d = await parsePreparedDefinition(m.definition),
    recipe = parsePreparedRecipe(m.recipe),
    expected = buildPreparedScene(recipe, d);
  const arrays = {} as GroundArrays;
  for (const k of keys) {
    const b = files.get(`ground-${k}.u32`);
    if (!b || b.length !== d.capacity * 16) throw Error("Missing ground array");
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
      a = new Uint32Array(b.length / 4);
    for (let i = 0; i < a.length; i++) a[i] = v.getUint32(i * 4, true);
    arrays[k] = a;
  }
  await validatePreparedArrays(d, arrays);
  expected.scene.ground!.arrays = arrays;
  const report = record(m.report, Object.keys(expected.report)),
    stage = record(report.stageMs, Object.keys(expected.report.stageMs));
  for (const k of Object.keys(stage)) finite(stage[k], 0, 3600000);
  expected.report.stageMs = stage as typeof expected.report.stageMs;
  const canonical = await encodePrepared(expected),
    e = JSON.parse(canonical.manifest);
  if (
    !Array.isArray(m.files) ||
    m.files.length !== files.size ||
    files.size !== canonical.files.size
  )
    throw Error("Missing or extra scene files");
  const names = new Set<string>();
  for (const v of m.files) {
    const f = record(v, ["name", "byteLength", "sha256"]);
    if (
      typeof f.name !== "string" ||
      names.has(f.name) ||
      !canonical.files.has(f.name)
    )
      throw Error("Invalid scene filename");
    names.add(f.name);
    const b = files.get(f.name);
    if (!b || b.length !== f.byteLength || (await sha256(b)) !== f.sha256)
      throw Error("Scene SHA-256 mismatch");
  }
  e.files = m.files;
  sameShape(m, e);
  assertCanonical(m, e, "scene");
  const floats = (name: string, reference: Float32Array) => {
    const b = files.get(name)!;
    if (b.length !== reference.byteLength)
      throw Error("Scene buffer length mismatch");
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
      out = new Float32Array(reference.length);
    for (let i = 0; i < out.length; i++)
      out[i] = finite(v.getFloat32(i * 4, true));
    assertCanonical(out, reference, name);
    return out;
  };
  expected.heightfield.heights = floats(
    "heightfield.f32",
    expected.heightfield.heights,
  );
  const replace = (n: string, b: GaussianBuffer) => ({
    count: b.count,
    data: floats(n, b.data),
  });
  expected.scene.terrain = replace("terrain.gsbin", expected.scene.terrain);
  if (expected.scene.water)
    expected.scene.water = replace("water.gsbin", expected.scene.water);
  expected.scene.assets = expected.scene.assets.map((a) => ({
    ...a,
    lods: {
      full: replace(a.id + "-full.gsbin", a.lods.full),
      coarse: replace(a.id + "-coarse.gsbin", a.lods.coarse),
    },
  }));
  // Preserve validated stored transforms and metadata; do not replace tampered values with a rebuild.
  const scene = m.scene as any;
  expected.scene.instances = structuredClone(scene.instances);
  expected.scene.ground = { ...expected.scene.ground!, ...scene.ground };
  return expected;
}
