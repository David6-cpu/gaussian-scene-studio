import { integer, record } from "../data-validation";
import { sha256 } from "../io/hash";
import { canonicalJson } from "./canonical";
import { GENERAL_LIMITS as L } from "./core";
import type { SceneSnapshot } from "./contracts";
import {
  makeAssetLibrary,
  verifyCatalogView,
  type AssetLibrary,
  type CatalogView,
} from "./asset-library";
import {
  captureIO,
  retainIO,
  checkIO,
  jsonBytes,
  prepareScene,
  parseDocument,
  restoreDocument,
  validateCatalog,
  memberReferences,
  metadataWorkspace,
  type IOContext,
  type SceneIOContext,
  type SnapshotDocument,
  type MemberReference,
} from "./archive";

export type StageRef = {
  sceneId: string;
  revisionId: string;
  operationId: string;
};
export type CommitReceipt = StageRef & { duplicate: boolean };
export type SceneSummary = {
  sceneId: string;
  currentRevisionId: string;
  reviewStatus: "draft" | "accepted";
};
export type SceneStore = ReturnType<typeof createSceneStore>;
const NAME = "gaussian-general-scenes",
  STORES = ["scenes", "revisions", "blobs", "manifests", "operations"],
  WORKSPACE = 16 * 1024 ** 2;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const opKey = (sceneId: string, operationId: string) =>
  canonicalJson([sceneId, operationId]);
const validId = (s: unknown): string => {
  if (
    typeof s !== "string" ||
    !s ||
    s.length > 200 ||
    /[\x00-\x1f\x7f]/.test(s)
  )
    throw Error("Invalid scene identity");
  return s;
};
const validHash = (s: unknown): string => {
  if (typeof s !== "string" || !/^[0-9a-f]{64}$/.test(s))
    throw Error("Invalid stored digest");
  return s;
};
function stageRef(value: StageRef): StageRef {
  const r = record(value, ["sceneId", "revisionId", "operationId"]);
  return {
    sceneId: validId(r.sceneId),
    revisionId: validId(r.revisionId),
    operationId: validId(r.operationId),
  };
}
type Revision = StageRef & {
  status: "staging" | "committed";
  parentRevisionId: string | null;
  reviewStatus: "draft" | "accepted";
  catalogDigest: string | null;
  descriptor: Blob;
  descriptorDigest: string;
  resultBytes: number;
  blobRefs: { hash: string; bytes: number }[];
};
type BlobRecord = { hash: string; size: number; data: Blob; token: string };
type CatalogRecord = { digest: string; data: Blob };
type Descriptor = { document: SnapshotDocument; members: MemberReference[] };
function revision(value: unknown): Revision {
  const r = record(value, [
    "sceneId",
    "revisionId",
    "operationId",
    "status",
    "parentRevisionId",
    "reviewStatus",
    "catalogDigest",
    "descriptor",
    "descriptorDigest",
    "resultBytes",
    "blobRefs",
  ]);
  validId(r.sceneId);
  validId(r.revisionId);
  validId(r.operationId);
  if (r.parentRevisionId !== null) validId(r.parentRevisionId);
  if (r.status !== "staging" && r.status !== "committed")
    throw Error("Invalid revision status");
  if (r.reviewStatus !== "draft" && r.reviewStatus !== "accepted")
    throw Error("Invalid saved review status");
  if (r.catalogDigest !== null) validHash(r.catalogDigest);
  validHash(r.descriptorDigest);
  if (
    !(r.descriptor instanceof Blob) ||
    r.descriptor.size > L.maxJsonBytes ||
    !r.descriptor.size
  )
    throw Error("Stored descriptor limit");
  integer(r.resultBytes, 1, L.maxCandidateCpuBytes);
  if (!Array.isArray(r.blobRefs) || r.blobRefs.length > 30000)
    throw Error("Stored blob references limit");
  const seen = new Set<string>();
  let total = 0;
  for (const item of r.blobRefs) {
    const b = record(item, ["hash", "bytes"]);
    validHash(b.hash);
    integer(b.bytes, 1, L.maxExpandedPackageBytes);
    if (seen.has(b.hash as string))
      throw Error("Duplicate stored blob reference");
    seen.add(b.hash as string);
    total += b.bytes as number;
  }
  if (total > L.maxCandidateCpuBytes) throw Error("Stored revision blob limit");
  return r as Revision;
}
function blobRecord(value: unknown, hash: string, size?: number): BlobRecord {
  const r = record(value, ["hash", "size", "data", "token"]);
  if (r.hash !== hash) throw Error("Stored blob key mismatch");
  validHash(hash);
  validId(r.token);
  const n = integer(r.size, 1, L.maxLocalBlobBytes);
  if (
    !(r.data instanceof Blob) ||
    r.data.size !== n ||
    (size !== undefined && n !== size)
  )
    throw Error("Stored blob size mismatch");
  return r as BlobRecord;
}
function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      reject(e);
    };
    const cancel = () =>
      fail(signal!.reason ?? new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", cancel, { once: true });
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("scenes", { keyPath: "sceneId" });
      db.createObjectStore("revisions", { keyPath: "revisionId" });
      db.createObjectStore("blobs", { keyPath: "hash" });
      db.createObjectStore("manifests", { keyPath: "digest" });
      db.createObjectStore("operations", { keyPath: "key" });
    };
    request.onerror = () => fail(request.error ?? Error("本机场景库不可用"));
    request.onblocked = () =>
      fail(Error("场景库升级被其他标签页阻挡，请关闭旧连接后重试。"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", cancel);
      resolve(db);
    };
  });
}
/** No asynchronous hash/source work runs inside this transaction. Only IDB requests keep it live. */
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  signal: AbortSignal | undefined,
  run: (
    tx: IDBTransaction,
    done: (value: T) => void,
    fail: (e: unknown) => void,
  ) => void,
): Promise<T> {
  const db = await openDatabase(signal);
  if (signal?.aborted) {
    db.close();
    signal.throwIfAborted();
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T, error: unknown;
    const fail = (e: unknown) => {
      error ??= e;
      try {
        tx.abort();
      } catch {
        /* A terminal event, never the abort request, decides publication. */
      }
    };
    const cancel = () =>
      fail(signal!.reason ?? new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", cancel, { once: true });
    const close = () => {
      signal?.removeEventListener("abort", cancel);
      db.close();
    };
    tx.oncomplete = () => {
      close();
      resolve(result);
    };
    tx.onabort = () => {
      close();
      reject(error ?? tx.error ?? Error("Scene transaction aborted"));
    };
    try {
      run(
        tx,
        (value) => {
          result = value;
        },
        fail,
      );
    } catch (e) {
      fail(e);
    }
  });
}
const get = <T>(store: string, key: IDBValidKey, signal?: AbortSignal) =>
  transaction<T | undefined>([store], "readonly", signal, (tx, done) => {
    const q = tx.objectStore(store).get(key);
    q.onsuccess = () => done(q.result);
  });
async function descriptor(r: Revision, ctx: IOContext): Promise<Descriptor> {
  checkIO(ctx, WORKSPACE + r.descriptor.size * 4);
  const bytes = new Uint8Array(await r.descriptor.arrayBuffer());
  ctx.signal.throwIfAborted();
  if ((await sha256(bytes)) !== r.descriptorDigest)
    throw Error("Stored revision descriptor digest mismatch");
  ctx.signal.throwIfAborted();
  const d = record(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    ["document", "members"],
  );
  checkIO(ctx, WORKSPACE + metadataWorkspace(d));
  const document = parseDocument(d.document);
  if (
    document.resultBytes !== r.resultBytes ||
    !Array.isArray(d.members) ||
    d.members.length > 2048
  )
    throw Error("Stored descriptor header mismatch");
  // Full member/reference shape is checked against the restored Snapshot before use.
  return { document, members: d.members as MemberReference[] };
}
async function readCatalog(
  digest: string | null,
  ctx: IOContext,
): Promise<CatalogView | null> {
  if (digest === null) return null;
  checkIO(ctx, WORKSPACE);
  const record = await get<CatalogRecord>("manifests", digest, ctx.signal);
  ctx.signal.throwIfAborted();
  if (
    !record ||
    record.digest !== digest ||
    !(record.data instanceof Blob) ||
    record.data.size > L.maxJsonBytes
  )
    throw Error("Missing bounded original catalog");
  checkIO(ctx, WORKSPACE + record.data.size * 4);
  const bytes = new Uint8Array(await record.data.arrayBuffer());
  ctx.signal.throwIfAborted();
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  checkIO(ctx, WORKSPACE + metadataWorkspace(value));
  const library = makeAssetLibrary(value, async () => {
    throw Error("Unbound catalog member");
  });
  await verifyCatalogView({
    digest: library.digest,
    manifests: library.manifests,
    styles: library.styles,
  });
  ctx.signal.throwIfAborted();
  if (library.digest !== digest) throw Error("Stored catalog binding mismatch");
  return {
    digest: library.digest,
    manifests: library.manifests,
    styles: library.styles,
  };
}
async function readBlob(
  hash: string,
  size: number,
  ctx: IOContext,
): Promise<{ bytes: Uint8Array; token: string }> {
  // IDB clones a Blob handle first. Its actual size is checked before materializing bytes.
  checkIO(ctx, 3 * size + WORKSPACE);
  const value = await get<BlobRecord>("blobs", hash, ctx.signal);
  ctx.signal.throwIfAborted();
  if (!value) throw Error("Missing exact saved blob " + hash);
  const b = blobRecord(value, hash, size),
    bytes = new Uint8Array(await b.data.arrayBuffer());
  ctx.signal.throwIfAborted();
  if ((await sha256(bytes)) !== hash) throw Error("Saved blob digest mismatch");
  ctx.signal.throwIfAborted();
  return { bytes, token: b.token };
}
function checkRestored(s: SceneSnapshot, r: Revision) {
  if (
    s.sceneId !== r.sceneId ||
    s.revisionId !== r.revisionId ||
    s.operationId !== r.operationId ||
    s.parentRevisionId !== r.parentRevisionId ||
    s.reviewStatus !== r.reviewStatus
  )
    throw Error("Stored revision identity differs from document");
}
async function restore(
  r: Revision,
  ctx: IOContext,
  prepared?: { d: Descriptor; catalog: CatalogView | null },
): Promise<SceneSnapshot> {
  const d = prepared?.d ?? (await descriptor(r, ctx)),
    catalog = prepared
      ? prepared.catalog
      : await readCatalog(r.catalogDigest, retainIO(ctx, metadataWorkspace(d)));
  const needed = new Map<string, number>();
  for (const b of d.document.buffers) {
    const size = b.length * (b.format === "u8" ? 1 : 4);
    if (needed.has(b.hash) && needed.get(b.hash) !== size)
      throw Error("Conflicting saved blob size");
    needed.set(b.hash, size);
  }
  const sourceBytes = [...needed.values()].reduce((n, b) => n + b, 0);
  const metadata =
    metadataWorkspace(d) + (catalog ? metadataWorkspace(catalog) : 0);
  checkIO(ctx, sourceBytes + 3 * r.resultBytes + metadata + WORKSPACE);
  const blobs = new Map<string, Uint8Array>();
  let held = 0;
  for (const [hash, size] of needed) {
    const ref = r.blobRefs.find((x) => x.hash === hash && x.bytes === size);
    if (!ref) throw Error("Undeclared saved result blob");
    const b = await readBlob(hash, size, retainIO(ctx, held + metadata));
    blobs.set(hash, b.bytes);
    held += b.bytes.length;
  }
  const s = await restoreDocument(
    d.document,
    blobs,
    retainIO(ctx, held + metadata),
  );
  checkRestored(s, r);
  await validateCatalog(s, catalog, ctx.signal);
  if (!same(d.members, memberReferences(s)))
    throw Error("Stored dependency identity mismatch");
  return s;
}
export function createSceneStore() {
  const readRevision = async (
    revisionId: string,
    context: IOContext,
  ): Promise<SceneSnapshot> => {
    const ctx = captureIO(context);
    checkIO(ctx, WORKSPACE);
    const value = await get<Revision>(
      "revisions",
      validId(revisionId),
      ctx.signal,
    );
    if (!value) throw Error("Unknown saved revision");
    const r = revision(value);
    if (r.status !== "committed")
      throw Error("Revision is only staging, not saved");
    return restore(r, ctx);
  };
  return {
    async stage(
      input: SceneSnapshot,
      context: SceneIOContext,
    ): Promise<StageRef> {
      const ctx = captureIO(context),
        p = await prepareScene(input, context, true),
        preparedMemory =
          p.ownedBytes +
          metadataWorkspace({
            document: p.document,
            catalog: p.catalog,
            members: p.members,
          });
      const snapshot = p.document.snapshot as SceneSnapshot;
      const ref = stageRef({
        sceneId: snapshot.sceneId,
        revisionId: snapshot.revisionId,
        operationId: snapshot.operationId,
      });
      const encoded = jsonBytes({ document: p.document, members: p.members }),
        descriptorDigest = await sha256(encoded);
      ctx.signal.throwIfAborted();
      checkIO(ctx, 2 * preparedMemory + WORKSPACE);
      const catalogBytes = p.catalog ? jsonBytes(p.catalog) : null;
      const r: Revision = {
        ...ref,
        status: "staging",
        parentRevisionId: snapshot.parentRevisionId,
        reviewStatus: snapshot.reviewStatus,
        catalogDigest: p.catalog?.digest ?? null,
        descriptor: new Blob([encoded as Uint8Array<ArrayBuffer>]),
        descriptorDigest,
        resultBytes: p.document.resultBytes,
        blobRefs: [...p.blobs]
          .map(([hash, b]) => ({ hash, bytes: b.length }))
          .sort((a, b) => a.hash.localeCompare(b.hash)),
      };
      const verified = new Map<string, string>();
      const previous = await get<Revision>(
        "revisions",
        ref.revisionId,
        ctx.signal,
      );
      if (previous) {
        const prior = revision(previous);
        const checked = await descriptor(prior, retainIO(ctx, preparedMemory));
        if (!same(checked, { document: p.document, members: p.members }))
          throw Error("Existing revision content differs");
      }
      // Verify existing immutable contents before a write transaction; token comparison guards normal writers/cleanup races.
      for (const [hash, bytes] of p.blobs) {
        const old = await get<BlobRecord>("blobs", hash, ctx.signal);
        if (old) {
          blobRecord(old, hash, bytes.length);
          const read = await readBlob(
            hash,
            bytes.length,
            retainIO(ctx, preparedMemory),
          );
          if (read.bytes.some((v, i) => v !== bytes[i]))
            throw Error("Existing blob differs despite key");
          verified.set(hash, read.token);
        }
      }
      if (catalogBytes) {
        const existing = await get<CatalogRecord>(
          "manifests",
          p.catalog!.digest,
          ctx.signal,
        );
        if (existing) {
          const c = await readCatalog(
            p.catalog!.digest,
            retainIO(ctx, preparedMemory),
          );
          if (!same(c, p.catalog)) throw Error("Existing catalog differs");
        }
      }
      ctx.signal.throwIfAborted();
      checkIO(ctx, 2 * preparedMemory + WORKSPACE);
      return transaction<StageRef>(
        ["revisions", "blobs", "manifests"],
        "readwrite",
        ctx.signal,
        (tx, done, fail) => {
          const revisions = tx.objectStore("revisions"),
            blobs = tx.objectStore("blobs"),
            q = revisions.get(ref.revisionId);
          q.onsuccess = () => {
            try {
              if (q.result) {
                const old = revision(q.result);
                if (
                  !same(
                    { ...old, descriptor: null, status: null },
                    { ...r, descriptor: null, status: null },
                  )
                )
                  throw Error("Revision identity/content conflict");
                done(ref);
                return;
              }
              let total = 0;
              const existing = new Map<string, BlobRecord>(),
                cursor = blobs.openCursor();
              cursor.onsuccess = () => {
                try {
                  const c = cursor.result;
                  if (c) {
                    const b = blobRecord(c.value, String(c.key));
                    total += b.size;
                    if (total > L.maxLocalBlobBytes)
                      throw Error(
                        "Stored blob budget exceeded; no scenes removed",
                      );
                    if (p.blobs.has(b.hash)) existing.set(b.hash, b);
                    c.continue();
                    return;
                  }
                  let added = 0;
                  for (const [hash, b] of p.blobs) {
                    const old = existing.get(hash);
                    if (old) {
                      if (
                        old.size !== b.length ||
                        verified.get(hash) !== old.token
                      )
                        throw Error("Concurrent blob change; retry staging");
                    } else added += b.length;
                  }
                  if (total + added > L.maxLocalBlobBytes)
                    throw Error(
                      "本地 blob 已达256MiB上限，请导出或由用户删除场景；未淘汰旧场景。",
                    );
                  for (const [hash, b] of p.blobs)
                    if (!existing.has(hash))
                      blobs.add({
                        hash,
                        size: b.length,
                        data: new Blob([b as Uint8Array<ArrayBuffer>]),
                        token: crypto.randomUUID(),
                      } satisfies BlobRecord);
                  if (catalogBytes) {
                    const store = tx.objectStore("manifests"),
                      catalog = store.get(p.catalog!.digest);
                    catalog.onsuccess = () => {
                      if (!catalog.result)
                        store.add({
                          digest: p.catalog!.digest,
                          data: new Blob([
                            catalogBytes as Uint8Array<ArrayBuffer>,
                          ]),
                        });
                    };
                  }
                  revisions.add(r);
                  done(ref);
                } catch (e) {
                  fail(e);
                }
              };
            } catch (e) {
              fail(e);
            }
          };
        },
      );
    },
    async commit(
      value: StageRef,
      expectedBase: string | null,
      signal: AbortSignal,
    ): Promise<CommitReceipt> {
      const ref = stageRef(value);
      if (expectedBase !== null) validId(expectedBase);
      signal.throwIfAborted();
      return transaction<CommitReceipt>(
        ["scenes", "revisions", "operations"],
        "readwrite",
        signal,
        (tx, done, fail) => {
          const revisions = tx.objectStore("revisions"),
            scenes = tx.objectStore("scenes"),
            operations = tx.objectStore("operations"),
            key = opKey(ref.sceneId, ref.operationId),
            op = operations.get(key);
          op.onsuccess = () => {
            try {
              if (op.result) {
                const old = op.result;
                if (
                  old.kind !== "commit" ||
                  !same(old.receipt, { ...ref, duplicate: false }) ||
                  old.expectedBase !== expectedBase
                )
                  throw Error("Operation identity reused for different commit");
                const verify = revisions.get(ref.revisionId);
                verify.onsuccess = () => {
                  try {
                    if (!verify.result)
                      throw Error(
                        "Duplicate receipt has no committed revision",
                      );
                    const r = revision(verify.result);
                    if (
                      r.status !== "committed" ||
                      r.sceneId !== ref.sceneId ||
                      r.operationId !== ref.operationId ||
                      r.descriptorDigest !== old.descriptorDigest
                    )
                      throw Error("Duplicate receipt revision content differs");
                    done({ ...ref, duplicate: true });
                  } catch (e) {
                    fail(e);
                  }
                };
                return;
              }
              const rq = revisions.get(ref.revisionId);
              rq.onsuccess = () => {
                try {
                  if (!rq.result) throw Error("Missing stage");
                  const r = revision(rq.result);
                  if (
                    r.sceneId !== ref.sceneId ||
                    r.operationId !== ref.operationId ||
                    r.status !== "staging"
                  )
                    throw Error("Stage identity/state mismatch");
                  const sq = scenes.get(ref.sceneId);
                  sq.onsuccess = () => {
                    try {
                      const current = sq.result?.currentRevisionId ?? null;
                      if (current !== expectedBase)
                        throw Error(
                          "stale: current revision differs from expected base",
                        );
                      if (current !== null && r.parentRevisionId !== current)
                        throw Error("Stage parent differs from current base");
                      const publish = () => {
                        const receipt = { ...ref, duplicate: false };
                        revisions.put({ ...r, status: "committed" });
                        operations.add({
                          key,
                          kind: "commit",
                          expectedBase,
                          receipt,
                          descriptorDigest: r.descriptorDigest,
                        });
                        scenes.put({
                          sceneId: ref.sceneId,
                          currentRevisionId: ref.revisionId,
                          reviewStatus: r.reviewStatus,
                        });
                        done(receipt);
                      };
                      if (!sq.result) {
                        const count = scenes.count();
                        count.onsuccess = () => {
                          try {
                            if (count.result >= L.maxLocalScenes)
                              throw Error(
                                "本机场景已达20个上限，请导出或由用户删除；未淘汰旧场景。",
                              );
                            publish();
                          } catch (e) {
                            fail(e);
                          }
                        };
                      } else publish();
                    } catch (e) {
                      fail(e);
                    }
                  };
                } catch (e) {
                  fail(e);
                }
              };
            } catch (e) {
              fail(e);
            }
          };
        },
      );
    },
    async open(sceneId: string, context: IOContext): Promise<SceneSnapshot> {
      const ctx = captureIO(context);
      checkIO(ctx, WORKSPACE);
      const scene = await get<SceneSummary>(
        "scenes",
        validId(sceneId),
        ctx.signal,
      );
      if (!scene) throw Error("Unknown saved scene");
      if (scene.sceneId !== sceneId)
        throw Error("Scene pointer identity mismatch");
      const s = await readRevision(scene.currentRevisionId, ctx);
      if (s.sceneId !== sceneId) throw Error("Cross-scene current pointer");
      return s;
    },
    readRevision,
    async list(): Promise<SceneSummary[]> {
      return transaction(
        ["scenes"],
        "readonly",
        undefined,
        (tx, done, fail) => {
          const out: SceneSummary[] = [],
            q = tx.objectStore("scenes").openCursor();
          q.onsuccess = () => {
            try {
              const c = q.result;
              if (!c) {
                done(out.sort((a, b) => a.sceneId.localeCompare(b.sceneId)));
                return;
              }
              const r = record(c.value, [
                "sceneId",
                "currentRevisionId",
                "reviewStatus",
              ]);
              validId(r.sceneId);
              validId(r.currentRevisionId);
              if (r.reviewStatus !== "draft" && r.reviewStatus !== "accepted")
                throw Error("Saved summary status");
              out.push(r as SceneSummary);
              if (out.length > L.maxLocalScenes)
                throw Error("Scene count limit");
              c.continue();
            } catch (e) {
              fail(e);
            }
          };
        },
      );
    },
    /** Operation-scoped source: acquire again with a fresh caller ledger for a later operation.
     * The consumer preflights its full decoded assets/current renderer before loadAsset. */
    async libraryForRevision(
      revisionId: string,
      context: IOContext,
    ): Promise<AssetLibrary | null> {
      const ctx = captureIO(context);
      checkIO(ctx, WORKSPACE);
      const value = await get<Revision>(
        "revisions",
        validId(revisionId),
        ctx.signal,
      );
      if (!value) throw Error("Unknown saved revision");
      const r = revision(value);
      if (r.status !== "committed")
        throw Error("Staging is not a saved revision");
      const d = await descriptor(r, ctx),
        catalog = await readCatalog(
          r.catalogDigest,
          retainIO(ctx, metadataWorkspace(d)),
        );
      if (!catalog) {
        await restore(r, ctx, { d, catalog });
        return null;
      }
      // Rehydrate/check document once so the resolver cannot grant authority from unrelated member metadata.
      const s = await restore(r, ctx, { d, catalog });
      if (!same(d.members, memberReferences(s)))
        throw Error("Saved member bindings differ");
      const members = memberReferences(s);
      return makeAssetLibrary(catalog, async (ref, path, signal) => {
        signal.throwIfAborted();
        const m = members.find((m) => same(m.assetRef, ref) && m.path === path);
        if (!m) throw Error("Exact member was never cached for this revision");
        const b = await readBlob(m.hash, m.bytes, {
          signal,
          resources: { retainedBytes: ctx.resources.retainedBytes },
          candidateBytes: ctx.candidateBytes,
        });
        return b.bytes;
      });
    },
    async discardStage(value: StageRef): Promise<void> {
      const ref = stageRef(value);
      await transaction<void>(
        ["revisions", "blobs", "manifests"],
        "readwrite",
        undefined,
        (tx, done, fail) => {
          const revisions = tx.objectStore("revisions"),
            q = revisions.get(ref.revisionId);
          q.onsuccess = () => {
            try {
              if (!q.result) {
                done();
                return;
              }
              const target = revision(q.result);
              if (
                target.sceneId !== ref.sceneId ||
                target.operationId !== ref.operationId
              )
                throw Error("Stage identity mismatch");
              if (target.status === "committed") {
                done();
                return;
              }
              // Keep only this bounded stage's candidates, never every historical reference.
              const unreferenced = new Set(target.blobRefs.map((b) => b.hash)),
                cursor = revisions.openCursor();
              let catalogReferenced = false;
              cursor.onsuccess = () => {
                try {
                  const c = cursor.result;
                  if (c) {
                    const r = revision(c.value);
                    if (r.revisionId !== ref.revisionId) {
                      r.blobRefs.forEach((b) => unreferenced.delete(b.hash));
                      if (r.catalogDigest === target.catalogDigest)
                        catalogReferenced = true;
                    }
                    c.continue();
                    return;
                  }
                  revisions.delete(ref.revisionId);
                  for (const hash of unreferenced)
                    tx.objectStore("blobs").delete(hash);
                  if (target.catalogDigest && !catalogReferenced)
                    tx.objectStore("manifests").delete(target.catalogDigest);
                  done();
                } catch (e) {
                  fail(e);
                }
              };
            } catch (e) {
              fail(e);
            }
          };
        },
      );
    },
    async checkout(
      sceneId: string,
      targetRevisionId: string,
      expectedCurrent: string,
      operationId: string,
      signal: AbortSignal,
    ): Promise<CommitReceipt> {
      const ref = stageRef({
        sceneId,
        revisionId: targetRevisionId,
        operationId,
      });
      validId(expectedCurrent);
      signal.throwIfAborted();
      return transaction<CommitReceipt>(
        ["scenes", "revisions", "operations"],
        "readwrite",
        signal,
        (tx, done, fail) => {
          const operations = tx.objectStore("operations"),
            key = opKey(sceneId, operationId),
            op = operations.get(key);
          op.onsuccess = () => {
            try {
              if (op.result) {
                if (
                  op.result.kind !== "checkout" ||
                  op.result.expectedCurrent !== expectedCurrent ||
                  !same(op.result.receipt, { ...ref, duplicate: false })
                )
                  throw Error("Operation reused for different checkout");
                const verify = tx
                  .objectStore("revisions")
                  .get(targetRevisionId);
                verify.onsuccess = () => {
                  try {
                    if (!verify.result)
                      throw Error("Duplicate checkout target is missing");
                    const r = revision(verify.result);
                    if (
                      r.status !== "committed" ||
                      r.sceneId !== sceneId ||
                      r.descriptorDigest !== op.result.descriptorDigest
                    )
                      throw Error("Duplicate checkout content differs");
                    done({ ...ref, duplicate: true });
                  } catch (e) {
                    fail(e);
                  }
                };
                return;
              }
              const sq = tx.objectStore("scenes").get(sceneId);
              sq.onsuccess = () => {
                try {
                  if (sq.result?.currentRevisionId !== expectedCurrent)
                    throw Error("stale: current revision changed");
                  const rq = tx.objectStore("revisions").get(targetRevisionId);
                  rq.onsuccess = () => {
                    try {
                      if (!rq.result) throw Error("Missing checkout target");
                      const r = revision(rq.result);
                      if (r.sceneId !== sceneId || r.status !== "committed")
                        throw Error(
                          "Checkout target is not committed in this scene",
                        );
                      const receipt = { ...ref, duplicate: false };
                      operations.add({
                        key,
                        kind: "checkout",
                        expectedCurrent,
                        receipt,
                        descriptorDigest: r.descriptorDigest,
                      });
                      tx.objectStore("scenes").put({
                        sceneId,
                        currentRevisionId: targetRevisionId,
                        reviewStatus: r.reviewStatus,
                      });
                      done(receipt);
                    } catch (e) {
                      fail(e);
                    }
                  };
                } catch (e) {
                  fail(e);
                }
              };
            } catch (e) {
              fail(e);
            }
          };
        },
      );
    },
  };
}
