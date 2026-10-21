import BuildWorker from "./build.worker.ts?worker&inline";
import { makeAssetLibrary, type AssetLibrary } from "./asset-library";
import type { LoadedAsset } from "./asset-loader";
import {
  acquireBuildInputs,
  buildOwnedBytes,
  type ResolvedPlan,
  type CompiledScene,
  type ResolveDependencies,
  type PatchProposal,
} from "./compile";
import {
  parseSnapshot,
  parsePatch,
  parseScenePlan,
  parsePlanDraft,
  parseEditableState,
  type BuildResourceContext,
  type EditableSnapshot,
  type ScenePatch,
  type RevisionContext,
  type CompileContext,
  type EditableState,
  type OperationContext,
  type PlanDraft,
} from "./contracts";
import { GENERAL_LIMITS as L, type Result } from "./core";
import type { BuildMessage } from "./build.worker";
import { canonicalJson } from "./canonical";
export type BuildClient = {
  propose(
    base: EditableSnapshot,
    patch: ScenePatch,
    library: AssetLibrary,
    ctx: RevisionContext & { resources: BuildResourceContext },
  ): Promise<Result<PatchProposal>>;
  resolve(
    draft: PlanDraft,
    state: EditableState,
    library: AssetLibrary,
    ctx: OperationContext & {
      resources: BuildResourceContext;
      dependencies?: ResolveDependencies;
    },
  ): Promise<Result<ResolvedPlan>>;
  build(
    resolved: ResolvedPlan,
    state: EditableState,
    assets: LoadedAsset[],
    ctx: CompileContext,
  ): Promise<Result<CompiledScene>>;
  /** Actual preparation residency, including cancelled fetch/decode that has not settled. */
  activity(): { busy: boolean; preparing: boolean };
  whenPreparationSettled(): Promise<void>;
  cancel(operationId: string): void;
  operationLibrary(operationId: string): AssetLibrary | null;
  dispose(): void;
};
const failed = (code: string, message: string): Result<never> => ({
  ok: false,
  issues: [{ code, path: "worker", message }],
});
function transfers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>(),
    seen = new Set<object>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (!(v.buffer instanceof ArrayBuffer)) throw Error("Shared buffer");
      buffers.add(v.buffer);
      return;
    }
    if (v instanceof Map) {
      v.forEach(visit);
      return;
    }
    Object.values(v).forEach(visit);
  };
  visit(value);
  return [...buffers];
}
export function createBuildClient(): BuildClient {
  type Active = {
    operationId: string;
    baseRevisionId: string | null;
    kind: "resolve" | "build" | "propose";
    generation: number;
    identity?: string;
    abort: AbortController;
    promise: Promise<Result<any>>;
    finish: (result: Result<any>) => void;
    timer: ReturnType<typeof setTimeout>;
    removeAbort: () => void;
    worker: Worker | null;
    settled: Promise<void>;
    settle(): void;
  };
  let active: Active | null = null,
    preparing: Active | null = null,
    disposed = false,
    generation = 0;
  let retainedLibrary: { operationId: string; library: AssetLibrary } | null =
    null;
  function stop(result: Result<unknown>, expected: Active | null = active) {
    const current = active;
    if (!current || current !== expected) return;
    active = null;
    clearTimeout(current.timer);
    current.removeAbort();
    current.abort.abort();
    if (current.worker) {
      current.worker.onmessage = null;
      current.worker.onerror = null;
      current.worker.terminate();
    }
    current.finish(result);
  }
  function gate(
    kind: Active["kind"],
    ctx: OperationContext,
    identity?: string,
  ): Promise<Result<any>> | null {
    if (disposed)
      return Promise.resolve(failed("disposed", "Build client is disposed"));
    if (ctx.signal.aborted)
      return Promise.resolve(
        failed("cancelled", "Operation already cancelled"),
      );
    if (active) {
      if (
        active.operationId === ctx.operationId &&
        active.baseRevisionId === ctx.baseRevisionId &&
        active.kind === kind
      )
        return active.identity === identity
          ? active.promise
          : Promise.resolve(
              failed(
                "operation-conflict",
                "Operation identity reused for different input",
              ),
            );
      return Promise.resolve(
        failed("busy", "Another build transaction is active"),
      );
    }
    if (preparing)
      return Promise.resolve(
        failed(
          "cleanup-pending",
          "Cancelled preparation still owns buffers; wait for its actual cleanup",
        ),
      );
    return null;
  }
  function run<T>(
    kind: Active["kind"],
    ctx: OperationContext & { resources: BuildResourceContext },
    payload: (
      signal: AbortSignal,
      resources: BuildResourceContext,
    ) => Promise<BuildMessage["payload"]>,
    identity?: string,
  ): Promise<Result<T>> {
    ctx = {
      operationId: ctx.operationId,
      baseRevisionId: ctx.baseRevisionId,
      signal: ctx.signal,
      resources: { retainedBytes: ctx.resources.retainedBytes },
    };
    const gated = gate(kind, ctx, identity);
    if (gated) return gated;
    let finish!: (r: Result<T>) => void;
    const promise = new Promise<Result<T>>((resolve) => (finish = resolve)),
      abort = new AbortController(),
      g = ++generation;
    const cancel = () =>
      stop(failed("cancelled", "Operation cancelled"), current);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const current: Active = {
      operationId: ctx.operationId,
      baseRevisionId: ctx.baseRevisionId,
      kind,
      generation: g,
      identity,
      abort,
      promise,
      finish,
      timer: setTimeout(
        () =>
          stop(
            failed("timeout", "Build exceeded the 10-second hard deadline"),
            current,
          ),
        L.maxCpuBuildMs,
      ),
      removeAbort: () => ctx.signal.removeEventListener("abort", cancel),
      worker: null,
      settled,
      settle,
    };
    active = current;
    preparing = current;
    ctx.signal.addEventListener("abort", cancel, { once: true });
    void (async () => {
      try {
        const prepared = await payload(abort.signal, ctx.resources);
        if (active !== current || abort.signal.aborted) return;
        const own = buildOwnedBytes(prepared);
        if (
          own * 2 > L.maxCandidateCpuBytes ||
          ctx.resources.retainedBytes + own * 3 + 8 * 1024 ** 2 >
            L.maxTransitionBytes
        )
          throw Error("Worker transfer exceeds application byte budget");
        const copied = structuredClone(prepared);
        if ("inputs" in copied)
          copied.resources = {
            retainedBytes: ctx.resources.retainedBytes + own,
          };
        else
          copied.context.resources = {
            retainedBytes: ctx.resources.retainedBytes + own,
          };
        // The shipped worker is bundled with this module, so cancellation can
        // terminate it and the next operation can still start while offline.
        const worker = new BuildWorker();
        current.worker = worker;
        worker.onmessage = (event) => {
          const reply = event.data;
          if (
            active !== current ||
            ctx.signal.aborted ||
            abort.signal.aborted ||
            reply?.kind !== "result" ||
            reply.operationId !== current.operationId ||
            reply.baseRevisionId !== current.baseRevisionId ||
            reply.generation !== current.generation
          )
            return;
          try {
            if (!reply.result || typeof reply.result.ok !== "boolean")
              throw Error("Malformed Worker result");
            if (reply.result.ok) {
              if (kind === "build") {
                const snapshot = parseSnapshot(reply.result.value.snapshot);
                if (
                  snapshot.capability !== "editable" ||
                  snapshot.operationId !== ctx.operationId ||
                  snapshot.parentRevisionId !== ctx.baseRevisionId ||
                  !("context" in copied) ||
                  snapshot.revisionId !== copied.context.revisionId ||
                  snapshot.sceneId !== copied.context.sceneId
                )
                  throw Error("Returned snapshot operation/base mismatch");
              } else if (kind === "propose") {
                const proposal = reply.result.value,
                  patch = parsePatch(proposal.patch);
                parseScenePlan(proposal.plan);
                parseEditableState(proposal.state);
                if (
                  patch.review.scopeAccepted ||
                  patch.baseRevisionId !== ctx.baseRevisionId ||
                  !("base" in copied) ||
                  copied.base.sceneId !== copied.context.sceneId ||
                  patch.patchId !== copied.patch.patchId
                )
                  throw Error("Returned proposal operation/base mismatch");
              } else if (
                reply.result.value.version !== 1 ||
                !reply.result.value.geometry
              )
                throw Error("Malformed resolved result");
            } else if (
              !Array.isArray(reply.result.issues) ||
              !reply.result.issues.length
            )
              throw Error("Malformed Worker failure");
            stop(reply.result, current);
          } catch (e) {
            stop(
              failed(
                "worker-protocol",
                e instanceof Error ? e.message : "Worker protocol failed",
              ),
              current,
            );
          }
        };
        worker.onerror = (event) => {
          if (active === current)
            stop(
              failed("worker", event.message || "Worker execution failed"),
              current,
            );
        };
        worker.postMessage(
          {
            kind,
            operationId: ctx.operationId,
            baseRevisionId: ctx.baseRevisionId,
            generation: g,
            payload: copied,
          },
          transfers(copied),
        );
      } catch (e) {
        if (active === current)
          stop(
            failed(
              abort.signal.aborted
                ? "cancelled"
                : /budget/i.test(String(e))
                  ? "budget"
                  : "worker-input",
              e instanceof Error ? e.message : "Worker request failed",
            ),
            current,
          );
      } finally {
        if (preparing === current) preparing = null;
        current.settle();
      }
    })();
    return promise;
  }
  return {
    propose(inputBase, inputPatch, library, ctx) {
      const patch = parsePatch(inputPatch),
        context = {
          operationId: ctx.operationId,
          baseRevisionId: ctx.baseRevisionId,
          sceneId: ctx.sceneId,
          revisionId: ctx.revisionId,
        },
        identity = canonicalJson({
          context,
          patch,
          baseGeometry: inputBase.geometryDigest,
          catalog: library.digest,
        }),
        gated = gate("propose", ctx, identity);
      if (gated) return gated;
      const bytes = buildOwnedBytes(inputBase);
      if (
        bytes * 2 > L.maxCandidateCpuBytes ||
        ctx.resources.retainedBytes + bytes * 3 + 8 * 1024 ** 2 >
          L.maxTransitionBytes
      )
        return Promise.resolve(
          failed("budget", "Owned proposal capture exceeds budget"),
        );
      const base = structuredClone(inputBase),
        stable = makeAssetLibrary(
          {
            digest: library.digest,
            manifests: library.manifests,
            styles: library.styles,
          },
          library.resolveMember,
        ),
        operationId = ctx.operationId;
      return run(
        "propose",
        {
          ...ctx,
          resources: { retainedBytes: ctx.resources.retainedBytes + bytes },
        },
        async (signal, resources) => {
          const inputs = await acquireBuildInputs(
            base.plan,
            base.state,
            stable,
            signal,
            { retainedBytes: resources.retainedBytes + bytes },
            { patch, baseSnapshot: base },
          );
          signal.throwIfAborted();
          retainedLibrary = { operationId, library: stable };
          return { base, patch, inputs, context, resources };
        },
        identity,
      );
    },
    resolve(draft, state, library, ctx) {
      draft = parsePlanDraft(draft);
      state = parseEditableState(state);
      const stable = makeAssetLibrary(
          {
            digest: library.digest,
            manifests: library.manifests,
            styles: library.styles,
          },
          library.resolveMember,
        ),
        operationId = ctx.operationId;
      return run("resolve", ctx, async (signal, resources) => {
        const inputs = await acquireBuildInputs(
          draft,
          state,
          stable,
          signal,
          resources,
          ctx.dependencies,
        );
        signal.throwIfAborted();
        retainedLibrary = { operationId, library: stable };
        return {
          draft: structuredClone(draft),
          state: structuredClone(state),
          inputs,
          resources,
        };
      });
    },
    build(resolved, state, assets, ctx) {
      const { signal: _, ...context } = ctx;
      const input = { resolved, state, assets, context },
        bytes = buildOwnedBytes(input);
      if (
        bytes * 2 > L.maxCandidateCpuBytes ||
        ctx.resources.retainedBytes + bytes * 3 + 8 * 1024 ** 2 >
          L.maxTransitionBytes
      )
        return Promise.resolve(
          failed("budget", "Owned build capture exceeds budget"),
        );
      return run(
        "build",
        {
          ...ctx,
          resources: { retainedBytes: ctx.resources.retainedBytes + bytes },
        },
        async () => structuredClone(input),
      );
    },
    activity() {
      return {
        busy: active !== null || preparing !== null,
        preparing: preparing !== null,
      };
    },
    whenPreparationSettled() {
      return preparing?.settled ?? Promise.resolve();
    },
    cancel(operationId) {
      if (active?.operationId === operationId)
        stop(failed("cancelled", "Operation cancelled"));
    },
    operationLibrary(operationId) {
      return retainedLibrary?.operationId === operationId
        ? retainedLibrary.library
        : null;
    },
    dispose() {
      disposed = true;
      retainedLibrary = null;
      stop(failed("disposed", "Build client disposed"));
    },
  };
}
