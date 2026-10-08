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
export function createEnvironmentStore() {
  return {
    async list(): Promise<EnvironmentRecord[]> {
      const db = await open();
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly"),
          request = tx.objectStore(STORE).getAll();
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? Error("环境库读取失败。"));
        };
      });
      if (values.length > 8) throw Error("环境库超过8条限制，未读取异常记录。");
      const records: EnvironmentRecord[] = [];
      for (const value of values) records.push(await validateRecord(value));
      if (records.reduce((n, r) => n + r.asset.spz.length, 0) > 128 * 1024 ** 2)
        throw Error("环境库存储超限。");
      return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    async save(value: EnvironmentRecord): Promise<{ duplicate: boolean }> {
      const record = await validateRecord(value),
        db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite"),
          store = tx.objectStore(STORE);
        const request = store.getAll();
        let duplicate = false,
          error: unknown;
        request.onsuccess = () => {
          try {
            const records = request.result as EnvironmentRecord[];
            const existing = records.find(
              (r) => r.asset?.id === record.asset.id,
            );
            if (existing) {
              objectRecord(existing, ["asset", "camera", "savedAt"]);
              const { spz: storedBytes, ...storedMetadata } = existing.asset;
              const { spz: validBytes, ...validMetadata } = record.asset;
              if (
                !(storedBytes instanceof Uint8Array) ||
                storedBytes.length !== validBytes.length ||
                storedBytes.some((n, i) => n !== validBytes[i]) ||
                canonicalJson(storedMetadata) !== canonicalJson(validMetadata)
              )
                throw Error("同版环境记录已损坏，未覆盖或伪报保存成功。");
              parseCamera(existing.camera);
              if (
                typeof existing.savedAt !== "string" ||
                new Date(existing.savedAt).toISOString() !== existing.savedAt
              )
                throw Error("已有环境保存时间损坏。");
              duplicate = true;
              return;
            }
            const total = records.reduce((n, r) => {
              if (!(r.asset?.spz instanceof Uint8Array))
                throw Error("已有环境记录损坏，未覆盖。");
              return n + r.asset.spz.length;
            }, record.asset.spz.length);
            if (records.length >= 8 || total > 128 * 1024 ** 2)
              throw Error("本机环境库已达8条或128MiB上限，请下载备份。");
            store.add(record);
          } catch (e) {
            error = e;
            tx.abort();
          }
        };
        tx.oncomplete = () => {
          db.close();
          resolve({ duplicate });
        };
        tx.onabort = () => {
          db.close();
          reject(error ?? tx.error ?? Error("环境未保存，请重试或下载备份。"));
        };
      });
    },
  };
}
