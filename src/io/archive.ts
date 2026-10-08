import { zipSync, unzipSync } from "fflate";
const LIMIT = 64 * 1024 * 1024;
const allowed = /^(manifest\.json|[a-z0-9-]+\.(gsbin|f32|u32))$/;
/** Validate ZIP32 records and total expansion before fflate allocates members. */
export function preflightStoredZip(bytes: Uint8Array): void {
  const fail = () => {
    throw new Error("Invalid or over-budget stored ZIP");
  };
  if (bytes.byteLength > LIMIT || bytes.byteLength < 22) fail();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (
      v.getUint32(p, true) === 0x06054b50 &&
      p + 22 + v.getUint16(p + 20, true) === bytes.length
    ) {
      end = p;
      break;
    }
  }
  if (end < 0) fail();
  const count = v.getUint16(end + 10, true),
    start = v.getUint32(end + 16, true),
    size = v.getUint32(end + 12, true);
  if (
    v.getUint16(end + 4, true) ||
    v.getUint16(end + 6, true) ||
    count !== v.getUint16(end + 8, true) ||
    count < 1 ||
    count > 14 ||
    start + size !== end
  )
    fail();
  let cursor = start,
    total = 0;
  const names = new Set<string>(),
    ranges: [number, number][] = [];
  const nameAt = (offset: number, length: number) => {
    if (offset + length > bytes.length || length < 1 || length > 255)
      return fail();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset, offset + length),
    );
    if (!allowed.test(name)) fail();
    return name;
  };
  const checkExtra = (offset: number, length: number) => {
    const until = offset + length;
    while (offset < until) {
      if (offset + 4 > until) fail();
      const id = v.getUint16(offset, true),
        n = v.getUint16(offset + 2, true);
      if (id === 1 || offset + 4 + n > until) fail(); // ZIP64 unsupported.
      offset += 4 + n;
    }
  };
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || v.getUint32(cursor, true) !== 0x02014b50) fail();
    const flags = v.getUint16(cursor + 8, true),
      method = v.getUint16(cursor + 10, true),
      crc = v.getUint32(cursor + 16, true);
    const packed = v.getUint32(cursor + 20, true),
      unpacked = v.getUint32(cursor + 24, true),
      n = v.getUint16(cursor + 28, true),
      extra = v.getUint16(cursor + 30, true),
      comment = v.getUint16(cursor + 32, true),
      local = v.getUint32(cursor + 42, true);
    const mode = (v.getUint32(cursor + 38, true) >>> 16) & 0xf000;
    if (
      method !== 0 ||
      flags & ~0x808 ||
      packed !== unpacked ||
      unpacked > LIMIT ||
      v.getUint16(cursor + 34, true) ||
      (mode !== 0 && mode !== 0x8000) ||
      cursor + 46 + n + extra + comment > end
    )
      fail();
    const name = nameAt(cursor + 46, n);
    if (names.has(name) || (name === "manifest.json" && unpacked > 1048576))
      fail();
    names.add(name);
    total += unpacked;
    if (total > LIMIT) fail();
    checkExtra(cursor + 46 + n, extra);
    if (
      local + 30 > start ||
      v.getUint32(local, true) !== 0x04034b50 ||
      v.getUint16(local + 6, true) !== flags ||
      v.getUint16(local + 8, true) !== method
    )
      fail();
    const ln = v.getUint16(local + 26, true),
      le = v.getUint16(local + 28, true),
      data = local + 30 + ln + le;
    if (
      data > start ||
      nameAt(local + 30, ln) !== name ||
      data + packed > start
    )
      fail();
    checkExtra(local + 30 + ln, le);
    let finish = data + packed;
    if (flags & 8) {
      if (finish + 12 > start) fail();
      if (v.getUint32(finish, true) === 0x08074b50) finish += 4;
      if (
        finish + 12 > start ||
        v.getUint32(finish, true) !== crc ||
        v.getUint32(finish + 4, true) !== packed ||
        v.getUint32(finish + 8, true) !== unpacked
      )
        fail();
      finish += 12;
    } else if (
      v.getUint32(local + 14, true) !== crc ||
      v.getUint32(local + 18, true) !== packed ||
      v.getUint32(local + 22, true) !== unpacked
    )
      fail();
    ranges.push([local, finish]);
    cursor += 46 + n + extra + comment;
  }
  if (cursor !== end || !names.has("manifest.json")) fail();
  ranges.sort((a, b) => a[0] - b[0]);
  // Our archives contain only the listed local records, with no hidden payloads.
  let offset = 0;
  for (const [a, b] of ranges) {
    if (a !== offset) fail();
    offset = b;
  }
  if (offset !== start) fail();
}
export function packBundle(b: {
  manifest: string;
  files: Map<string, Uint8Array>;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(b.manifest),
  };
  for (const [name, data] of b.files) files[name] = data;
  return zipSync(files, { level: 0 });
}
export function unpackBundle(bytes: Uint8Array): {
  manifest: string;
  files: Map<string, Uint8Array>;
} {
  preflightStoredZip(bytes);
  if (bytes.byteLength > LIMIT) throw new Error("场景包超过64MiB");
  let total = 0;
  const names = new Set<string>();
  const data = unzipSync(bytes, {
    filter: (file) => {
      if (
        file.compression !== 0 ||
        !Number.isSafeInteger(file.originalSize) ||
        file.originalSize! > LIMIT
      )
        throw new Error("仅支持F0未压缩场景包");
      if (
        !/^(manifest\.json|[a-z0-9-]+\.(gsbin|f32|u32))$/.test(file.name) ||
        names.has(file.name)
      )
        throw new Error("非法或重复文件名");
      names.add(file.name);
      total += file.originalSize!;
      if (
        total > LIMIT ||
        names.size > 14 ||
        (file.name === "manifest.json" && file.originalSize! > 1024 * 1024)
      )
        throw new Error("场景包超过限制");
      return true;
    },
  });
  const manifest = data["manifest.json"];
  if (!manifest) throw new Error("缺少manifest.json");
  delete data["manifest.json"];
  return {
    manifest: new TextDecoder("utf-8", { fatal: true }).decode(manifest),
    files: new Map(Object.entries(data)),
  };
}
