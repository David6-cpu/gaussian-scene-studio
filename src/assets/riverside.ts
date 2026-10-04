import type { GroundArrays } from "../gaussian/types";
import { riversideData } from "../terrain/riverside-data";
import { readExactAsset } from "../diagnostics/load";
import { sha256 } from "../io/hash";

export const riversideAttribution = {
  author: riversideData.author,
  title: riversideData.title,
  source: riversideData.source,
  license: riversideData.license,
  licenseUrl: riversideData.licenseUrl,
  changes: riversideData.changes,
};
export function groundArrayBytes(a: Uint32Array): Uint8Array {
  const b = new Uint8Array(a.length * 4),
    view = new DataView(b.buffer);
  a.forEach((n, i) => view.setUint32(i * 4, n, true));
  return b;
}
export async function readRiversideArrays(
  read: (name: string) => Promise<Uint8Array> | Uint8Array,
): Promise<GroundArrays> {
  const arrays = {} as GroundArrays;
  for (const file of riversideData.outputs) {
    const bytes = await read(file.filename);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== file.bytes ||
      (await sha256(bytes)) !== file.sha256
    )
      throw new Error(`Riverside素材长度或摘要不匹配：${file.filename}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    arrays[file.key] = Uint32Array.from(
      { length: bytes.byteLength / 4 },
      (_, i) => view.getUint32(i * 4, true),
    );
  }
  return arrays;
}
export async function validateRiversideArrays(
  arrays: GroundArrays,
): Promise<void> {
  if (!arrays || Object.keys(arrays).length !== 6)
    throw new Error("Riverside缺少SH3数组");
  for (const file of riversideData.outputs) {
    const a = arrays[file.key];
    if (
      !(a instanceof Uint32Array) ||
      a.byteLength !== file.bytes ||
      (await sha256(groundArrayBytes(a))) !== file.sha256
    )
      throw new Error(`Riverside素材长度或摘要不匹配：${file.filename}`);
  }
}
export async function loadRiversideArrays(
  signal?: AbortSignal,
): Promise<GroundArrays> {
  return readRiversideArrays(async (name) => {
    const response = await fetch(`/assets/riverside-ground-v1/${name}`, {
      signal,
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok)
      throw new Error("Riverside素材加载失败；可切回原始基线后重新生成。");
    return readExactAsset(response, 1024 * 1024);
  });
}
export function arraysFromFiles(
  files: Map<string, Uint8Array>,
): Promise<GroundArrays> {
  return readRiversideArrays((name) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error(`Riverside缺少文件：${name}`);
    return bytes;
  });
}
