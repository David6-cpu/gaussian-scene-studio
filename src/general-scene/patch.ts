import { makeAssetLibrary, type AssetLibrary } from "./asset-library";
import { loadAsset, type LoadedAsset } from "./asset-loader";
import { assertAssetLayout } from "./asset-package";
import { canonicalJson } from "./canonical";
import {
  buildOwnedBytes,
  type CompiledScene,
  type PatchProposal,
} from "./compile";
import {
  parseCompileContext,
  parsePatch,
  parseSnapshot,
  type SceneSnapshot,
  type ScenePatch,
  type RevisionContext,
  type BuildResourceContext,
} from "./contracts";
import { GENERAL_LIMITS as L, type Result } from "./core";
import type { BuildClient } from "./worker-client";
export type { PatchProposal } from "./compile";
export type PatchContext = RevisionContext & {
  resources: BuildResourceContext;
};
export type PatchPreview = {
  compiled: CompiledScene;
  requestedRegion: PatchProposal["requestedRegion"];
  effectiveRegion: PatchProposal["effectiveRegion"];
  changedInstanceIds: string[];
  changedTileIds: string[];
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function failure(e: unknown): Result<never> {
  return {
    ok: false,
    issues: [
      {
        code:
          e instanceof DOMException && e.name === "AbortError"
            ? "cancelled"
            : /budget/i.test(String(e))
              ? "budget"
              : "patch-scope",
        path: "patch",
        message: e instanceof Error ? e.message : String(e),
      },
    ],
  };
}
function capture(
  baseInput: SceneSnapshot,
  patchInput: ScenePatch,
  library: AssetLibrary,
  context: PatchContext,
) {
  const parsed = parseSnapshot(baseInput);
  if (parsed.capability !== "editable")
    throw Error(
      "Legacy snapshots are read-only and cannot compile local edits",
    );
  const patch = parsePatch(patchInput),
    ctx = parseCompileContext({
      ...context,
      intent: parsed.intent,
      modelEvidence: parsed.modelEvidence,
      camera: parsed.camera,
      patch,
      baseSnapshot: parsed,
    });
  ctx.signal.throwIfAborted();
  const bytes = buildOwnedBytes(parsed);
  if (
    4 * bytes + 8 * 1024 ** 2 > L.maxCandidateCpuBytes ||
    ctx.resources.retainedBytes + 3 * bytes + 8 * 1024 ** 2 >
      L.maxTransitionBytes
  )
    throw Error("Patch capture budget exceeded before allocation");
  const base = structuredClone(parsed),
    stable = makeAssetLibrary(
      {
        digest: library.digest,
        manifests: library.manifests,
        styles: library.styles,
      },
      library.resolveMember,
    );
  if (stable.digest !== base.plan.catalogDigest)
    throw Error("Patch original catalog binding changed");
  return {
    base,
    patch,
    library: stable,
    ctx: {
      ...ctx,
      baseSnapshot: base,
      resources: { retainedBytes: ctx.resources.retainedBytes + bytes },
    },
  };
}
type CapturedPatch = ReturnType<typeof capture>;
type InFlightPatch = { identity: string; promise: Promise<Result<unknown>> };
const inFlight = new WeakMap<BuildClient, InFlightPatch>();
/** One operation per client, before any large capture. A cancelled public result
 * does not release the fence while the client's actual preparation owns buffers. */
function executePatch<T>(
  kind: "propose" | "preview",
  base: SceneSnapshot,
  patch: ScenePatch,
  library: AssetLibrary,
  context: PatchContext,
  client: BuildClient,
  work: (c: CapturedPatch) => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    if (base.capability !== "editable")
      throw Error(
        "Legacy snapshots are read-only and cannot compile local edits",
      );
    context.signal.throwIfAborted();
    const identity = canonicalJson({
      kind,
      patch: parsePatch(patch),
      catalog: library.digest,
      sceneId: base.sceneId,
      baseRevisionId: base.revisionId,
      geometryDigest: base.geometryDigest,
      plan: base.plan,
      state: base.state,
      operationId: context.operationId,
      revisionId: context.revisionId,
      contextBase: context.baseRevisionId,
      contextScene: context.sceneId,
    });
    const prior = inFlight.get(client);
    if (prior)
      return prior.identity === identity
        ? (prior.promise as Promise<Result<T>>)
        : Promise.resolve(
            failure(
              Error(
                "Another patch operation is active or awaiting actual cleanup",
              ),
            ),
          );
    if (client.activity().busy)
      return Promise.resolve(
        failure(
          Error("Build client is busy or awaiting actual preparation cleanup"),
        ),
      );
    const c = capture(base, patch, library, context);
    const release = () => {
      if (inFlight.get(client) === current) inFlight.delete(client);
    };
    const promise = (async () => {
      try {
        return await work(c);
      } catch (e) {
        return failure(e);
      }
    })().then((result) => {
      // Successful stages must release before the caller's next await continuation.
      // Cancellation can finish publicly while preparation still owns buffers.
      if (!client.activity().preparing) release();
      else void client.whenPreparationSettled().then(release);
      return result;
    });
    const current = { identity, promise };
    inFlight.set(client, current);
    return promise;
  } catch (e) {
    return Promise.resolve(failure(e));
  }
}
/** Produces review data only. No Gaussian build, display activation or durable write. */
export function proposePatch(
  base: SceneSnapshot,
  patch: ScenePatch,
  library: AssetLibrary,
  context: PatchContext,
  client: BuildClient,
): Promise<Result<PatchProposal>> {
  return executePatch(
    "propose",
    base,
    patch,
    library,
    context,
    client,
    async (c) => {
      const out = await client.propose(c.base, c.patch, c.library, c.ctx);
      c.ctx.signal.throwIfAborted();
      if (
        out.ok &&
        (!same(out.value.patch.operations, c.patch.operations) ||
          out.value.patch.raw !== c.patch.raw ||
          !same(out.value.patch.lockedInstanceIds, c.patch.lockedInstanceIds) ||
          out.value.patch.patchId !== c.patch.patchId)
      )
        throw Error("Operation identity reused for a different proposal");
      return out;
    },
  );
}
/** Scope acceptance is separate from using/saving a visible scene. The existing
 * compiler independently rederives this proposal from the actual parent. */
export function previewPatch(
  base: SceneSnapshot,
  patch: ScenePatch,
  library: AssetLibrary,
  context: PatchContext,
  client: BuildClient,
): Promise<Result<PatchPreview>> {
  return executePatch(
    "preview",
    base,
    patch,
    library,
    context,
    client,
    async (c) => {
      if (!c.patch.review.scopeAccepted)
        throw Error("Patch scope has not been accepted");
      const proposed = await client.propose(c.base, c.patch, c.library, c.ctx);
      c.ctx.signal.throwIfAborted();
      if (!proposed.ok) return proposed;
      const p = proposed.value;
      if (
        !same(c.patch, {
          ...p.patch,
          review: { ...p.patch.review, scopeAccepted: true },
        })
      )
        throw Error(
          "Accepted patch no longer matches the concrete proposal; review the new scope",
        );
      // Preflight the whole nested resolve/proposal residency, including our retained
      // parent capture. Passing that capture as external residency cannot erase it
      // from the single-operation candidate cap.
      const dependencyRefs = [
        ...new Map([
          ...c.base.assets.map(
            (a) => [canonicalJson(a.assetRef), a.assetRef] as const,
          ),
          ...p.state.overrides.flatMap((o) =>
            o.assetRef
              ? [[canonicalJson(o.assetRef), o.assetRef] as const]
              : [],
          ),
          ...p.patch.operations.flatMap((o) =>
            o.kind === "add" || o.kind === "replace"
              ? [[canonicalJson(o.assetRef), o.assetRef] as const]
              : [],
          ),
        ]).values(),
      ];
      const preLayouts = dependencyRefs.map((ref) => {
        const m = c.library.manifests.find(
          (m) => m.id === ref.id && m.contentVersion === ref.contentVersion,
        );
        if (!m) throw Error("Missing exact proposal dependency");
        return assertAssetLayout(m);
      });
      const preRaw = preLayouts.reduce((n, l) => n + l.sourceBytes, 0),
        preDecoded = preLayouts.reduce((n, l) => n + l.decodedBytes, 0),
        prePeak =
          4 * buildOwnedBytes(c.base) +
          4 * preRaw +
          2 * preDecoded +
          8 * 1024 ** 2 +
          8 * L.maxHeightNodes * 64;
      if (
        prePeak > L.maxCandidateCpuBytes ||
        c.ctx.resources.retainedBytes + prePeak > L.maxTransitionBytes
      )
        throw Error("Patch resolve budget exceeded before nested allocation");
      const resolved = await client.resolve(p.plan, p.state, c.library, {
        ...c.ctx,
        resources: {
          retainedBytes:
            c.ctx.resources.retainedBytes + buildOwnedBytes(c.base),
        },
        dependencies: { patch: c.patch, baseSnapshot: c.base },
      });
      c.ctx.signal.throwIfAborted();
      if (!resolved.ok) return resolved;
      const r = resolved.value,
        operationLibrary = client.operationLibrary(c.ctx.operationId);
      if (!operationLibrary) throw Error("Missing frozen operation library");
      const refs = new Map(
        r.sourceEvidence.members.map((m) => [
          canonicalJson(m.assetRef),
          m.assetRef,
        ]),
      );
      const layouts = [...refs.values()].map((ref) => {
        const m = r.catalog.manifests.find(
          (m) => m.id === ref.id && m.contentVersion === ref.contentVersion,
        );
        if (!m) throw Error("Missing exact proposal dependency");
        return assertAssetLayout(m);
      });
      const decoded = layouts.reduce((n, l) => n + l.decodedBytes, 0),
        raw = layouts.reduce((n, l) => n + l.sourceBytes, 0),
        held = buildOwnedBytes({ base: c.base, r }),
        reserve =
          decoded +
          raw +
          3 * Math.max(0, ...layouts.map((l) => l.maxMemberBytes)) +
          8 * 1024 ** 2;
      if (
        held + reserve > L.maxCandidateCpuBytes ||
        c.ctx.resources.retainedBytes + held + reserve > L.maxTransitionBytes
      )
        throw Error("Patch asset decode budget exceeded before allocation");
      const assets: LoadedAsset[] = [];
      for (const ref of refs.values()) {
        assets.push(await loadAsset(ref, operationLibrary, c.ctx.signal));
        c.ctx.signal.throwIfAborted();
      }
      const objects = p.instances.reduce((n, i) => {
          const m = assets.find(
            (a) =>
              a.manifest.id === i.assetRef.id &&
              a.manifest.contentVersion === i.assetRef.contentVersion,
          )!.manifest;
          return (
            n + Math.max(m.gaussian.full.points, m.gaussian.coarse?.points ?? 0)
          );
        }, 0),
        terrainPoints =
          p.plan.terrain.source === "patch"
            ? assets
                .filter((a) => a.manifest.kind === "patch")
                .reduce(
                  (n, a) =>
                    n +
                    Math.max(
                      a.manifest.gaussian.full.points,
                      a.manifest.gaussian.coarse?.points ?? 0,
                    ),
                  0,
                )
            : 0,
        surfacePoints = r.style
          ? Math.max(0, L.maxWorstSplats - objects - terrainPoints)
          : 0,
        buildPeak =
          4 * buildOwnedBytes({ base: c.base, r, assets }) +
          surfacePoints * 60 * 3 +
          8 * 1024 ** 2 +
          3 * surfacePoints * 56;
      if (
        buildPeak > L.maxCandidateCpuBytes ||
        c.ctx.resources.retainedBytes + buildPeak > L.maxTransitionBytes
      )
        throw Error(
          "Patch build budget exceeded before worker copies and surface workspace",
        );
      const compiled = await client.build(r, p.state, assets, {
        ...c.ctx,
        patch: c.patch,
        baseSnapshot: c.base,
      });
      c.ctx.signal.throwIfAborted();
      if (!compiled.ok) return compiled;
      return {
        ok: true,
        value: {
          compiled: compiled.value,
          requestedRegion: p.requestedRegion,
          effectiveRegion: p.effectiveRegion,
          changedInstanceIds: p.changedInstanceIds,
          changedTileIds: p.changedTileIds,
        },
      };
    },
  );
}
