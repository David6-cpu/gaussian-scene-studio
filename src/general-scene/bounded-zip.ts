import { Inflate } from "fflate";
import { GENERAL_LIMITS } from "./core.ts";

/** Every ceiling may be lowered; values above the application ceiling are clamped. */
export type ZipPolicy = {
  readonly allowedNames: readonly string[] | ReadonlySet<string>;
  readonly maxCompressedBytes?: number;
  readonly maxExpandedBytes?: number;
  readonly maxMemberBytes?: number;
  readonly maxJsonBytes?: number;
  readonly maxFiles?: number;
  readonly maxPeakBytes?: number;
};
type Limits = Record<Exclude<keyof ZipPolicy, "allowedNames">, number>;
type Entry = {
  name: string;
  local: number;
  data: number;
  packed: number;
  unpacked: number;
  method: number;
  crc: number;
};

const INPUT_QUANTUM = 16;
// Live inflater buffers include history, doubling growth, emitted chunks, pending
// stored blocks (<= 64 KiB), and Huffman tables. Reserve 1 MiB beyond the complete
// input + retained output. This bounds owned live buffers, not JS GC/process RSS.
const SCRATCH_BYTES = 1024 * 1024;
const dataName =
  /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.(?:bin|gsbin|f32|u32|json)$/;
function fail(message: string): never {
  throw new Error(`Bounded ZIP: ${message}`);
}
function checkName(name: string): void {
  if (name === "manifest.json" || name === "license.txt") return;
  const match = typeof name === "string" ? dataName.exec(name) : null;
  if (!match || match[1].length > 80) fail("invalid flat member name");
}
function limits(policy: Omit<ZipPolicy, "allowedNames">): Limits {
  const ceilings: Limits = {
    maxCompressedBytes: GENERAL_LIMITS.maxCompressedPackageBytes,
    maxExpandedBytes: GENERAL_LIMITS.maxExpandedPackageBytes,
    maxMemberBytes: GENERAL_LIMITS.maxExpandedPackageBytes,
    maxJsonBytes: GENERAL_LIMITS.maxJsonBytes,
    maxFiles: GENERAL_LIMITS.maxPackageFiles,
    maxPeakBytes: GENERAL_LIMITS.maxCandidateCpuBytes,
  };
  for (const key of Object.keys(ceilings) as (keyof Limits)[]) {
    const supplied = policy[key];
    if (supplied === undefined) continue;
    if (!Number.isSafeInteger(supplied) || supplied < 0)
      fail(`invalid policy limit ${key}`);
    ceilings[key] = Math.min(supplied, ceilings[key]);
  }
  return ceilings;
}
function allowlist(policy: ZipPolicy): Set<string> {
  if (
    !Array.isArray(policy.allowedNames) &&
    !(policy.allowedNames instanceof Set)
  )
    fail("policy allowedNames must be an array or Set");
  const names = new Set<string>();
  for (const name of policy.allowedNames) {
    checkName(name);
    names.add(name);
  }
  return names;
}
function checkMember(name: string, size: number, cap: Limits): void {
  if (name.endsWith(".json") && size > cap.maxJsonBytes)
    fail("JSON member exceeds limit");
  if (size > cap.maxMemberBytes) fail("member expanded size exceeds limit");
}
function checkPeak(input: number, output: number, cap: Limits): void {
  if (input + output + SCRATCH_BYTES > cap.maxPeakBytes)
    fail("peak buffer budget exceeded");
}

/** Preflight owns no payload copies and checks the entire archive before decode. */
function preflight(
  bytes: Uint8Array,
  cap: Limits,
  names?: Set<string>,
): Entry[] {
  if (!(bytes instanceof Uint8Array)) fail("input must be Uint8Array");
  if (bytes.byteLength > cap.maxCompressedBytes)
    fail("compressed input exceeds limit");
  if (bytes.length < 22) fail("missing end record");
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
  if (end < 0) fail("invalid end record");
  const count = v.getUint16(end + 10, true);
  const start = v.getUint32(end + 16, true);
  const size = v.getUint32(end + 12, true);
  if (count === 0xffff || start === 0xffffffff || size === 0xffffffff)
    fail("ZIP64 unsupported");
  if (count > cap.maxFiles) fail("file count exceeds limit");
  if (
    v.getUint16(end + 4, true) ||
    v.getUint16(end + 6, true) ||
    count !== v.getUint16(end + 8, true)
  )
    fail("split disk unsupported");
  if (start + size !== end) fail("invalid central directory extent");

  const readName = (offset: number, length: number): string => {
    if (length < 1 || length > 100 || offset + length > bytes.length)
      return fail("invalid member name length");
    // The whitelist is ASCII, so no alternate UTF8/CP437 spellings can alias.
    let name = "";
    for (let i = offset; i < offset + length; i++) {
      if (bytes[i] > 127) fail("invalid member name encoding");
      name += String.fromCharCode(bytes[i]);
    }
    checkName(name);
    return name;
  };
  const checkExtra = (offset: number, length: number): void => {
    const until = offset + length;
    while (offset < until) {
      if (offset + 4 > until) fail("malformed extra record");
      const id = v.getUint16(offset, true);
      const n = v.getUint16(offset + 2, true);
      if (id === 1) fail("ZIP64 unsupported");
      // Unicode path and strong-encryption extras carry alternate semantics.
      if (id === 0x7075 || id === 0x0017 || id === 0x9901)
        fail("unsupported extra record");
      offset += 4 + n;
      if (offset > until) fail("malformed extra record");
    }
  };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let cursor = start;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || v.getUint32(cursor, true) !== 0x02014b50)
      fail("invalid central record");
    const version = v.getUint16(cursor + 6, true);
    const flags = v.getUint16(cursor + 8, true);
    const method = v.getUint16(cursor + 10, true);
    const crc = v.getUint32(cursor + 16, true);
    const packed = v.getUint32(cursor + 20, true);
    const unpacked = v.getUint32(cursor + 24, true);
    const n = v.getUint16(cursor + 28, true);
    const extra = v.getUint16(cursor + 30, true);
    const comment = v.getUint16(cursor + 32, true);
    const attributes = v.getUint32(cursor + 38, true);
    const mode = (attributes >>> 16) & 0xf000;
    const local = v.getUint32(cursor + 42, true);
    if (
      packed === 0xffffffff ||
      unpacked === 0xffffffff ||
      local === 0xffffffff
    )
      fail("ZIP64 unsupported");
    if (version > 20) fail("unsupported ZIP version");
    // Data descriptors, encryption and compression-option flags are unsupported.
    if (flags & ~0x800) fail("unsupported or encrypted flags");
    if (method !== 0 && method !== 8) fail("unsupported compression method");
    if ((mode !== 0 && mode !== 0x8000) || attributes & 0x18)
      fail("only regular-file attributes allowed");
    if (v.getUint16(cursor + 34, true)) fail("split disk unsupported");
    if (cursor + 46 + n + extra + comment > end)
      fail("central record out of range");
    const name = readName(cursor + 46, n);
    if (seen.has(name)) fail("duplicate member name");
    seen.add(name);
    if (names && !names.has(name))
      fail("undeclared member outside allowed names");
    checkMember(name, unpacked, cap);
    total += unpacked;
    if (total > cap.maxExpandedBytes) fail("total expanded size exceeds limit");
    if ((method === 0 && packed !== unpacked) || (method === 8 && packed < 2))
      fail("invalid compressed/expanded size");
    checkExtra(cursor + 46 + n, extra);
    if (local + 30 > start || v.getUint32(local, true) !== 0x04034b50)
      fail("invalid local record range");
    if (
      v.getUint16(local + 4, true) !== version ||
      v.getUint16(local + 6, true) !== flags ||
      v.getUint16(local + 8, true) !== method ||
      v.getUint32(local + 14, true) !== crc ||
      v.getUint32(local + 18, true) !== packed ||
      v.getUint32(local + 22, true) !== unpacked
    )
      fail("local/central record mismatch");
    const ln = v.getUint16(local + 26, true);
    const le = v.getUint16(local + 28, true);
    const data = local + 30 + ln + le;
    if (
      data > start ||
      data + packed > start ||
      readName(local + 30, ln) !== name
    )
      fail("local name or payload range mismatch");
    checkExtra(local + 30 + ln, le);
    entries.push({ name, local, data, packed, unpacked, method, crc });
    cursor += 46 + n + extra + comment;
  }
  if (cursor !== end) fail("central directory count mismatch");
  let next = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== next)
      fail("overlapping, hidden or gapped local ranges");
    next = entry.data + entry.packed;
  }
  if (next !== start) fail("hidden local payload or gap");
  checkPeak(bytes.length, total, cap);
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crcUpdate(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return crc;
}

/**
 * fflate does not validate LEN/NLEN or report bytes consumed / true stream EOF.
 * Walk framing and Huffman tokens without allocating output to reject malformed
 * streams and trailing compressed bytes before allocating/feeding the inflater.
 * The scanner has its own frozen expansion ceiling; exact declared/per-policy
 * lengths are independently enforced on the actual emitted chunks below.
 */
function validateDeflate(bytes: Uint8Array): void {
  let bit = 0;
  let produced = 0;
  const take = (n: number): number => {
    if (bit + n > bytes.length * 8) return fail("truncated deflate stream");
    let value = 0;
    for (let i = 0; i < n; i++, bit++)
      value |= ((bytes[bit >>> 3] >>> (bit & 7)) & 1) << i;
    return value;
  };
  type Tree = { codes: Map<number, number>; max: number };
  const tree = (lengths: number[], complete: boolean): Tree => {
    const counts = new Uint16Array(16);
    let max = 0;
    for (const n of lengths) {
      if (n < 0 || n > 15) fail("invalid deflate code length");
      if (n) {
        counts[n]++;
        max = Math.max(max, n);
      }
    }
    let left = 1;
    for (let n = 1; n <= 15; n++) {
      left = (left << 1) - counts[n];
      if (left < 0) fail("oversubscribed deflate tree");
    }
    if (left && (complete || max > 1)) fail("incomplete deflate tree");
    const next = new Uint16Array(16);
    let code = 0;
    for (let n = 1; n <= 15; n++) {
      code = (code + counts[n - 1]) << 1;
      next[n] = code;
    }
    const codes = new Map<number, number>();
    lengths.forEach((n, symbol) => {
      if (!n) return;
      const canonical = next[n]++;
      let reversed = 0;
      for (let j = 0; j < n; j++)
        reversed = (reversed << 1) | ((canonical >>> j) & 1);
      codes.set((1 << n) | reversed, symbol);
    });
    return { codes, max };
  };
  const decode = (t: Tree): number => {
    let value = 0;
    for (let n = 1; n <= t.max; n++) {
      value |= take(1) << (n - 1);
      const symbol = t.codes.get((1 << n) | value);
      if (symbol !== undefined) return symbol;
    }
    return fail("invalid deflate symbol");
  };
  const lengthBase = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
    83, 99, 115, 131, 163, 195, 227, 258,
  ];
  const lengthExtra = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
    5, 5, 5, 0,
  ];
  const distanceBase = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ];
  const distanceExtra = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
    11, 11, 12, 12, 13, 13,
  ];
  let fixedLiterals: Tree | undefined;
  let fixedDistances: Tree | undefined;
  let final = 0;
  while (!final) {
    final = take(1);
    const type = take(2);
    if (type === 0) {
      bit = Math.ceil(bit / 8) * 8;
      const n = take(16);
      if ((n ^ take(16)) !== 0xffff)
        fail("invalid deflate stored length complement");
      if (bit + n * 8 > bytes.length * 8)
        fail("truncated stored deflate block");
      bit += n * 8;
      produced += n;
    } else if (type === 1 || type === 2) {
      let literals: Tree;
      let distances: Tree;
      if (type === 1) {
        literals = fixedLiterals ??= tree(
          Array.from({ length: 288 }, (_, n) =>
            n < 144 ? 8 : n < 256 ? 9 : n < 280 ? 7 : 8,
          ),
          true,
        );
        distances = fixedDistances ??= tree(
          new Array<number>(32).fill(5),
          true,
        );
      } else {
        const literalCount = take(5) + 257;
        const distanceCount = take(5) + 1;
        const codeCount = take(4) + 4;
        if (literalCount > 286) fail("reserved deflate tree count");
        // RFC 1951 code-length alphabet order (explicit to avoid semantic aliases).
        const codeOrder = [
          16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
        ];
        const codeLengths = new Array<number>(19).fill(0);
        for (let i = 0; i < codeCount; i++) codeLengths[codeOrder[i]] = take(3);
        const codeTree = tree(codeLengths, true);
        const lengths: number[] = [];
        while (lengths.length < literalCount + distanceCount) {
          const symbol = decode(codeTree);
          if (symbol <= 15) lengths.push(symbol);
          else {
            if (symbol === 16 && lengths.length === 0)
              fail("invalid deflate length repeat");
            const repeat =
              symbol === 16
                ? take(2) + 3
                : symbol === 17
                  ? take(3) + 3
                  : take(7) + 11;
            const value = symbol === 16 ? lengths[lengths.length - 1] : 0;
            if (lengths.length + repeat > literalCount + distanceCount)
              fail("deflate length repeat overflow");
            for (let i = 0; i < repeat; i++) lengths.push(value);
          }
        }
        if (!lengths[256]) fail("missing deflate end-of-block symbol");
        literals = tree(lengths.slice(0, literalCount), false);
        distances = tree(lengths.slice(literalCount), false);
      }
      for (;;) {
        const symbol = decode(literals);
        if (symbol === 256) break;
        if (symbol < 256) produced++;
        else {
          if (symbol > 285) fail("reserved deflate length symbol");
          const index = symbol - 257;
          const length = lengthBase[index] + take(lengthExtra[index]);
          const distanceSymbol = decode(distances);
          if (distanceSymbol > 29) fail("reserved deflate distance symbol");
          const distance =
            distanceBase[distanceSymbol] + take(distanceExtra[distanceSymbol]);
          if (distance > produced) fail("deflate distance precedes output");
          produced += length;
        }
        if (produced > GENERAL_LIMITS.maxExpandedPackageBytes)
          fail("deflate actual size exceeds expanded limit");
      }
    } else fail("reserved deflate block type");
    if (produced > GENERAL_LIMITS.maxExpandedPackageBytes)
      fail("deflate actual size exceeds expanded limit");
  }
  if (Math.ceil(bit / 8) !== bytes.length)
    fail("trailing bytes after deflate stream");
}

function decodeEntry(
  bytes: Uint8Array,
  entry: Entry,
  cap: Limits,
  actual: { total: number },
): Uint8Array {
  const packed = bytes.subarray(entry.data, entry.data + entry.packed);
  if (entry.method === 8) validateDeflate(packed);
  const output = new Uint8Array(entry.unpacked);
  let written = 0;
  let crc = -1;
  const receive = (chunk: Uint8Array): void => {
    if (chunk.length > entry.unpacked - written)
      fail("actual output exceeds declared size");
    if (actual.total + chunk.length > cap.maxExpandedBytes)
      fail("actual expanded total exceeds limit");
    checkMember(entry.name, written + chunk.length, cap);
    output.set(chunk, written);
    written += chunk.length;
    actual.total += chunk.length;
    crc = crcUpdate(crc, chunk);
  };
  if (entry.method === 0) {
    for (let offset = 0; offset < packed.length; offset += 65536)
      receive(packed.subarray(offset, Math.min(packed.length, offset + 65536)));
  } else {
    const decoder = new Inflate(receive);
    for (let offset = 0; offset < packed.length; offset += INPUT_QUANTUM) {
      const finish = Math.min(packed.length, offset + INPUT_QUANTUM);
      // Exceptions escape immediately; no subsequent push/member is started.
      decoder.push(packed.subarray(offset, finish), finish === packed.length);
    }
  }
  if (written !== entry.unpacked)
    fail("actual output length differs from declared size");
  if ((crc ^ -1) >>> 0 !== entry.crc) fail("CRC32 mismatch");
  return output;
}

/** Synchronous offline/worker API; this function does not promise UI cancellation. */
export function readBoundedZip(
  bytes: Uint8Array,
  policy: ZipPolicy,
): Map<string, Uint8Array> {
  const cap = limits(policy);
  const entries = preflight(bytes, cap, allowlist(policy));
  const result = new Map<string, Uint8Array>();
  const actual = { total: 0 };
  for (const entry of entries)
    result.set(entry.name, decodeEntry(bytes, entry, cap, actual));
  return result;
}

/** Inspect only the manifest; the caller must then supply its exact member list. */
export function readBoundedZipManifest(bytes: Uint8Array): Uint8Array {
  const cap = limits({});
  const entries = preflight(bytes, cap);
  const manifest = entries.find((entry) => entry.name === "manifest.json");
  if (!manifest) fail("missing manifest.json");
  return decodeEntry(bytes, manifest, cap, { total: 0 });
}

/** Deterministic ZIP32 stored writer: validates everything before one allocation. */
export function writeBoundedZip(
  files: Map<string, Uint8Array>,
  policy: ZipPolicy,
): Uint8Array {
  const cap = limits(policy);
  const names = allowlist(policy);
  if (!(files instanceof Map)) fail("files must be a Map");
  if (files.size > cap.maxFiles) fail("file count exceeds limit");
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let expanded = 0;
  let size = 22;
  for (const [name, data] of entries) {
    checkName(name);
    if (!names.has(name)) fail("undeclared member outside allowed names");
    if (!(data instanceof Uint8Array)) fail("member must be Uint8Array");
    checkMember(name, data.length, cap);
    expanded += data.length;
    size += 76 + 2 * name.length + data.length;
  }
  if (expanded > cap.maxExpandedBytes)
    fail("total expanded size exceeds limit");
  if (size > cap.maxCompressedBytes) fail("compressed output exceeds limit");
  checkPeak(expanded, size, cap);
  const output = new Uint8Array(size);
  const v = new DataView(output.buffer);
  const encoded = entries.map(([name, data]) => ({
    name: new TextEncoder().encode(name),
    data,
    crc: (crcUpdate(-1, data) ^ -1) >>> 0,
    local: 0,
  }));
  let offset = 0;
  for (const entry of encoded) {
    entry.local = offset;
    v.setUint32(offset, 0x04034b50, true);
    v.setUint16(offset + 4, 20, true);
    v.setUint16(offset + 6, 0x800, true);
    v.setUint32(offset + 14, entry.crc, true);
    v.setUint32(offset + 18, entry.data.length, true);
    v.setUint32(offset + 22, entry.data.length, true);
    v.setUint16(offset + 26, entry.name.length, true);
    output.set(entry.name, offset + 30);
    output.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const start = offset;
  for (const entry of encoded) {
    v.setUint32(offset, 0x02014b50, true);
    v.setUint16(offset + 4, 20, true);
    v.setUint16(offset + 6, 20, true);
    v.setUint16(offset + 8, 0x800, true);
    v.setUint32(offset + 16, entry.crc, true);
    v.setUint32(offset + 20, entry.data.length, true);
    v.setUint32(offset + 24, entry.data.length, true);
    v.setUint16(offset + 28, entry.name.length, true);
    v.setUint32(offset + 42, entry.local, true);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  v.setUint32(offset, 0x06054b50, true);
  v.setUint16(offset + 8, encoded.length, true);
  v.setUint16(offset + 10, encoded.length, true);
  v.setUint32(offset + 12, offset - start, true);
  v.setUint32(offset + 16, start, true);
  return output;
}
