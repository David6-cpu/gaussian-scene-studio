import type {
  BuildResult,
  GaussianBuffer,
  AssetPrototype,
  Instance,
  Vec3,
  Quat,
  BuildReport,
  RiversideGround,
} from "../gaussian/types";
import { record, finite, integer, oneOf, vector } from "../data-validation";
import { parseRecipe, isRiverside, isRiverProps } from "../recipe";
import { buildScene } from "../build";
import { riversideData } from "../terrain/riverside-data";
import { RIVERSIDE_BYTES, assertRiversideGround } from "../terrain/riverside";
import {
  arraysFromFiles,
  groundArrayBytes,
  riversideAttribution,
  validateRiversideArrays,
} from "../assets/riverside";
import { sha256 } from "./hash";
export { sha256 } from "./hash";
import {
  assertGaussianBuffer,
  assertSceneBudget,
  countSplats,
  sourceBuffers,
} from "../gaussian/validate";
const LIMIT = 64 * 1024 * 1024;
const layout = "xyz-sigma-xyzw-linear-rgba-f32le";
const allowedName = /^[a-z0-9-]+\.(gsbin|f32|u32)$/;
// Each supported F0 recipe version is deterministic, not an arbitrary scene editor.
// Keep decoded bytes; compare to the recipe's output rather than silently replacing them.
// 1e-6 absolute tolerance permits insignificant cross-engine numeric rounding.
function assertCanonical(
  actual: unknown,
  expected: unknown,
  path: string,
): void {
  const fail = () => {
    throw new Error(`F0场景与配方不匹配：${path}`);
  };
  if (typeof expected === "number") {
    if (
      typeof actual !== "number" ||
      !Number.isFinite(actual) ||
      Math.abs(actual - expected) > 1e-6
    )
      fail();
  } else if (expected instanceof Float32Array) {
    if (!(actual instanceof Float32Array) || actual.length !== expected.length)
      fail();
    const values = actual as Float32Array;
    for (let i = 0; i < expected.length; i++)
      if (Math.abs(values[i] - expected[i]) > 1e-6) fail();
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) fail();
    expected.forEach((v, i) =>
      assertCanonical((actual as unknown[])[i], v, `${path}[${i}]`),
    );
  } else if (expected !== null && typeof expected === "object") {
    if (!actual || typeof actual !== "object") fail();
    for (const [key, value] of Object.entries(expected))
      assertCanonical(
        (actual as Record<string, unknown>)[key],
        value,
        `${path}.${key}`,
      );
  } else if (actual !== expected) fail();
}
function toBytes(data: Float32Array) {
  const bytes = new Uint8Array(data.length * 4),
    view = new DataView(bytes.buffer);
  data.forEach((x, i) => view.setFloat32(i * 4, x, true));
  return bytes;
}
export async function encodeBundle(
  result: BuildResult,
): Promise<{ manifest: string; files: Map<string, Uint8Array> }> {
  const files = new Map<string, Uint8Array>();
  const ground = result.scene.ground;
  if (ground) {
    assertRiversideGround(ground);
    if (!ground.arrays) throw new Error("Riverside素材尚未载入，无法保存");
    await validateRiversideArrays(ground.arrays);
    for (const file of riversideData.outputs)
      files.set(file.filename, groundArrayBytes(ground.arrays[file.key]));
  }
  const add = (name: string, b: GaussianBuffer) => {
    files.set(name, toBytes(b.data));
    return { file: name, count: b.count };
  };
  const scene = {
    terrain: add("terrain.gsbin", result.scene.terrain),
    water: result.scene.water ? add("water.gsbin", result.scene.water) : null,
    assets: result.scene.assets.map((a) => ({
      ...a,
      origin:
        result.recipe.algorithmVersion === "f0-riverside-grass-v2" &&
        a.id === "reed"
          ? "procedural-low-grass-v2"
          : isRiverProps(result.recipe.algorithmVersion)
            ? "procedural-river-props-v1"
            : "procedural-f0-v1",
      license: "project-local test data; no third-party source",
      lods: {
        full: add(a.id + "-full.gsbin", a.lods.full),
        coarse: add(a.id + "-coarse.gsbin", a.lods.coarse),
      },
    })),
    instances: result.scene.instances,
    ...(ground
      ? {
          ground: {
            id: ground.id,
            count: ground.count,
            position: ground.position,
            rotation: ground.rotation,
            scale: ground.scale,
            attribution: riversideAttribution,
          },
        }
      : {}),
  };
  files.set("heightfield.f32", toBytes(result.heightfield.heights));
  const metadata = await Promise.all(
    [...files].map(async ([name, b]) => ({
      name,
      byteLength: b.byteLength,
      sha256: await sha256(b),
    })),
  );
  const manifest = JSON.stringify(
    {
      format: "wetland-f0",
      version: ground ? 2 : 1,
      layout,
      recipe: result.recipe,
      report: result.report,
      heightfield: { ...result.heightfield, heights: "heightfield.f32" },
      scene,
      files: metadata,
    },
    null,
    2,
  );
  return { manifest, files };
}
export async function decodeBundle(
  text: string,
  files: Map<string, Uint8Array>,
): Promise<BuildResult> {
  if (
    text.length > 1024 * 1024 ||
    files.size > 13 ||
    [...files.values()].reduce((s, b) => s + b.byteLength, 0) > LIMIT
  )
    throw new Error("场景包超过限制");
  const m = record(JSON.parse(text), [
    "format",
    "version",
    "layout",
    "recipe",
    "report",
    "heightfield",
    "scene",
    "files",
  ]);
  oneOf(m.format, ["wetland-f0"]);
  const version = oneOf(m.version, [1, 2]);
  oneOf(m.layout, [layout]);
  const recipe = parseRecipe(m.recipe);
  const riverside = isRiverside(recipe.algorithmVersion);
  if ((version === 2) !== riverside || (!riverside && files.size > 7))
    throw new Error("场景包版本与地表不匹配");
  if (!Array.isArray(m.files) || m.files.length !== files.size)
    throw new Error("缺少文件或多余文件");
  const names = new Set<string>();
  for (const entry of m.files) {
    const meta = record(entry, ["name", "byteLength", "sha256"]);
    if (
      typeof meta.name !== "string" ||
      !allowedName.test(meta.name) ||
      names.has(meta.name)
    )
      throw new Error("非法文件名");
    names.add(meta.name);
    const bytes = files.get(meta.name);
    if (!bytes) throw new Error("缺少文件");
    if (bytes.byteLength !== integer(meta.byteLength, 0, LIMIT))
      throw new Error("文件长度错误");
    if (
      typeof meta.sha256 !== "string" ||
      (await sha256(bytes)) !== meta.sha256
    )
      throw new Error("SHA-256 摘要不匹配");
  }
  const consumed = new Set<string>();
  const readFloats = (name: unknown, count: number) => {
    if (typeof name !== "string" || !names.has(name))
      throw new Error("缺少文件");
    consumed.add(name);
    const bytes = files.get(name)!;
    if (bytes.byteLength !== count * 4) throw new Error("二进制长度错误");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      out = new Float32Array(count);
    for (let i = 0; i < count; i++)
      out[i] = finite(view.getFloat32(i * 4, true));
    return out;
  };
  const readGaussian = (value: unknown): GaussianBuffer => {
    const b = record(value, ["file", "count"]),
      count = integer(b.count, 0, 250000),
      out = { count, data: readFloats(b.file, count * 14) };
    assertGaussianBuffer(out);
    return out;
  };
  const hf = record(m.heightfield, [
    "width",
    "depth",
    "spacing",
    "nx",
    "nz",
    "heights",
  ]);
  const nx = recipe.width / recipe.spacing + 1,
    nz = recipe.depth / recipe.spacing + 1;
  if (
    hf.width !== recipe.width ||
    hf.depth !== recipe.depth ||
    hf.spacing !== recipe.spacing ||
    hf.nx !== nx ||
    hf.nz !== nz
  )
    throw new Error("高度场与配方不匹配");
  const heightfield = {
    width: recipe.width,
    depth: recipe.depth,
    spacing: recipe.spacing,
    nx,
    nz,
    heights: readFloats(hf.heights, nx * nz),
  };
  for (const h of riverside ? [] : heightfield.heights)
    if (Math.abs(h) > recipe.amplitude / 2 + 1e-6)
      throw new Error("高度场起伏越限");
  const s = record(m.scene, [
    "terrain",
    "water",
    "assets",
    "instances",
    ...(riverside ? ["ground"] : []),
  ]);
  let ground: RiversideGround | undefined;
  if (riverside) {
    const g = record(s.ground, [
      "id",
      "count",
      "position",
      "rotation",
      "scale",
      "attribution",
    ]);
    record(g.attribution, Object.keys(riversideAttribution));
    assertCanonical(g.attribution, riversideAttribution, "ground.attribution");
    ground = {
      id: oneOf(g.id, ["riverside-ground-v1"] as const),
      count: oneOf(g.count, [64949] as const),
      position: vector(g.position, 3) as unknown as Vec3,
      rotation: vector(g.rotation, 4) as unknown as Quat,
      scale: finite(g.scale),
    };
    assertRiversideGround(ground);
    ground.arrays = await arraysFromFiles(files);
    for (const file of riversideData.outputs) consumed.add(file.filename);
  }
  if (
    !Array.isArray(s.assets) ||
    s.assets.length !== 2 ||
    !Array.isArray(s.instances) ||
    s.instances.length > 20
  )
    throw new Error("资产或实例数量错误");
  const assetIds = new Set<string>();
  const assets: AssetPrototype[] = s.assets.map((value) => {
    const a = record(value, [
        "id",
        "synthetic",
        "radius",
        "anchor",
        "supportPoints",
        "lods",
        "origin",
        "license",
      ]),
      id = oneOf(a.id, ["rock", "reed"] as const);
    if (assetIds.has(id)) throw new Error("重复资产");
    assetIds.add(id);
    oneOf(a.synthetic, [true]);
    oneOf(a.origin, [
      recipe.algorithmVersion === "f0-riverside-grass-v2" && id === "reed"
        ? "procedural-low-grass-v2"
        : isRiverProps(recipe.algorithmVersion)
          ? "procedural-river-props-v1"
          : "procedural-f0-v1",
    ]);
    oneOf(a.license, ["project-local test data; no third-party source"]);
    const radius = finite(a.radius, 0.001, 10),
      anchor = vector(a.anchor, 3) as unknown as Vec3;
    if (
      !Array.isArray(a.supportPoints) ||
      a.supportPoints.length < 1 ||
      a.supportPoints.length > 8
    )
      throw new Error("错误支撑点");
    const supportPoints = a.supportPoints.map(
      (p) => vector(p, 3) as unknown as Vec3,
    );
    const lod = record(a.lods, ["full", "coarse"]),
      full = readGaussian(lod.full),
      coarse = readGaussian(lod.coarse);
    if (full.count !== 4096 || coarse.count !== 1024)
      throw new Error("不支持的F0资产版本");
    return {
      id,
      synthetic: true,
      radius,
      anchor,
      supportPoints,
      lods: { full, coarse },
    };
  });
  const instances: Instance[] = s.instances.map((value) => {
    const i = record(value, [
      "id",
      "assetId",
      "position",
      "rotation",
      "scale",
      "lod",
    ]);
    if (typeof i.id !== "string" || !/^(rock|reed)-[0-9]+$/.test(i.id))
      throw new Error("错误实例ID");
    return {
      id: i.id,
      assetId: oneOf(i.assetId, ["rock", "reed"] as const),
      position: vector(i.position, 3) as unknown as Vec3,
      rotation: vector(i.rotation, 4) as unknown as Quat,
      scale: finite(i.scale, 0.01, 10),
      lod: oneOf(i.lod, ["full", "coarse"] as const),
    };
  });
  const scene = {
    terrain: readGaussian(s.terrain),
    water: s.water === null ? null : readGaussian(s.water),
    assets,
    instances,
    ...(ground ? { ground } : {}),
  };
  assertSceneBudget(scene);
  const maxSurfaceSamples =
    nx *
    nz *
    (recipe.algorithmVersion === "f0-v1"
      ? 1
      : Math.round(recipe.spacing / 0.05) ** 2);
  if (
    (riverside
      ? scene.terrain.count !== 0
      : recipe.algorithmVersion === "f0-v1"
        ? scene.terrain.count !== nx * nz
        : scene.terrain.count < nx * nz ||
          scene.terrain.count > maxSurfaceSamples) ||
    (recipe.waterLevel === null) !== (scene.water === null) ||
    (scene.water &&
      scene.water.count > (riverside ? nx * nz : scene.terrain.count))
  )
    throw new Error("地表与配方不匹配");
  const report = record(m.report, [
    "algorithmVersion",
    "requested",
    "accepted",
    "shortfall",
    "rejections",
    "stageMs",
    "uniqueSourceSplats",
    "activeSplats",
    "cpuBufferBytes",
  ]);
  oneOf(report.algorithmVersion, [recipe.algorithmVersion]);
  const counts = countSplats(scene),
    accepted = { rock: 0, reed: 0 };
  for (const i of instances) accepted[i.assetId]++;
  for (const field of ["requested", "accepted", "shortfall"] as const) {
    const actual = record(report[field], ["rock", "reed"]);
    for (const id of ["rock", "reed"] as const) {
      const expected =
        field === "requested"
          ? recipe.requested[id]
          : field === "accepted"
            ? accepted[id]
            : recipe.requested[id] - accepted[id];
      if (expected < 0 || actual[id] !== expected)
        throw new Error("报告实例计数不匹配");
    }
  }
  if (
    report.uniqueSourceSplats !== counts.uniqueSourceSplats ||
    report.activeSplats !== counts.activeSplats ||
    report.cpuBufferBytes !==
      sourceBuffers(scene).reduce((sum, b) => sum + b.data.byteLength, 0) +
        heightfield.heights.byteLength +
        (riverside ? RIVERSIDE_BYTES : 0)
  )
    throw new Error("报告资源计数不匹配");
  const times = record(report.stageMs, [
    "heightfield",
    "sampling",
    "assets",
    "placement",
    "total",
  ]);
  for (const v of Object.values(times)) finite(v, 0, 86400000);
  if (
    !report.rejections ||
    typeof report.rejections !== "object" ||
    Array.isArray(report.rejections)
  )
    throw new Error("错误拒绝统计");
  for (const [key, v] of Object.entries(report.rejections)) {
    oneOf(key, [
      "boundary",
      "water",
      "slope",
      "spacing",
      "support",
      ...(isRiverProps(recipe.algorithmVersion) ? ["shore-distance"] : []),
    ]);
    integer(v, 0, 6000);
  }
  if (consumed.size !== names.size) throw new Error("未引用的额外文件");
  const canonical = buildScene(recipe);
  assertCanonical(heightfield, canonical.heightfield, "heightfield");
  assertCanonical(scene, canonical.scene, "scene");
  return {
    recipe,
    scene,
    heightfield,
    report: report as unknown as BuildReport,
  };
}
