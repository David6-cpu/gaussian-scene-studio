import { validateRecord, parseCamera, type EnvironmentRecord } from "./asset";
import { canonicalJson } from "../io/prepared-ground";
import { record as objectRecord } from "../data-validation";
const NAME = "wetland-environments-v1",
  STORE = "records";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore(STORE, { keyPath: "asset.id" });
    r.onerror = () => reject(r.error ?? Error("本机环境库不可用。"));
    r.onblocked = () =>
      reject(Error("环境库升级被其他标签页阻挡，请关闭旧标签页后重试。"));
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
// Four optional strings per record are bounded to 8192 code units; all others
// are short. Covers eight metadata copies and the current JSON/hash workspace.
export const ENVIRONMENT_METADATA_BYTES = 2 * 1024 ** 2;
export interface EnvironmentReadContext {
  reserve(additionalBytes: number): void;
  retain(buffer: ArrayBuffer): void;
  release(buffer: ArrayBuffer): void;
}
export function createEnvironmentStore() {
  return {
    async list(context?: EnvironmentReadContext): Promise<EnvironmentRecord[]> {
      const db = await open();
      const records: EnvironmentRecord[] = [],
        retained = new Set<ArrayBuffer>();
      let bytes = 0;
      const retain = (buffer: ArrayBuffer) => {
        retained.add(buffer);
        context?.retain(buffer);
      };
      const release = (buffer: ArrayBuffer) => {
        retained.delete(buffer);
        context?.release(buffer);
      };
      const reserve = (additionalBytes: number) => {
        if (
          [...retained].reduce((n, b) => n + b.byteLength, additionalBytes) >
          256 * 1024 ** 2
        )
          throw Error("环境库读取缓冲超过256MiB预算。");
        context?.reserve(additionalBytes);
      };
      function read<T>(request: (store: IDBObjectStore) => IDBRequest<T>) {
        return new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly"),
            result = request(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(result.result);
          tx.onabort = () => reject(tx.error ?? Error("本机环境库读取失败。"));
        });
      }
      try {
        if ((await read((s) => s.count())) > 8)
          throw Error("环境库超过8条限制，未读取异常记录。");
        const keys = await read((s) => s.getAllKeys(undefined, 9));
        if (keys.length > 8) throw Error("环境库超过8条限制，未读取异常记录。");
        for (const key of keys) {
          // Native IDB has no byte-limited get. Reserve the legal maximum first;
          // reject malformed/deserialized oversized values before any app clone/decode.
          reserve(64 * 1024 ** 2 + ENVIRONMENT_METADATA_BYTES);
          let value: unknown = await read((s) => s.get(key));
          const r = objectRecord(value, ["asset", "camera", "savedAt"]);
          if (!r.asset || typeof r.asset !== "object" || Array.isArray(r.asset))
            throw Error("环境记录结构无效。");
          const spz = (r.asset as { spz?: unknown }).spz;
          if (
            !(spz instanceof Uint8Array) ||
            !(spz.buffer instanceof ArrayBuffer) ||
            spz.byteLength > 64 * 1024 ** 2 ||
            spz.buffer.byteLength > 64 * 1024 ** 2 ||
            bytes + spz.buffer.byteLength > 128 * 1024 ** 2
          )
            throw Error("环境库存储或实际缓冲背板超限。");
          const raw = spz.buffer;
          retain(raw);
          try {
            reserve(
              raw.byteLength + 32 * 1024 ** 2 + ENVIRONMENT_METADATA_BYTES,
            );
            const record = await validateRecord(value);
            const buffer = record.asset.spz.buffer as ArrayBuffer;
            if (bytes + buffer.byteLength > 128 * 1024 ** 2)
              throw Error("环境库存储缓冲超限。");
            retain(buffer);
            records.push(record);
            bytes += buffer.byteLength;
          } finally {
            value = undefined;
            release(raw);
          }
        }
        return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      } catch (error) {
        for (const buffer of [...retained]) release(buffer);
        throw error;
      } finally {
        db.close();
      }
    },
    async save(
      value: EnvironmentRecord,
      context?: EnvironmentReadContext,
    ): Promise<{ duplicate: boolean }> {
      // Validate backing bounds before validateRecord can structuredClone it.
      const backing = (value: unknown): ArrayBuffer => {
        const record = objectRecord(value, ["asset", "camera", "savedAt"]);
        const asset = record.asset;
        if (!asset || typeof asset !== "object" || Array.isArray(asset))
          throw Error("环境记录结构无效。");
        const bytes = (asset as { spz?: unknown }).spz;
        if (
          !(bytes instanceof Uint8Array) ||
          !(bytes.buffer instanceof ArrayBuffer) ||
          bytes.buffer.byteLength > 64 * 1024 ** 2
        )
          throw Error("环境库存储或实际缓冲背板超限。");
        return bytes.buffer;
      };
      const input = backing(value),
        retained = new Set<ArrayBuffer>();
      const retain = (buffer: ArrayBuffer) => {
        retained.add(buffer);
        context?.retain(buffer);
      };
      const release = (buffer: ArrayBuffer) => {
        retained.delete(buffer);
        context?.release(buffer);
      };
      const reserve = (additional: number) => {
        const buffers = new Set([input, ...retained]);
        if (
          [...buffers].reduce((n, b) => n + b.byteLength, additional) >
          256 * 1024 ** 2
        )
          throw Error("环境保存缓冲超过256MiB预算。");
        context?.reserve(additional);
      };
      let db: IDBDatabase | undefined;
      try {
        reserve(input.byteLength + 32 * 1024 ** 2 + ENVIRONMENT_METADATA_BYTES);
        const record = await validateRecord(value),
          validBuffer = backing(record);
        retain(validBuffer);
        db = await open();
        return await new Promise((resolve, reject) => {
          // Keep count/cursor/duplicate/add in the original write transaction;
          // oncomplete remains the only successful save linearization point.
          const tx = db!.transaction(STORE, "readwrite"),
            store = tx.objectStore(STORE);
          let duplicate = false,
            error: unknown,
            total = 0,
            count = 0;
          let previous: ArrayBuffer | undefined;
          const abort = (reason: unknown) => {
            error = reason;
            tx.abort();
          };
          const finish = () => {
            if (duplicate) return;
            if (count >= 8 || total + validBuffer.byteLength > 128 * 1024 ** 2)
              throw Error("本机环境库已达8条或128MiB上限，请下载备份。");
            reserve(validBuffer.byteLength + ENVIRONMENT_METADATA_BYTES);
            store.add(record);
          };
          const size = store.count();
          size.onsuccess = () => {
            try {
              if (size.result > 8)
                throw Error("环境库超过8条限制，未读取异常记录。");
              if (!size.result) {
                finish();
                return;
              }
              reserve(64 * 1024 ** 2 + ENVIRONMENT_METADATA_BYTES);
              const request = store.openCursor();
              request.onsuccess = () => {
                try {
                  // The prior request.result has now been replaced; until this
                  // callback it remained a real root while the next row loaded.
                  if (previous) {
                    release(previous);
                    previous = undefined;
                  }
                  const cursor = request.result;
                  if (!cursor) {
                    finish();
                    return;
                  }
                  const existing = cursor.value as EnvironmentRecord;
                  previous = backing(existing);
                  retain(previous);
                  total += previous.byteLength;
                  count++;
                  if (count > 8 || total > 128 * 1024 ** 2)
                    throw Error("环境库已有记录实际缓冲超过8条或128MiB上限。");
                  if (existing.asset.id === record.asset.id) {
                    const { spz: storedBytes, ...storedMetadata } =
                      existing.asset;
                    const { spz: validBytes, ...validMetadata } = record.asset;
                    if (
                      storedBytes.length !== validBytes.length ||
                      storedBytes.some((n, i) => n !== validBytes[i]) ||
                      canonicalJson(storedMetadata) !==
                        canonicalJson(validMetadata)
                    )
                      throw Error("同版环境记录已损坏，未覆盖或伪报保存成功。");
                    parseCamera(existing.camera);
                    if (
                      typeof existing.savedAt !== "string" ||
                      new Date(existing.savedAt).toISOString() !==
                        existing.savedAt
                    )
                      throw Error("已有环境保存时间损坏。");
                    duplicate = true;
                  }
                  reserve(64 * 1024 ** 2 + ENVIRONMENT_METADATA_BYTES);
                  cursor.continue();
                } catch (reason) {
                  abort(reason);
                }
              };
            } catch (reason) {
              abort(reason);
            }
          };
          tx.oncomplete = () => resolve({ duplicate });
          tx.onabort = () =>
            reject(
              error ?? tx.error ?? Error("环境未保存，请重试或下载备份。"),
            );
        });
      } finally {
        for (const buffer of [...retained]) release(buffer);
        db?.close();
      }
    },
  };
}
