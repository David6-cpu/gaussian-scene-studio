import { record } from "../data-validation";
import { validateRecord, type EnvironmentRecord } from "./asset";
const magic = new TextEncoder().encode("WETENV1\n");
export async function encodeEnvironment(
  value: EnvironmentRecord,
): Promise<Uint8Array> {
  const r = await validateRecord(value),
    { spz, ...asset } = r.asset;
  const json = new TextEncoder().encode(JSON.stringify({ ...r, asset }));
  if (json.length > 1048576) throw Error("环境备份元数据超限。");
  const out = new Uint8Array(12 + json.length + spz.length);
  out.set(magic);
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  out.set(spz, 12 + json.length);
  return out;
}
export async function decodeEnvironment(
  bytes: Uint8Array,
): Promise<EnvironmentRecord> {
  if (
    bytes.length < 12 ||
    bytes.length > 65 * 1024 ** 2 + 12 ||
    magic.some((n, i) => bytes[i] !== n)
  )
    throw Error("不是受支持的环境备份，或文件超限。");
  const n = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(8, true);
  if (n < 1 || n > 1048576 || n + 12 >= bytes.length)
    throw Error("备份元数据长度无效。");
  const r = record(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(12, 12 + n),
      ),
    ),
    ["asset", "camera", "savedAt"],
  );
  if (
    !r.asset ||
    typeof r.asset !== "object" ||
    Array.isArray(r.asset) ||
    "spz" in r.asset
  )
    throw Error("环境备份结构无效。");
  return validateRecord({
    ...r,
    asset: { ...r.asset, spz: bytes.slice(12 + n) },
  });
}
