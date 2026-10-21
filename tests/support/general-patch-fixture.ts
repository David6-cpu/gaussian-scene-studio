/** Constructed engineering evidence only. Never contributes real asset/style admission. */
import { PerspectiveCamera, Vector3 } from "three";
import { buildFixture } from "./general-build-fixture";
import { sha256 } from "../../src/io/hash";
import {
  createCatalogView,
  makeAssetLibrary,
  styleContentVersion,
  type AssetLibrary,
} from "../../src/general-scene/asset-library";
import {
  assertAssetLayout,
  assetContentVersion,
} from "../../src/general-scene/asset-package";
import {
  loadAsset,
  type LoadedAsset,
} from "../../src/general-scene/asset-loader";
import { documentDigest } from "../../src/general-scene/canonical";
import {
  buildOwnedBytes,
  storedResultsToRenderPacket,
  surfaceTilePayloadDigest,
} from "../../src/general-scene/compile";
import {
  parseEditableState,
  parsePatch,
  parsePlanDraft,
  parseSnapshot,
  type EditableSnapshot,
  type Polygon,
  type ScenePatch,
} from "../../src/general-scene/contracts";
import { createBuildClient } from "../../src/general-scene/worker-client";
import { proposePatch, previewPatch } from "../../src/general-scene/patch";
import { createSceneStore } from "../../src/general-scene/storage";
import {
  decodeGeneralArchive,
  encodeGeneralArchive,
  type ImportedScene,
} from "../../src/general-scene/archive";
import {
  sparkRendererBudget,
  sparkSceneCapacity,
} from "../../src/gaussian/spark-budget";
import { sourceOwnedBytes } from "../../src/general-scene/render/source-bank";
import type {
  GeneralView,
  GeneralSwap,
  RenderPacket,
} from "../../src/general-scene/render/types";
import type { Result } from "../../src/general-scene/core";
const take = <T>(r: Result<T>): T => {
  if (!r.ok) throw Error(JSON.stringify(r.issues));
  return r.value;
};
const rect = (x0: number, z0: number, x1: number, z1: number): Polygon => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];
export const patchRegion = rect(-2.4, -3.4, -0.4, -0.7);
const brushRegion = rect(-2.4, -2.1, -1.6, -1.3);
const camera = { position: [7, 7, 8] as const, target: [0, 0, 0] as const };

async function fixture() {
  const f = await buildFixture({ count: 5, unusedVariant: true });
  const replacements = new Map<string, string>();
  const manifests: any[] = structuredClone([...f.library.manifests]);
  const styles: any[] = structuredClone([...f.library.styles]);
  for (const m of [...manifests, ...styles]) {
    const old = m.contentVersion;
    m.provenance.license.id = "constructed-patch-export";
    m.provenance.license.redistributable = true;
    m.provenance.license.redistributionBasis =
      "Permission for isolated constructed test bytes only; no real asset rights.";
    if ("kind" in m) {
      const bytes = new TextEncoder().encode(
        "Redistribution of these isolated constructed test bytes is permitted. No real asset rights.\n",
      );
      f.packages
        .find((p) => p.manifest.id === m.id)!
        .members.set("license.txt", bytes);
      const file = m.files.find((x: any) => x.path === "license.txt");
      file.bytes = bytes.length;
      file.sha256 = await sha256(bytes);
      m.resources.cpuSourceBytes = m.files.reduce(
        (n: number, x: any) => n + x.bytes,
        0,
      );
      m.quality.humanReview.files = m.files.map((x: any) => ({
        path: x.path,
        sha256: x.sha256,
      }));
      m.contentVersion = await assetContentVersion(m);
    } else m.contentVersion = await styleContentVersion(m);
    m.quality.humanReview.asset.contentVersion = m.contentVersion;
    if (!("kind" in m))
      m.quality.humanReview.files[0].sha256 = m.contentVersion.slice(7);
    replacements.set(old, m.contentVersion);
    replacements.set(old.slice(7), m.contentVersion.slice(7));
  }
  const catalog = await createCatalogView(manifests, styles);
  replacements.set(f.library.digest, catalog.digest);
  const replace = (v: any): any =>
    typeof v === "string"
      ? (replacements.get(v) ?? v)
      : Array.isArray(v)
        ? v.map(replace)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, replace(x)]),
            )
          : v;
  f.draft = parsePlanDraft({
    ...replace(f.draft),
    domain: { ...f.draft.domain, width: 8, depth: 8 },
    regions: [
      {
        regionId: "all",
        shape: { kind: "rectangle", min: [-4, -4], max: [4, 4] },
      },
    ],
  });
  f.library = makeAssetLibrary(catalog, async (ref, name, signal) => {
    signal.throwIfAborted();
    const b = f.packages
      .find((p) => p.manifest.id === ref.id)!
      .members.get(name);
    if (!b) throw Error("Missing exact constructed byte");
    return new Uint8Array(b);
  });
  f.assets = await Promise.all(
    manifests.map((m) => loadAsset(m, f.library, f.context.signal)),
  );
  const original = {
    id: manifests[0].id,
    contentVersion: manifests[0].contentVersion,
  };
  const variant = {
    id: manifests[1].id,
    contentVersion: manifests[1].contentVersion,
  };
  const positions = [
    [-2, -2],
    [-1.1, -2],
    [-2.7, -1.5],
    [2.7, 2.7],
    [3, -2.7],
  ];
  f.state = parseEditableState({
    ...f.state,
    groups: [{ groupId: "rock", nextSlot: 5, retired: false }],
    lockedInstanceIds: ["rock:4"],
    overrides: positions.map(([x, z], i) => ({
      instanceId: `rock:${i}`,
      groupId: "rock",
      kind: "add",
      assetRef: i === 3 ? variant : original,
      transform: {
        position: [x, 0.015, z],
        quaternion: [0, 0, 0, 1],
        scale: 1,
      },
    })),
  });
  return f;
}

export function createPatchHarness(
  view: GeneralView,
  frame: () => Promise<void>,
  settle: () => Promise<void>,
) {
  const store = createSceneStore();
  let current: EditableSnapshot | null = null,
    library: AssetLibrary | null = null,
    assets: LoadedAsset[] = [];
  let proposal: Awaited<ReturnType<typeof proposePatch>> extends Result<infer T>
    ? T
    : never;
  let pending: Awaited<ReturnType<typeof previewPatch>> extends Result<infer T>
    ? T
    : never;
  let client: ReturnType<typeof createBuildClient> | null = null,
    swap: GeneralSwap | null = null;
  let imported: ImportedScene | null = null,
    fixtureHeld: Awaited<ReturnType<typeof fixture>> | null = null;
  let context: any = null,
    busy = false;
  const counts = {
    propose: 0,
    resolve: 0,
    build: 0,
    workers: 0,
    moduleWorkers: 0,
    posted: 0,
    terminated: 0,
  };
  let onWorkerPost: (() => void) | null = null;
  const NativeWorker = window.Worker;
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      counts.workers++;
      if (options?.type === "module") counts.moduleWorkers++;
    }
    postMessage(message: any, transfer: any) {
      counts.posted++;
      super.postMessage(message, transfer);
      const callback = onWorkerPost;
      onWorkerPost = null;
      callback?.();
    }
    terminate() {
      counts.terminated++;
      return super.terminate();
    }
  }
  window.Worker = ObservedWorker;
  const openClient = () => {
    client?.dispose();
    client = createBuildClient();
    for (const key of ["resolve", "build", "propose"] as const) {
      const original = client[key].bind(client);
      (client as any)[key] = (...args: any[]) => {
        counts[key]++;
        return (original as any)(...args);
      };
    }
    return client;
  };
  const held = () => ({
    current,
    assets,
    fixtureHeld,
    proposal,
    pending,
    imported,
  });
  const resources = (supplied: unknown = null, extra: unknown = null) => ({
    retainedBytes:
      view.stats().ownedBytes +
      buildOwnedBytes({ held: held(), extra }) -
      buildOwnedBytes(supplied) +
      (imported?.ownership.ownedBytes ?? 0),
  });
  const io = (extra: unknown = null) => ({
    signal: new AbortController().signal,
    resources: resources(null, extra),
  });
  const load = async (s: EditableSnapshot, l: AssetLibrary) => {
    const layouts = s.assets.map((a) => assertAssetLayout(a.manifest));
    const peak =
      layouts.reduce((n, a) => n + a.sourceBytes + a.decodedBytes, 0) +
      2 * Math.max(0, ...layouts.map((a) => a.maxMemberBytes)) +
      8 * 1024 ** 2;
    if (
      peak > 128 * 1024 ** 2 ||
      resources(null, s).retainedBytes + peak > 256 * 1024 ** 2
    )
      throw Error("Known loader peak exceeds ledger");
    const loaded = [];
    for (const a of s.assets)
      loaded.push(await loadAsset(a.assetRef, l, new AbortController().signal));
    return loaded;
  };
  const prepare = async (packet: RenderPacket) => {
    const counts = packet.instances.map((i) =>
      Math.max(
        packet.sources.get(i.sourceKey)!.count,
        i.coarseSourceKey ? packet.sources.get(i.coarseSourceKey)!.count : 0,
      ),
    );
    const reservation =
      sparkRendererBudget(sparkSceneCapacity(counts)).reservedBytes +
      [...packet.sources.values()].reduce((n, s) => n + sourceOwnedBytes(s), 0);
    if (resources(null, packet).retainedBytes + reservation > 256 * 1024 ** 2)
      throw Error("Display preparation peak exceeds ledger");
    const s = await view.prepare(packet, new AbortController().signal);
    s.activate();
    view.setCamera(camera);
    const start = performance.now();
    while (!s.isUsable()) {
      if (performance.now() - start > 10000) {
        s.rollback();
        throw Error("Patch candidate never drew");
      }
      await frame();
    }
    await settle();
    return s;
  };
  const renderCurrent = async () => {
    if (!current || !library) throw Error("Missing current scene");
    assets = await load(current, library);
    const r = take(
      await storedResultsToRenderPacket(
        current,
        assets,
        new AbortController().signal,
        resources({ input: current, assets }),
      ),
    );
    const s = await prepare(r.render);
    s.commit();
    await settle();
  };
  const tileEvidence = async (s: EditableSnapshot) => {
    const out: any[] = [];
    for (const surface of s.surfaces) {
      const owned = new Set<number>();
      for (const tile of surface.tiles)
        for (const index of tile.outputIndices) {
          if (owned.has(index) || index >= surface.count)
            throw Error("Invalid duplicate surface owner");
          owned.add(index);
        }
      if (owned.size !== surface.count)
        throw Error("Incomplete surface ownership");
    }
    for (const t of s.terrain.tiles) {
      const nodes = [...t.nodeIndices];
      const water =
        s.water.mode === "none"
          ? null
          : {
              mask: nodes.map((i) =>
                s.water.mode === "none" ? 0 : s.water.mask[i],
              ),
              bankMask: nodes.map((i) =>
                s.water.mode === "none" ? 0 : s.water.bankMask[i],
              ),
              signedDistance: nodes.map((i) =>
                s.water.mode === "none" ? 0 : s.water.signedDistance[i],
              ),
            };
      const terrain = await documentDigest({
        bounds: t.bounds,
        nodeIndices: t.nodeIndices,
        outputIndices: t.outputIndices,
        heights: nodes.map((i) => s.terrain.heights[i]),
        normals: nodes.flatMap((i) => [
          ...s.terrain.normals.subarray(3 * i, 3 * i + 3),
        ]),
        base:
          s.terrain.heightModel.kind === "water-profile"
            ? nodes.map((i) =>
                s.terrain.heightModel.kind === "water-profile"
                  ? s.terrain.heightModel.baseHeights[i]
                  : 0,
              )
            : null,
        water,
      });
      const surfaces = [];
      for (const surface of s.surfaces) {
        const owner = surface.tiles.find((o) => o.tileId === t.id);
        if (owner)
          surfaces.push({
            role: surface.role,
            count: owner.outputIndices.length,
            payload: await surfaceTilePayloadDigest(surface.data, owner),
          });
      }
      out.push({ tileId: t.id, bounds: t.bounds, terrain, surfaces });
    }
    return out;
  };
  const evidence = async (s = current!) => ({
    sceneId: s.sceneId,
    revisionId: s.revisionId,
    parentRevisionId: s.parentRevisionId,
    operationId: s.operationId,
    documentDigest: await documentDigest(s),
    stateDigest: await documentDigest(s.state),
    geometryDigest: s.geometryDigest,
    planDigest: await documentDigest(s.plan),
    instances: s.instances,
    state: s.state,
    patch: s.patch,
    tiles: await tileEvidence(s),
    terrainDigest: await documentDigest(s.terrain),
    waterDigest: await documentDigest(s.water),
    surfaceDigest: await documentDigest(s.surfaces),
    assets: s.assets.map((a) => ({
      assetRef: a.assetRef,
      digest: a.digest,
      files: a.manifest.files,
    })),
    catalogDigest: s.plan.catalogDigest,
    versions: {
      generator: s.plan.generatorVersion,
      rules: s.plan.rulesVersion,
      prng: s.plan.prngVersion,
    },
    usage: s.validation.usage,
    camera: view.getCamera(),
    stats: view.stats(),
    counts: { ...counts },
    busy,
    provenance:
      "constructed engineering fixture; no real asset/style or scene visual acceptance",
  });
  const open = async (sceneId: string) => {
    client?.dispose();
    client = null;
    proposal = undefined as any;
    pending = undefined as any;
    assets = [];
    fixtureHeld = null;
    library = null;
    imported?.ownership.dispose();
    imported = null;
    const s = await store.open(sceneId, io());
    if (s.capability !== "editable") throw Error("Read-only fixture");
    current = s;
    library = await store.libraryForRevision(s.revisionId, io());
    if (!library) throw Error("No revision library");
    await renderCurrent();
    return evidence();
  };
  return async function patch(action: string, options: any = {}) {
    if (action === "status")
      return { busy, counts: { ...counts }, camera: view.getCamera() };
    if (action === "seed") {
      fixtureHeld = await fixture();
      const f = fixtureHeld,
        c = openClient();
      const ctx = {
        ...f.context,
        sceneId: "patch-scene",
        revisionId: "patch-root",
        operationId: "patch-root-op",
        camera,
      };
      const r = take(
        await c.resolve(f.draft, f.state, f.library, {
          ...ctx,
          resources: resources(),
        }),
      );
      const b = take(
        await c.build(r, f.state, f.assets, {
          ...ctx,
          resources: resources({ assets: f.assets }, r),
        }),
      );
      current = b.snapshot;
      library = c.operationLibrary(ctx.operationId) ?? f.library;
      assets = f.assets;
      const s = await prepare(b.render);
      const receipt = await store.commit(
        await store.stage(current, { ...io({ b, r }), library }),
        null,
        ctx.signal,
      );
      s.commit();
      c.dispose();
      client = null;
      // The initial resolver still closes over fixture bytes until a revision-bound reopen.
      return {
        ...(await evidence()),
        receipt,
        labels: {
          A: "rock:0",
          B: "rock:1",
          G: "rock:2",
          F: "rock:3",
          lock: "rock:4",
        },
        region: patchRegion,
        brushRegion,
      };
    }
    if (action === "open") return open(options.sceneId ?? "patch-scene");
    if (action === "evidence") return evidence();
    if (action === "read") {
      const snapshot = await store.readRevision(options.revisionId, io());
      if (snapshot.capability !== "editable")
        throw Error("Expected editable history");
      return evidence(snapshot);
    }
    if (action === "history") {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("gaussian-general-scenes", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<any>((resolve, reject) => {
          const tx = db.transaction("revisions"),
            request = tx.objectStore("revisions").getAll();
          request.onsuccess = () =>
            resolve(
              request.result.map((r: any) => ({
                revisionId: r.revisionId,
                status: r.status,
                descriptorDigest: r.descriptorDigest,
              })),
            );
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    }
    if (action === "overlay") {
      const canvas = document.querySelector<HTMLCanvasElement>("#debug")!,
        ctx = canvas.getContext("2d")!;
      const dpr = Math.min(devicePixelRatio || 1, 2),
        w = canvas.clientWidth,
        h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      if (options.visible && proposal) {
        const cam = new PerspectiveCamera(50, w / h, 0.01, 150),
          state = view.getCamera();
        cam.position.fromArray(state.position);
        cam.lookAt(new Vector3(...state.target));
        cam.updateMatrixWorld();
        for (const [region, color, label] of [
          [proposal.effectiveRegion, "#00dfff", "H: reviewed effect"],
          [proposal.requestedRegion, "#ffd02e", "R: request"],
        ] as const) {
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          region.forEach(([x, z], index) => {
            const q = new Vector3(x, 0.025, z).project(cam);
            const px = ((q.x + 1) * w) / 2,
              py = ((1 - q.y) * h) / 2;
            if (index === 0) {
              ctx.moveTo(px, py);
              ctx.fillText(label, px + 5, py - 5);
            } else ctx.lineTo(px, py);
          });
          ctx.closePath();
          ctx.stroke();
        }
      }
      return {
        camera: view.getCamera(),
        requestedRegion: proposal?.requestedRegion,
        effectiveRegion: proposal?.effectiveRegion,
      };
    }
    if (action === "propose") {
      if (!current || !library) throw Error("No opened parent");
      if (swap) throw Error("Existing candidate");
      pending = undefined as any;
      proposal = undefined as any;
      const c = openClient();
      context = {
        sceneId: current.sceneId,
        baseRevisionId: current.revisionId,
        revisionId: options.revisionId,
        operationId: options.operationId,
        signal: new AbortController().signal,
      };
      const operations = options.operations as ScenePatch["operations"],
        targets = operations.flatMap((o) =>
          "instanceId" in o ? [o.instanceId] : [],
        );
      const R = options.region ?? patchRegion;
      const patch = parsePatch({
        documentType: "general-scene-patch",
        schemaVersion: 1,
        patchId: options.patchId,
        baseRevisionId: current.revisionId,
        raw: options.raw ?? "Constructed explicit local edit",
        requestedRegion: R,
        effectiveRegion: R,
        targetInstanceIds: [...new Set(targets)],
        lockedInstanceIds: current.state.lockedInstanceIds,
        affectedInstanceIds: [...new Set(targets)],
        affectedTileIds: [],
        operations,
        review: {
          scopeAccepted: false,
          planDigest: await documentDigest(current.plan),
          catalogDigest: library.digest,
          assetBindings: [],
        },
      });
      busy = true;
      try {
        proposal = take(
          await proposePatch(
            current,
            patch,
            library,
            { ...context, resources: resources(current) },
            c,
          ),
        );
        return { proposal, counts: { ...counts }, parent: await evidence() };
      } finally {
        busy = false;
      }
    }
    if (action === "preview") {
      if (!proposal || !current || !library || !client)
        throw Error("No reviewed proposal");
      const accepted = parsePatch({
        ...proposal.patch,
        review: { ...proposal.patch.review, scopeAccepted: true },
      });
      busy = true;
      try {
        pending = take(
          await previewPatch(
            current,
            accepted,
            library,
            { ...context, resources: resources(current) },
            client,
          ),
        );
        swap = await prepare(pending.compiled.render);
        const candidate = pending.compiled.snapshot;
        const instanceIds = [
          ...new Set(
            [...current.instances, ...candidate.instances].map(
              (i) => i.instanceId,
            ),
          ),
        ].sort();
        const instanceDiff = instanceIds.flatMap((instanceId) => {
          const before =
              current!.instances.find((i) => i.instanceId === instanceId) ??
              null,
            after =
              candidate.instances.find((i) => i.instanceId === instanceId) ??
              null;
          return JSON.stringify(before) === JSON.stringify(after)
            ? []
            : [{ instanceId, before, after }];
        });
        const heightDiff = [...current.terrain.heights].flatMap(
          (before, index) => {
            const after = candidate.terrain.heights[index];
            if (before === after) return [];
            const x =
              -current!.terrain.width / 2 +
              (index % current!.terrain.nx) * current!.terrain.spacing;
            const z =
              -current!.terrain.depth / 2 +
              Math.floor(index / current!.terrain.nx) *
                current!.terrain.spacing;
            const insideBrush = accepted.operations.some(
              (o) =>
                o.kind === "brush" &&
                Math.hypot(x - o.center[0], z - o.center[1]) <= o.radius + 1e-9,
            );
            return [{ index, point: [x, z], before, after, insideBrush }];
          },
        );
        return {
          diff: { instances: instanceDiff, heights: heightDiff },
          candidate: await evidence(pending.compiled.snapshot),
          parent: await evidence(),
          proposal,
        };
      } finally {
        busy = false;
      }
    }
    if (action === "cancel") {
      const start = performance.now();
      swap?.rollback();
      swap = null;
      client?.cancel(context?.operationId);
      client?.dispose();
      client = null;
      pending = undefined as any;
      proposal = undefined as any;
      busy = false;
      await settle();
      return { parent: await evidence(), elapsedMs: performance.now() - start };
    }
    if (action === "commit") {
      if (!swap?.isUsable() || !pending || !current || !client)
        throw Error("Undrawn candidate cannot save");
      const library = client.operationLibrary(context.operationId);
      if (!library) throw Error("Missing exact operation library");
      const ref = await store.stage(pending.compiled.snapshot, {
        ...io(),
        library,
      });
      const receipt = await store.commit(
        ref,
        current.revisionId,
        context.signal,
      );
      swap.commit();
      swap = null;
      current = pending.compiled.snapshot;
      client.dispose();
      client = null;
      pending = undefined as any;
      proposal = undefined as any;
      await open(current.sceneId);
      return { ...(await evidence()), receipt };
    }
    if (action === "replay") {
      const before = await store.list();
      const receipt = await store.commit(
        {
          sceneId: options.ref.sceneId,
          revisionId: options.ref.revisionId,
          operationId: options.ref.operationId,
        },
        options.base,
        new AbortController().signal,
      );
      return {
        receipt,
        before,
        after: await store.list(),
        current: await evidence(),
      };
    }
    if (action === "undo") {
      if (!current) throw Error("No parent");
      const receipt = await store.checkout(
        current.sceneId,
        options.target,
        current.revisionId,
        options.operationId,
        new AbortController().signal,
      );
      await open(current.sceneId);
      return { ...(await evidence()), receipt };
    }
    if (action === "export") {
      if (!current || !library) throw Error("No current");
      const bytes = await encodeGeneralArchive(current, assets, "embedded", {
        ...io(),
        library,
      });
      return {
        bytes: [...bytes],
        digest: await sha256(bytes),
        current: await evidence(),
      };
    }
    if (action === "import") {
      const bytes = Uint8Array.from(options.bytes);
      client?.dispose();
      client = null;
      current = null;
      assets = [];
      library = null;
      fixtureHeld = null;
      pending = undefined as any;
      proposal = undefined as any;
      imported = take(await decodeGeneralArchive(bytes, null, io(bytes)));
      if (
        !imported.editable ||
        !imported.library ||
        imported.snapshot.capability !== "editable"
      )
        throw Error("Embedded fixture not editable");
      const original = imported.snapshot;
      current = parseSnapshot({
        ...original,
        sceneId: "patch-imported",
        revisionId: "patch-import-root",
        operationId: "patch-import-op",
      }) as EditableSnapshot;
      library = imported.library;
      assets = imported.assets;
      const r = take(
        await storedResultsToRenderPacket(
          current,
          assets,
          new AbortController().signal,
          resources({ input: current, assets }, bytes),
        ),
      );
      const s = await prepare(r.render);
      const receipt = await store.commit(
        await store.stage(current, { ...io({ bytes, original }), library }),
        null,
        new AbortController().signal,
      );
      s.commit();
      return {
        ...(await evidence()),
        receipt,
        historyNotice: imported.historyNotice,
        originalRevisionId: original.revisionId,
        ownedImportedBytes: imported.ownership.ownedBytes,
      };
    }
    if (action === "rebuild") {
      if (!current || !library) throw Error("No imported scene");
      const c = openClient();
      const ctx = {
        sceneId: current.sceneId,
        revisionId: "patch-explicit-rebuild",
        operationId: "patch-rebuild-op",
        baseRevisionId: current.revisionId,
        signal: new AbortController().signal,
        intent: current.intent,
        modelEvidence: current.modelEvidence,
        patch: null,
        baseSnapshot: current,
        camera: current.camera,
      };
      const r = take(
        await c.resolve(current.plan, current.state, library, {
          ...ctx,
          resources: resources(),
          dependencies: { patch: null, baseSnapshot: current },
        }),
      );
      const b = take(
        await c.build(r, current.state, assets, {
          ...ctx,
          resources: resources({ assets, baseSnapshot: current }, r),
        }),
      );
      c.dispose();
      client = null;
      return {
        rebuilt: await evidence(b.snapshot),
        current: await evidence(),
        counts: { ...counts },
      };
    }
    if (action === "cancel-inflight") {
      if (!current || !library) throw Error("No current");
      const c = openClient(),
        abort = new AbortController();
      const ctx = {
        sceneId: current.sceneId,
        revisionId: "cancelled-revision",
        operationId: "cancelled-op",
        baseRevisionId: current.revisionId,
        signal: abort.signal,
        resources: resources(),
      };
      const before = { ...counts };
      let start = 0;
      onWorkerPost = () => {
        start = performance.now();
        abort.abort();
      };
      busy = true;
      const result = await c.resolve(current.plan, current.state, library, ctx);
      onWorkerPost = null;
      if (!start)
        throw Error("Cancellation did not reach an actual module worker post");
      busy = false;
      c.dispose();
      client = null;
      await settle();
      return {
        result,
        observed: {
          created: counts.workers - before.workers,
          posted: counts.posted - before.posted,
          terminated: counts.terminated - before.terminated,
        },
        elapsedMs: performance.now() - start,
        parent: await evidence(),
      };
    }
    throw Error("Unknown patch harness action: " + action);
  };
}
