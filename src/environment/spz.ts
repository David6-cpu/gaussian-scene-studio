import { Gunzip } from "fflate";
export const SOURCE_LIMIT = 64 * 1024 ** 2;
export const POINT_LIMIT = 250000;
const EXPANDED_LIMIT = 32 * 1024 ** 2;
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  return c >>> 0;
});
export function inspectSpz(bytes: Uint8Array) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 28 ||
    bytes.length > SOURCE_LIMIT
  )
    throw Error("SPZ文件为空或超过64MiB。");
  if (bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8)
    throw Error("当前仅支持gzip SPZ v2/v3，未转换文件。");
  const header = new Uint8Array(16);
  let filled = 0,
    total = 0,
    crc = 0xffffffff;
  let info:
    | { version: 2 | 3; count: number; shDegree: number; decodedBytes: number }
    | undefined;
  let expected = 0;
  const decoder = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > EXPANDED_LIMIT) throw Error("SPZ解压超过32MiB。");
    if (filled < 16) {
      const n = Math.min(16 - filled, chunk.length);
      header.set(chunk.subarray(0, n), filled);
      filled += n;
    }
    if (!info && filled === 16) {
      const d = new DataView(header.buffer),
        version = d.getUint32(4, true),
        count = d.getUint32(8, true),
        shDegree = header[12];
      if (
        d.getUint32(0, true) !== 0x5053474e ||
        ![2, 3].includes(version) ||
        count < 1 ||
        count > POINT_LIMIT ||
        shDegree > 3 ||
        header[13] > 24 ||
        header[14] > 1 ||
        header[15] !== 0
      )
        throw Error("SPZ头部、版本或250000点预算无效。");
      expected =
        16 + count * ((version === 2 ? 19 : 20) + [0, 3, 8, 15][shDegree] * 3);
      info = {
        version: version as 2 | 3,
        count,
        shDegree,
        decodedBytes: expected,
      };
    }
    if (info && total > expected) throw Error("SPZ数组长度与声明点数不一致。");
    for (const b of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255];
  });
  // Small input chunks bound transient expansion before our callback runs.
  for (let at = 0; at < bytes.length; at += 512)
    decoder.push(bytes.subarray(at, at + 512), at + 512 >= bytes.length);
  const trailer = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.length - 8,
    8,
  );
  if (
    !info ||
    total !== expected ||
    trailer.getUint32(4, true) !== total ||
    trailer.getUint32(0, true) !== (crc ^ 0xffffffff) >>> 0
  )
    throw Error("SPZ完整性或CRC校验失败。");
  return info;
}
