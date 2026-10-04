import { zipSync, unzipSync } from "fflate";
const LIMIT = 64 * 1024 * 1024;
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
