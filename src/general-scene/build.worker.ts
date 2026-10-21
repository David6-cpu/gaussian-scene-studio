import {
  compileScene,
  proposePreparedPatch,
  resolvePreparedPlan,
  type BuildInputs,
  type ResolvedPlan,
} from "./compile";
import type { LoadedAsset } from "./asset-loader";
import type {
  BuildResourceContext,
  EditableSnapshot,
  ScenePatch,
  RevisionContext,
  EditableState,
  PlanDraft,
  WorkerCompileContext,
} from "./contracts";
export type BuildMessage = {
  operationId: string;
  baseRevisionId: string | null;
  generation: number;
} & (
  | {
      kind: "resolve";
      payload: {
        draft: PlanDraft;
        state: EditableState;
        inputs: BuildInputs;
        resources: BuildResourceContext;
      };
    }
  | {
      kind: "propose";
      payload: {
        base: EditableSnapshot;
        patch: ScenePatch;
        inputs: BuildInputs;
        context: Omit<RevisionContext, "signal">;
        resources: BuildResourceContext;
      };
    }
  | {
      kind: "build";
      payload: {
        resolved: ResolvedPlan;
        state: EditableState;
        assets: LoadedAsset[];
        context: WorkerCompileContext;
      };
    }
);
/** Transfer only exclusively owned outputs; no current/main/cache buffer crosses this boundary. */
export function transferBuffers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>(),
    seen = new Set<object>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (!(v.buffer instanceof ArrayBuffer))
        throw Error("Shared buffer is unsupported");
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
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BuildMessage>) => void) | null;
  postMessage: (value: unknown, transfer: Transferable[]) => void;
};
// Worker module is never imported as executable code by the main application.
scope.onmessage = async (event) => {
  const message = event.data,
    signal = new AbortController().signal;
  if (
    !message ||
    !["resolve", "build", "propose"].includes(message.kind) ||
    typeof message.operationId !== "string" ||
    !message.operationId ||
    (message.baseRevisionId !== null &&
      typeof message.baseRevisionId !== "string") ||
    !Number.isSafeInteger(message.generation) ||
    message.generation < 1
  )
    return;
  let result;
  try {
    if (message.kind === "resolve") {
      const p = message.payload;
      result = await resolvePreparedPlan(
        p.draft,
        p.state,
        p.inputs,
        signal,
        p.resources,
      );
    } else if (message.kind === "propose") {
      const p = message.payload;
      if (
        p.context.operationId !== message.operationId ||
        p.context.baseRevisionId !== message.baseRevisionId
      )
        throw Error("Worker proposal envelope/context identity mismatch");
      result = await proposePreparedPatch(p.base, p.patch, p.inputs, {
        ...p.context,
        resources: p.resources,
        signal,
      });
    } else {
      const p = message.payload;
      if (
        p.context.operationId !== message.operationId ||
        p.context.baseRevisionId !== message.baseRevisionId
      )
        throw Error("Worker envelope/context identity mismatch");
      result = await compileScene(p.resolved, p.state, p.assets, {
        ...p.context,
        operationId: message.operationId,
        baseRevisionId: message.baseRevisionId,
        signal,
      });
    }
  } catch (error) {
    result = {
      ok: false,
      issues: [
        {
          code: "worker",
          path: "worker",
          message: error instanceof Error ? error.message : "Worker failed",
        },
      ],
    };
  }
  scope.postMessage(
    {
      kind: "result",
      operationId: message.operationId,
      baseRevisionId: message.baseRevisionId,
      generation: message.generation,
      result,
    },
    transferBuffers(result),
  );
};
