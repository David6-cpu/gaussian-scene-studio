import { record, oneOf, finite, integer, vector } from "../data-validation";
import { sha256 } from "../io/hash";
import { canonicalJson } from "../io/prepared-ground";
import { inspectSpz, SOURCE_LIMIT } from "./spz";
export type Camera = {
  position: [number, number, number];
  target: [number, number, number];
};
export interface EnvironmentAsset {
  format: "wetland-environment";
  version: 1;
  id: string;
  source: {
    provider: "world-labs-compatible";
    worldId: string;
    title: string;
    model: string | null;
    metadataSha256: string;
    requestSha256: string | null;
    generationStatus: "unknown" | "completed";
    operationId: string | null;
    prompt: string | null;
    returnedPrompt: string | null;
    seed: number | null;
    recaption: boolean | "unknown" | "omitted";
  };
  transform: {
    scale: number;
    offset: number;
    flipY: boolean;
    flipSource: "metadata" | "world-labs-default";
    policy: "marble-raw-three-v1";
  };
  splats: {
    version: 2 | 3;
    count: number;
    shDegree: number;
    decodedBytes: number;
    bytes: number;
    sha256: string;
  };
  quality: "visual-pending";
  spz: Uint8Array;
}
export interface EnvironmentRecord {
  asset: EnvironmentAsset;
  camera: Camera;
  savedAt: string;
}
function text(v: unknown, max = 8192): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
  )
    throw Error("环境文本无效。");
  return v;
}
const optional = (v: unknown) => (v == null ? null : text(v));
const digest = (v: unknown) => {
  const s = text(v, 64);
  if (!/^[a-f0-9]{64}$/.test(s)) throw Error("摘要无效。");
  return s;
};
const obj = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("环境元数据对象缺失。");
  return v as Record<string, any>;
};
function json(bytes: Uint8Array) {
  if (bytes.length > 1048576) throw Error("环境JSON超过1MiB。");
  return obj(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
export const environmentTransform = (a: EnvironmentAsset) => ({
  scale: a.transform.scale,
  offset: a.transform.offset,
  flipY: a.transform.flipY,
});
export async function importEnvironment(
  worldBytes: Uint8Array,
  spz: Uint8Array,
  requestBytes?: Uint8Array,
): Promise<EnvironmentAsset> {
  const raw = json(worldBytes),
    request = requestBytes ? json(requestBytes) : undefined;
  if ("done" in raw && (raw.done !== true || raw.error))
    throw Error("生成任务尚未完成或失败，不能预览。");
  if (request?.status && request.status !== "completed")
    throw Error("生成任务尚未完成或失败，不能预览。");
  const world = obj(raw.world ?? raw.response ?? raw),
    semantics = obj(obj(obj(world.assets).splats).semantics_metadata);
  const req = request?.request ? obj(request.request) : undefined;
  const prompt = req?.world_prompt ? obj(req.world_prompt) : undefined;
  const returned =
    typeof world.world_prompt === "string"
      ? world.world_prompt
      : world.world_prompt?.text_prompt;
  const spzBytes = new Uint8Array(spz),
    info = inspectSpz(spzBytes);
  const metadata = {
    format: "wetland-environment" as const,
    version: 1 as const,
    source: {
      provider: "world-labs-compatible" as const,
      worldId: text(world.id ?? world.world_id, 200),
      title: text(world.display_name || "导入环境", 200),
      model: optional(world.model),
      metadataSha256: await sha256(worldBytes),
      requestSha256: requestBytes ? await sha256(requestBytes) : null,
      generationStatus: (raw.done === true || request?.status === "completed"
        ? "completed"
        : "unknown") as "completed" | "unknown",
      operationId: optional(request?.request_id ?? raw.operation_id),
      prompt: optional(prompt?.text_prompt ?? request?.prompt),
      returnedPrompt: optional(returned),
      seed: req?.seed == null ? null : integer(req.seed, 0, 4294967295),
      recaption: prompt
        ? "disable_recaption" in prompt
          ? oneOf(prompt.disable_recaption, [true, false])
          : ("omitted" as const)
        : ("unknown" as const),
    },
    transform: {
      scale: finite(semantics.metric_scale_factor, Number.MIN_VALUE, 1000),
      offset: finite(semantics.ground_plane_offset, -10000, 10000),
      flipY:
        semantics.flip_y === undefined
          ? true
          : oneOf(semantics.flip_y, [true, false]),
      flipSource: (semantics.flip_y === undefined
        ? "world-labs-default"
        : "metadata") as "world-labs-default" | "metadata",
      policy: "marble-raw-three-v1" as const,
    },
    splats: { ...info, bytes: spzBytes.length, sha256: await sha256(spzBytes) },
    quality: "visual-pending" as const,
  };
  return {
    ...metadata,
    id: await sha256(new TextEncoder().encode(canonicalJson(metadata))),
    spz: spzBytes,
  };
}
export async function validateAsset(value: unknown): Promise<EnvironmentAsset> {
  const a = record(value, [
    "format",
    "version",
    "id",
    "source",
    "transform",
    "splats",
    "quality",
    "spz",
  ]);
  oneOf(a.format, ["wetland-environment"]);
  oneOf(a.version, [1]);
  oneOf(a.quality, ["visual-pending"]);
  const s = record(a.source, [
    "provider",
    "worldId",
    "title",
    "model",
    "metadataSha256",
    "requestSha256",
    "generationStatus",
    "operationId",
    "prompt",
    "returnedPrompt",
    "seed",
    "recaption",
  ]);
  oneOf(s.provider, ["world-labs-compatible"]);
  text(s.worldId, 200);
  text(s.title, 200);
  optional(s.model);
  digest(s.metadataSha256);
  if (s.requestSha256 !== null) digest(s.requestSha256);
  oneOf(s.generationStatus, ["unknown", "completed"]);
  optional(s.operationId);
  optional(s.prompt);
  optional(s.returnedPrompt);
  if (s.seed !== null) integer(s.seed, 0, 4294967295);
  oneOf(s.recaption, [true, false, "unknown", "omitted"]);
  const t = record(a.transform, [
    "scale",
    "offset",
    "flipY",
    "flipSource",
    "policy",
  ]);
  finite(t.scale, Number.MIN_VALUE, 1000);
  finite(t.offset, -10000, 10000);
  oneOf(t.flipY, [true, false]);
  oneOf(t.flipSource, ["metadata", "world-labs-default"]);
  oneOf(t.policy, ["marble-raw-three-v1"]);
  if (t.flipSource === "world-labs-default" && !t.flipY)
    throw Error("默认轴策略不一致。");
  const g = record(a.splats, [
    "version",
    "count",
    "shDegree",
    "decodedBytes",
    "bytes",
    "sha256",
  ]);
  if (!(a.spz instanceof Uint8Array) || a.spz.length > SOURCE_LIMIT)
    throw Error("SPZ字节缺失或超限。");
  const info = inspectSpz(a.spz);
  for (const k of ["version", "count", "shDegree", "decodedBytes"] as const)
    if (g[k] !== info[k]) throw Error("SPZ声明与文件不一致。");
  if (g.bytes !== a.spz.length || digest(g.sha256) !== (await sha256(a.spz)))
    throw Error("SPZ摘要不一致。");
  const { id, spz, ...metadata } = a;
  if (
    digest(id) !==
    (await sha256(new TextEncoder().encode(canonicalJson(metadata))))
  )
    throw Error("环境身份摘要不一致。");
  return structuredClone(a) as unknown as EnvironmentAsset;
}
export function parseCamera(value: unknown): Camera {
  const c = record(value, ["position", "target"]);
  const position = vector(c.position, 3) as Camera["position"],
    target = vector(c.target, 3) as Camera["target"];
  if (
    [...position, ...target].some((n) => Math.abs(n) > 100000) ||
    Math.hypot(...position.map((n, i) => n - target[i])) < 0.001
  )
    throw Error("相机位置无效。");
  return { position, target };
}
export async function validateRecord(
  value: unknown,
): Promise<EnvironmentRecord> {
  const r = record(value, ["asset", "camera", "savedAt"]),
    savedAt = text(r.savedAt, 30);
  if (
    !Number.isFinite(Date.parse(savedAt)) ||
    new Date(savedAt).toISOString() !== savedAt
  )
    throw Error("保存时间无效。");
  return {
    asset: await validateAsset(r.asset),
    camera: parseCamera(r.camera),
    savedAt,
  };
}
