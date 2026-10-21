import { record } from "../data-validation";
import { canonicalJson, documentDigest } from "./canonical";
import {
  makeAssetLibrary,
  type AssetLibrary,
  type CatalogView,
} from "./asset-library";
import { loadAsset, type LoadedAsset } from "./asset-loader";
import { assertAssetLayout } from "./asset-package";
import { GENERAL_LIMITS as L, type Result, type Issue } from "./core";
import {
  parseIntent,
  parsePlanDraft,
  parseEditableState,
  parseModelEvidence,
  parsePatch,
  parseSnapshot,
  type SceneIntent,
  type PlanDraft,
  type EditableState,
  type SceneSnapshot,
  type EditableSnapshot,
  type LegacySnapshot,
  type ScenePatch,
  type CompileContext,
} from "./contracts";
import {
  parsePlanningRequest,
  type PlanningRequest,
  type PlanningOutcome,
  type PlanningPhase,
} from "./planner";
import {
  validateBuildSemantics,
  storedResultsToRenderPacket,
  type ResolvedPlan,
  type CompiledScene,
  type PatchProposal,
} from "./compile";
import {
  proposePatch as proposeLocalPatch,
  previewPatch as previewLocalPatch,
  type PatchPreview,
} from "./patch";
import type { BuildClient } from "./worker-client";
import type { SceneStore, StageRef, CommitReceipt } from "./storage";
import {
  decodeGeneralArchive,
  encodeGeneralArchive,
  metadataWorkspace,
  type ImportedScene,
} from "./archive";
import { sourceOwnedBytes } from "./render/source-bank";
import {
  sparkSceneCapacity,
  sparkRendererBudget,
} from "../gaussian/spark-budget";
import type { GeneralView, GeneralSwap, RenderPacket } from "./render/types";
export type Residency = {
  buffers: readonly ArrayBuffer[];
  extraBytes: number;
  settled: boolean;
};
export type SceneDisplayHost = {
  current(): GeneralView;
  views(): readonly GeneralView[];
  waitForDisplayed(
    view: GeneralView,
    swap: GeneralSwap,
    signal: AbortSignal,
  ): Promise<void>;
  replace(signal: AbortSignal): Promise<GeneralView>;
  showLegacy(snapshot: LegacySnapshot, signal: AbortSignal): Promise<void>;
};
export type SceneControllerPorts = {
  planner(
    request: PlanningRequest,
    signal: AbortSignal,
    phase: (phase: PlanningPhase) => void,
  ): Promise<PlanningOutcome>;
  buildClient: BuildClient;
  store: SceneStore;
  library(signal: AbortSignal): Promise<AssetLibrary>;
  display: SceneDisplayHost;
  externalResidency(): Residency;
};
export type SavedReceipt = CommitReceipt & {
  displayStatus: "ready" | "recovering";
};
type Identity = {
  operationId: string;
  sceneId: string;
  revisionId: string;
  baseRevisionId: string | null;
};
type Summary = {
  sceneId: string;
  revisionId: string;
  capability: SceneSnapshot["capability"];
  reviewStatus: SceneSnapshot["reviewStatus"];
  quality: SceneSnapshot["quality"];
  access: "editable" | "readonly";
  issues: readonly Issue[];
};
type Finalization =
  | { kind: "none" }
  | { kind: "cleanup-pending"; operation: Identity | null }
  | {
      kind: "commit-pending";
      operation: Identity;
      cleanup: "pending" | "settled";
    };
type Common = {
  current: Summary | null;
  planning: PlanningOutcome | null;
  lastSave: SavedReceipt | null;
  issues: readonly Issue[];
  finalization: Finalization;
};
type StateBody =
  | { phase: "idle" }
  | { phase: PlanningPhase | "requesting"; operation: Identity }
  | {
      phase: "awaiting-review";
      operation: Identity;
      draft: PlanDraft | null;
      proposal: PatchProposal | null;
    }
  | {
      phase: "building";
      operation: Identity;
      stage:
        | "resolve"
        | "load"
        | "build"
        | "display"
        | "restore"
        | "import"
        | "export";
    }
  | {
      phase: "previewing";
      operation: Identity;
      candidate: Summary;
      proposal: PatchProposal | null;
    }
  | { phase: "saving"; operation: Identity; stage: "staging" | "commit" }
  | { phase: "committed"; receipt: SavedReceipt }
  | { phase: "failed"; operation: Identity | null };
export type ControllerState = Common & StateBody;
export type ManualReview = { kind: "manual-intent"; intent: SceneIntent };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const errorIssues = (e: unknown): Issue[] => [
  {
    code:
      e instanceof DOMException && e.name === "AbortError"
        ? "cancelled"
        : /budget|bytes|memory/i.test(String(e))
          ? "budget"
          : "transaction",
    path: "controller",
    message: e instanceof Error ? e.message : String(e),
  },
];
const fail = (e: unknown): { ok: false; issues: Issue[] } => ({
  ok: false,
  issues: errorIssues(e),
});
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new IssuesError(r.issues);
  return r.value;
};
class IssuesError extends Error {
  constructor(readonly issues: Issue[]) {
    super(issues.map((i) => i.message).join("; "));
  }
}
const failure = (e: unknown): { ok: false; issues: Issue[] } =>
  e instanceof IssuesError ? { ok: false, issues: e.issues } : fail(e);
const bytes = (b: readonly ArrayBuffer[]) =>
  b.reduce((n, x) => n + x.byteLength, 0);
/** A view and a subarray retain their complete backing, exactly once by identity. */
export function collectBuffers(roots: readonly unknown[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>(),
    seen = new Set<object>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof ArrayBuffer) {
      out.add(v);
      return;
    }
    if (ArrayBuffer.isView(v)) {
      if (!(v.buffer instanceof ArrayBuffer))
        throw Error("Shared buffers are unsupported");
      out.add(v.buffer);
      return;
    }
    if (v instanceof Map) {
      v.forEach(visit);
      return;
    }
    if (v instanceof Set) {
      v.forEach(visit);
      return;
    }
    for (const x of Object.values(v)) visit(x);
  };
  roots.forEach(visit);
  return [...out];
}
function parseOutcome(
  value: unknown,
  request: PlanningRequest,
): PlanningOutcome {
  const raw = record(value, [
    "ok",
    "request",
    "query",
    "inputs",
    ...(typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === true
      ? ["value"]
      : ["issues", "partial", "mode"]),
  ]);
  if (
    typeof raw.ok !== "boolean" ||
    !same(parsePlanningRequest(raw.request), request) ||
    !Array.isArray(raw.inputs)
  )
    throw Error("Planner outcome request binding");
  const payload = record(raw.ok ? raw.value : raw.partial, [
    "intent",
    "draft",
    "evidence",
  ]);
  if (raw.ok || payload.intent !== null) parseIntent(payload.intent);
  if (raw.ok || payload.draft !== null) parsePlanDraft(payload.draft);
  if (!Array.isArray(payload.evidence)) throw Error("Planner evidence");
  payload.evidence.forEach(parseModelEvidence);
  if (!raw.ok && (!Array.isArray(raw.issues) || raw.mode !== "manual"))
    throw Error("Planner failure shape");
  return value as PlanningOutcome;
}
/** Existing same-origin server only. Stream phases describe actual work, never timers. */
export function createBrowserPlanner(
  fetcher: typeof fetch = fetch,
): SceneControllerPorts["planner"] {
  return async (value, signal, phase) => {
    const request = parsePlanningRequest(value),
      response = await fetcher("/api/planner/general/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify(request),
        signal,
      });
    if (!response.ok) throw Error(`Planner HTTP ${response.status}`);
    if (!response.body) throw Error("Missing planner response");
    const reader = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      total = 0,
      step = 0,
      final: PlanningOutcome | undefined;
    const stream =
      response.headers.get("content-type")?.split(";")[0].trim() ===
      "application/x-ndjson";
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const line = (s: string) => {
      if (!s.trim()) throw Error("Empty planner stream record");
      if (final) throw Error("Record after final outcome");
      const v = JSON.parse(s),
        r = record(
          v,
          v?.type === "phase"
            ? ["type", "operationId", "baseRevisionId", "phase"]
            : ["type", "operationId", "baseRevisionId", "outcome"],
        );
      if (
        r.operationId !== request.operationId ||
        r.baseRevisionId !== request.baseRevisionId
      )
        throw Error("Stream operation/base binding");
      if (r.type === "phase") {
        const expected = ["parsing", "querying", "planning"][step++];
        if (r.phase !== expected) throw Error("Planner phase order");
        phase(r.phase as PlanningPhase);
      } else if (r.type === "final") {
        final = parseOutcome(r.outcome, request);
        if (final.ok && step !== 3)
          throw Error("Successful final before real phases");
      } else throw Error("Unknown stream record");
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value: chunk } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        total += chunk.byteLength;
        if (total > L.maxJsonBytes)
          throw Error("Planner response exceeds 2 MiB");
        text += decoder.decode(chunk, { stream: true });
        if (stream) {
          let end: number;
          while ((end = text.indexOf("\n")) >= 0) {
            line(text.slice(0, end));
            text = text.slice(end + 1);
          }
        }
      }
      text += decoder.decode();
      if (stream) {
        if (text.length) throw Error("Truncated final stream record");
        if (!final) throw Error("Missing final planner outcome");
        return final;
      }
      return parseOutcome(JSON.parse(text), request);
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
}
type Current = {
  snapshot: SceneSnapshot;
  library: AssetLibrary | null;
  assets: LoadedAsset[];
  render: RenderPacket | null;
  ownership?: ImportedScene["ownership"];
  sourceRevisionId?: string;
  access: "editable" | "readonly";
  issues: Issue[];
};
type Operation = Identity & {
  abort: AbortController;
  request?: PlanningRequest;
  intent?: SceneIntent;
  manualIntent?: boolean;
  catalogMode: "live" | "fixed";
  publicationBase?: string | null;
  evidence: CompileContext["modelEvidence"];
  state: EditableState;
  library?: AssetLibrary;
  resolved?: ResolvedPlan;
  resolvedDigest?: string;
  compiled?: CompiledScene;
  assets: LoadedAsset[];
  roots: unknown[];
  ownership?: ImportedScene["ownership"];
  swap?: GeneralSwap;
  view?: GeneralView;
  stage?: StageRef;
  commitStarted: boolean;
  saved: boolean;
  peak: number;
  proposal?: PatchProposal;
  restore?: Current;
};
const emptyState = () =>
  parseEditableState({
    documentType: "general-scene-editable-state",
    schemaVersion: 1,
    groups: [],
    tombstones: [],
    lockedInstanceIds: [],
    overrides: [],
    brushes: [],
    affectedRegions: [],
    deduplications: [],
  });
export function createSceneController(ports: SceneControllerPorts) {
  let current: Current | null = null,
    active: Operation | null = null,
    planning: PlanningOutcome | null = null,
    lastSave: SavedReceipt | null = null,
    issues: Issue[] = [],
    stateBody: StateBody = { phase: "idle" },
    committing: Operation | null = null;
  const operations = new Set<Operation>(),
    tasks = new Set<Promise<unknown>>(),
    listeners = new Set<(s: ControllerState) => void>();
  const requests = new Map<
      string,
      { key: string; promise: Promise<PlanningOutcome> }
    >(),
    uses = new Map<string, Promise<Result<SavedReceipt>>>();
  const views = () => [...new Set(ports.display.views())];
  const identity = (o: Operation): Identity => ({
    sceneId: o.sceneId,
    revisionId: o.revisionId,
    operationId: o.operationId,
    baseRevisionId: o.baseRevisionId,
  });
  const summary = (
    s: SceneSnapshot,
    access: "editable" | "readonly" = "editable",
    why: Issue[] = [],
  ): Summary => ({
    sceneId: s.sceneId,
    revisionId: s.revisionId,
    capability: s.capability,
    reviewStatus: s.reviewStatus,
    quality: s.quality,
    access,
    issues: why,
  });
  const settled = () =>
    tasks.size === 0 &&
    !ports.buildClient.activity().busy &&
    views().every((v) => !v.activity().preparing) &&
    committing === null;
  function getState(): ControllerState {
    const clean = settled(),
      finalization: Finalization = committing
        ? {
            kind: "commit-pending",
            operation: identity(committing),
            cleanup: clean ? "settled" : "pending",
          }
        : !clean
          ? {
              kind: "cleanup-pending",
              operation: active ? identity(active) : null,
            }
          : { kind: "none" };
    return {
      ...stateBody,
      current: current
        ? summary(current.snapshot, current.access, current.issues)
        : null,
      planning,
      lastSave,
      issues,
      finalization,
    } as ControllerState;
  }
  function emit(body?: typeof stateBody) {
    if (body) stateBody = body;
    for (const cb of listeners)
      try {
        cb(getState());
      } catch {
        /* Observers do not control transactions. */
      }
  }
  const ownRoots = (o: Operation) => [
    o.roots,
    o.resolved,
    o.compiled,
    o.assets,
    o.restore,
  ];
  function getResidency(): Residency {
    const buffers = collectBuffers([current, ...[...operations].map(ownRoots)]);
    let extraBytes = views().reduce((n, v) => n + v.stats().ownedBytes, 0);
    const owners = new Set([
      current?.ownership,
      ...[...operations].map((o) => o.ownership),
    ]);
    for (const owner of owners) extraBytes += owner?.ownedBytes ?? 0;
    for (const o of operations) {
      extraBytes += Math.max(0, o.peak - candidateBytes(o));
    }
    return { buffers, extraBytes, settled: settled() };
  }
  function retained(exclude: readonly unknown[] = []) {
    const own = getResidency(),
      ext = ports.externalResidency(),
      ignored = new Set(collectBuffers(exclude));
    if (!Number.isSafeInteger(ext.extraBytes) || ext.extraBytes < 0)
      throw Error("Invalid external residency");
    return (
      bytes(
        [...new Set([...own.buffers, ...ext.buffers])].filter(
          (b) => !ignored.has(b),
        ),
      ) +
      own.extraBytes +
      ext.extraBytes
    );
  }
  function reserve(o: Operation, increment: number) {
    const held = candidateBytes(o);
    if (
      !Number.isSafeInteger(increment) ||
      increment < 0 ||
      held + increment > L.maxCandidateCpuBytes ||
      retained() + increment > L.maxTransitionBytes
    )
      throw Error(
        "Candidate/transition memory budget exceeded before allocation",
      );
    o.peak = Math.max(o.peak, held + increment);
  }
  const candidateBytes = (o: Operation) =>
    bytes(collectBuffers(ownRoots(o))) + (o.ownership?.ownedBytes ?? 0);
  const pendingReservation = (o: Operation) =>
    Math.max(0, o.peak - candidateBytes(o));
  // The nested subsystem accounts its own forthcoming work. Exclude only this
  // explicit reservation, never real buffers or another owner's allocation.
  const nestedRetained = (o: Operation, supplied: readonly unknown[] = []) =>
    retained(supplied) - pendingReservation(o);
  const io = (o: Operation) => ({
    signal: o.abort.signal,
    resources: { retainedBytes: nestedRetained(o) },
    candidateBytes: candidateBytes(o),
  });
  function gate() {
    if (!settled() || !ports.externalResidency().settled)
      throw Error("Previous operation resources or commit are still settling");
  }
  function check(o: Operation) {
    o.abort.signal.throwIfAborted();
    if (active !== o)
      throw new DOMException("Superseded operation", "AbortError");
    if (o.baseRevisionId !== (current?.snapshot.revisionId ?? null))
      throw Error("stale: current revision changed");
  }
  function retire(o: Operation) {
    if (o === active || o === committing || o.peak) return;
    if (o.ownership && o.ownership !== current?.ownership)
      o.ownership.dispose();
    operations.delete(o);
  }
  function track<T>(o: Operation, work: () => Promise<T>): Promise<T> {
    let p: Promise<T>;
    p = Promise.resolve()
      .then(work)
      .finally(async () => {
        // Public cancellation and prepare's race may complete before source/mesh
        // initializers relinquish ownership. Keep all roots and reservations alive.
        await Promise.allSettled([
          ports.buildClient.whenPreparationSettled(),
          ...[...new Set([...views(), ...(o.view ? [o.view] : [])])].map((v) =>
            v.whenPreparationSettled(),
          ),
        ]);
        tasks.delete(p);
        o.peak = 0;
        retire(o);
        emit();
      });
    tasks.add(p);
    return p;
  }
  function rollback(o: Operation) {
    try {
      o.swap?.rollback();
    } catch {
      /* Preserve the durable/current snapshot. */
    }
    o.swap = undefined;
    // GeneralSwap restores the actual prepare-time camera, including unsaved navigation.
  }
  function cancel() {
    const o = active;
    if (o) {
      o.abort.abort(new DOMException("Cancelled", "AbortError"));
      ports.buildClient.cancel(o.operationId);
      rollback(o);
      active = null;
      if (!tasks.size) void track(o, async () => {});
    }
    emit({ phase: "idle" });
  }
  async function whenSettled() {
    while (!settled()) {
      const all = [
        ...tasks,
        ports.buildClient.whenPreparationSettled(),
        ...views().map((v) => v.whenPreparationSettled()),
      ];
      await Promise.allSettled(all);
      if (!settled()) await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  function operation(
    operationId: string,
    baseRevisionId: string | null,
    sceneId = current?.snapshot.sceneId ?? crypto.randomUUID(),
    revisionId = crypto.randomUUID(),
  ): Operation {
    gate();
    if (baseRevisionId !== (current?.snapshot.revisionId ?? null))
      throw Error("stale: request base differs from current revision");
    if (active) cancel();
    const o: Operation = {
      operationId,
      baseRevisionId,
      sceneId,
      revisionId,
      abort: new AbortController(),
      evidence: [],
      catalogMode: "live",
      state: emptyState(),
      assets: [],
      roots: [],
      commitStarted: false,
      saved: false,
      peak: 0,
    };
    active = o;
    operations.add(o);
    issues = [];
    return o;
  }
  function failed(o: Operation, e: unknown): Result<never> {
    const out = failure(e);
    if (active === o && !o.saved) {
      issues = out.issues;
      rollback(o);
      emit(
        o.abort.signal.aborted
          ? { phase: "idle" }
          : { phase: "failed", operation: identity(o) },
      );
    }
    return out;
  }
  async function catalog(o: Operation) {
    if (o.catalogMode === "fixed") {
      if (!o.library) throw Error("Missing original dependency library");
      check(o);
      return o.library;
    }
    const l = await ports.library(o.abort.signal);
    check(o);
    if (o.library && l.digest !== o.library.digest)
      throw Error("Asset catalog changed; review again");
    return makeAssetLibrary(
      { digest: l.digest, manifests: l.manifests, styles: l.styles },
      l.resolveMember,
    );
  }
  function context(o: Operation): CompileContext {
    if (!o.intent) throw Error("Missing original intent");
    return {
      ...identity(o),
      signal: o.abort.signal,
      intent: o.intent,
      modelEvidence: o.evidence,
      patch: null,
      camera: ports.display.current().getCamera(),
      resources: { retainedBytes: retained() },
      // A reviewed new global plan has a new state. Its parent identity is
      // retained by identity(o); original-version rebuild provenance is separate.
      baseSnapshot: null,
    };
  }
  function dependencyLayouts(
    library: AssetLibrary,
    refs: readonly { id: string; contentVersion: string }[],
  ) {
    return [...new Map(refs.map((r) => [canonicalJson(r), r])).values()].map(
      (r) => {
        const m = library.manifests.find(
          (m) => m.id === r.id && m.contentVersion === r.contentVersion,
        );
        if (!m) throw Error("Missing exact asset dependency");
        return assertAssetLayout(m);
      },
    );
  }
  function reserveAssets(
    o: Operation,
    library: AssetLibrary,
    refs: readonly { id: string; contentVersion: string }[],
  ) {
    const layouts = refs.map((r) => {
      const m = library.manifests.find(
        (m) => m.id === r.id && m.contentVersion === r.contentVersion,
      );
      if (!m) throw Error("Missing exact asset dependency");
      return assertAssetLayout(m);
    });
    reserve(
      o,
      layouts.reduce((n, l) => n + l.decodedBytes + l.sourceBytes, 0) +
        3 * Math.max(0, ...layouts.map((l) => l.maxMemberBytes)) +
        8 * 1024 ** 2,
    );
  }
  async function load(
    o: Operation,
    library: AssetLibrary,
    refs: readonly { id: string; contentVersion: string }[],
  ) {
    reserveAssets(o, library, refs);
    const assets: LoadedAsset[] = [];
    o.assets = assets;
    for (const ref of refs) {
      assets.push(await loadAsset(ref, library, o.abort.signal));
      check(o);
    }
    return assets;
  }
  async function display(o: Operation, compiled: CompiledScene) {
    check(o);
    const counts = compiled.render.instances.map((i) =>
      Math.max(
        compiled.render.sources.get(i.sourceKey)!.count,
        i.coarseSourceKey
          ? compiled.render.sources.get(i.coarseSourceKey)!.count
          : 0,
      ),
    );
    reserve(
      o,
      [...compiled.render.sources.values()].reduce(
        (n, s) => n + sourceOwnedBytes(s),
        0,
      ) + sparkRendererBudget(sparkSceneCapacity(counts)).reservedBytes,
    );
    emit({ phase: "building", stage: "display", operation: identity(o) });
    if (!ports.display.current().activity().available) {
      await ports.display.replace(o.abort.signal);
      check(o);
    }
    o.view = ports.display.current();
    o.swap = await o.view.prepare(compiled.render, o.abort.signal);
    check(o);
    o.view.setCamera(compiled.snapshot.camera);
    o.swap.activate();
    await ports.display.waitForDisplayed(o.view, o.swap, o.abort.signal);
    check(o);
    if (ports.display.current() !== o.view || !o.swap.isUsable())
      throw Error("Candidate has not actually displayed");
    emit({
      phase: "previewing",
      operation: identity(o),
      candidate: summary(compiled.snapshot),
      proposal: o.proposal ?? null,
    });
  }
  function plan(value: PlanningRequest): Promise<PlanningOutcome> {
    let request: PlanningRequest;
    try {
      request = parsePlanningRequest(value);
      const key = canonicalJson(request),
        prior = requests.get(request.operationId);
      if (prior) {
        if (prior.key !== key)
          throw Error("Operation identity reused with changed request");
        return prior.promise;
      }
      const o = operation(request.operationId, request.baseRevisionId);
      o.request = structuredClone(request);
      planning = null;
      emit({ phase: "requesting", operation: identity(o) });
      const promise = track(o, async () => {
        try {
          const out = parseOutcome(
            await ports.planner(o.request!, o.abort.signal, (phase) => {
              if (active === o && !o.abort.signal.aborted)
                emit({ phase, operation: identity(o) });
            }),
            o.request!,
          );
          if (active === o && !o.abort.signal.aborted) {
            planning = out;
            o.intent = out.ok
              ? out.value.intent
              : (out.partial.intent ?? undefined);
            o.evidence = out.ok ? out.value.evidence : out.partial.evidence;
            emit({
              phase: "awaiting-review",
              operation: identity(o),
              draft: out.ok ? out.value.draft : out.partial.draft,
              proposal: null,
            });
          }
          return out;
        } catch (e) {
          const out: PlanningOutcome = {
            ok: false,
            request: o.request!,
            query: null,
            inputs: [],
            issues: errorIssues(e),
            partial: { intent: null, draft: null, evidence: [] },
            mode: "manual",
          };
          if (active === o) {
            planning = out;
            failed(o, e);
          }
          return out;
        }
      });
      requests.clear();
      requests.set(request.operationId, { key, promise });
      return promise;
    } catch (e) {
      return Promise.resolve({
        ok: false,
        request: value,
        query: null,
        inputs: [],
        issues: errorIssues(e),
        partial: { intent: null, draft: null, evidence: [] },
        mode: "manual",
      });
    }
  }
  function review(
    input: PlanDraft,
    overrides: PlanningRequest["manualOverrides"],
    manual?: ManualReview,
  ): Promise<Result<ResolvedPlan>> {
    let o: Operation;
    try {
      gate();
      if (!active?.request)
        throw Error("Plan or explicitly start an offline request first");
      o = active;
      check(o);
      reserve(o, metadataWorkspace(input));
      const draft = structuredClone(parsePlanDraft(input)),
        request = parsePlanningRequest({
          ...o.request,
          manualOverrides: overrides,
        });
      if (manual) {
        if (o.intent && (!o.manualIntent || !same(o.intent, manual.intent)))
          throw Error("Retained parsed intent cannot be replaced");
        const i = parseIntent(manual.intent);
        if (
          i.requestId !== o.request!.operationId ||
          i.raw !== o.request!.prompt ||
          i.baseRevisionId !== o.baseRevisionId
        )
          throw Error("Manual intent differs from captured request/base");
        const atoms = [
          ...i.terrain,
          ...i.features.flatMap((f) => [
            ...f.constraints,
            ...(f.quantity ? [f.quantity] : []),
          ]),
          ...i.sourceConstraints,
          ...i.relations,
          ...i.prohibitions,
          ...i.water.constraints,
          ...(i.seed ? [i.seed] : []),
        ];
        if (atoms.some((a) => a.source !== "manual" || a.span !== null))
          throw Error("Manual form atoms require manual provenance");
        o.intent = i;
        o.manualIntent = true;
      }
      if (!o.intent)
        throw Error(
          "No retained parsed intent; explicit manual intent required",
        );
      const merged = new Map(
        draft.review.manualOverrides.map((a) => [a.key, a]),
      );
      request.manualOverrides.forEach((a) => merged.set(a.key, a));
      draft.review.manualOverrides = [...merged.values()];
      o.roots = [draft];
      emit({ phase: "building", stage: "resolve", operation: identity(o) });
      return track(o, async () => {
        try {
          if ((await documentDigest(o.intent!)) !== draft.intentDigest)
            throw Error("Original intent digest changed");
          if (manual)
            draft.review.fieldSources = [
              ...draft.review.fieldSources.filter(
                (a) => a.key !== "manual-intent",
              ),
              {
                key: "manual-intent",
                value: {
                  requestId: o.intent!.requestId,
                  intentDigest: draft.intentDigest,
                },
                source: "manual",
                span: null,
                strength: "hard",
                negated: false,
              },
            ];
          o.library = await catalog(o);
          const refs = [
            ...draft.groups.flatMap((g) => (g.assetRef ? [g.assetRef] : [])),
            ...(draft.terrain.source === "patch" && draft.terrain.assetRef
              ? [draft.terrain.assetRef]
              : []),
            ...o.state.overrides.flatMap((v) =>
              v.assetRef ? [v.assetRef] : [],
            ),
          ];
          const layouts = dependencyLayouts(o.library, refs);
          reserve(
            o,
            metadataWorkspace(draft) +
              4 * layouts.reduce((n, l) => n + l.sourceBytes, 0) +
              2 * layouts.reduce((n, l) => n + l.decodedBytes, 0) +
              8 * 1024 ** 2 +
              8 * L.maxHeightNodes * 64,
          );
          const out = await ports.buildClient.resolve(
            parsePlanDraft(draft),
            o.state,
            o.library,
            {
              ...identity(o),
              signal: o.abort.signal,
              resources: { retainedBytes: nestedRetained(o) },
            },
          );
          check(o);
          const r = unwrap(out),
            frozen = ports.buildClient.operationLibrary(o.operationId);
          if (!frozen) throw Error("Missing exact operation library");
          o.library = frozen;
          o.resolved = r;
          o.resolvedDigest = await documentDigest(r);
          check(o);
          const semantic = validateBuildSemantics(
            r.plan,
            context(o),
            r.catalog.manifests,
          );
          if (semantic.length) throw new IssuesError(semantic);
          emit({
            phase: "awaiting-review",
            operation: identity(o),
            draft,
            proposal: null,
          });
          return { ok: true as const, value: r };
        } catch (e) {
          return failed(o, e);
        }
      });
    } catch (e) {
      if (active && !tasks.size) active.peak = 0;
      return Promise.resolve(failure(e));
    }
  }
  let previewInFlight: {
    input: ResolvedPlan;
    promise: Promise<Result<CompiledScene>>;
  } | null = null;
  function preview(input: ResolvedPlan): Promise<Result<CompiledScene>> {
    if (previewInFlight)
      return previewInFlight.input === input
        ? previewInFlight.promise
        : Promise.resolve(failure(Error("Another preview is active")));
    const promise = previewWork(input);
    previewInFlight = { input, promise };
    void promise.then(
      () => {
        if (previewInFlight?.promise === promise) previewInFlight = null;
      },
      () => {
        if (previewInFlight?.promise === promise) previewInFlight = null;
      },
    );
    return promise;
  }
  function previewWork(input: ResolvedPlan): Promise<Result<CompiledScene>> {
    let o: Operation;
    try {
      gate();
      if (!active?.resolved || input !== active.resolved)
        throw Error("Resolved proposal is not the current reviewed operation");
      o = active;
      check(o);
      return track(o, async () => {
        try {
          await catalog(o);
          if ((await documentDigest(o.resolved!)) !== o.resolvedDigest)
            throw Error("Reviewed resolved proposal changed");
          check(o);
          emit({ phase: "building", stage: "load", operation: identity(o) });
          const r = o.resolved!,
            refs = [
              ...new Map(
                r.sourceEvidence.members.map((m) => [
                  canonicalJson(m.assetRef),
                  m.assetRef,
                ]),
              ).values(),
            ];
          await load(o, o.library!, refs);
          check(o);
          emit({ phase: "building", stage: "build", operation: identity(o) });
          const supplied = {
            resolved: r,
            assets: o.assets,
            baseSnapshot: context(o).baseSnapshot,
          };
          o.roots.push(supplied);
          const objects = r.plan.groups.reduce((n, g) => {
            const m = o.library!.manifests.find(
              (m) =>
                m.id === g.assetRef.id &&
                m.contentVersion === g.assetRef.contentVersion,
            )!;
            return (
              n +
              g.count *
                Math.max(m.gaussian.full.points, m.gaussian.coarse?.points ?? 0)
            );
          }, 0);
          const surfacePoints = r.style
            ? Math.max(0, L.maxWorstSplats - objects)
            : 0;
          reserve(
            o,
            3 * bytes(collectBuffers([supplied])) +
              surfacePoints * (60 * 3 + 56 * 3) +
              8 * 1024 ** 2,
          );
          const ctx = {
            ...context(o),
            resources: { retainedBytes: nestedRetained(o, [supplied]) },
          };
          if ((await documentDigest(r)) !== o.resolvedDigest)
            throw Error("Reviewed resolved proposal changed during loading");
          check(o);
          o.compiled = unwrap(
            await ports.buildClient.build(r, o.state, o.assets, ctx),
          );
          check(o);
          await display(o, o.compiled);
          return { ok: true as const, value: o.compiled };
        } catch (e) {
          return failed(o, e);
        }
      });
    } catch (e) {
      return Promise.resolve(failure(e));
    }
  }
  let patchInFlight: {
    key: string;
    promise: Promise<Result<PatchProposal | PatchPreview>>;
  } | null = null;
  function local(
    patch: ScenePatch,
    accepted: boolean,
  ): Promise<Result<PatchProposal | PatchPreview>> {
    let key: string;
    try {
      key = canonicalJson({ patch: parsePatch(patch), accepted });
    } catch (e) {
      return Promise.resolve(failure(e));
    }
    if (patchInFlight)
      return patchInFlight.key === key
        ? patchInFlight.promise
        : Promise.resolve(failure(Error("Another patch is active")));
    const promise = localWork(patch, accepted);
    patchInFlight = { key, promise };
    void promise.then(
      () => {
        if (patchInFlight?.promise === promise) patchInFlight = null;
      },
      () => {
        if (patchInFlight?.promise === promise) patchInFlight = null;
      },
    );
    return promise;
  }
  function localWork(
    patchInput: ScenePatch,
    accepted: boolean,
  ): Promise<Result<PatchProposal | PatchPreview>> {
    let o: Operation;
    try {
      gate();
      if (
        !current ||
        current.access !== "editable" ||
        current.snapshot.capability !== "editable" ||
        !current.library
      )
        throw Error("Current scene is read-only");
      const base = current.snapshot,
        patch = parsePatch(patchInput);
      if (patch.baseRevisionId !== base.revisionId)
        throw Error(
          "stale: patch base differs from the saved current revision",
        );
      if (accepted && !active?.proposal)
        throw Error("Review the concrete patch scope before preview");
      if (accepted && active?.proposal) {
        o = active;
        if (
          !same(patch, {
            ...o.proposal!.patch,
            review: { ...o.proposal!.patch.review, scopeAccepted: true },
          })
        )
          throw Error("Changed patch scope requires review");
      } else {
        o = operation(patch.patchId, base.revisionId);
        o.library = current.library;
        o.catalogMode = "fixed";
        o.ownership = current.ownership;
      }
      o.intent = base.intent;
      o.evidence = base.modelEvidence;
      o.roots = [patch];
      const originalLibrary = current.library;
      const cachedRefs = new Set(
        base.assets.map((a) => canonicalJson(a.assetRef)),
      );
      const requestedNewRefs = new Set(
        patch.operations
          .flatMap((v) =>
            v.kind === "add" || v.kind === "replace"
              ? [canonicalJson(v.assetRef)]
              : [],
          )
          .filter((key) => !cachedRefs.has(key)),
      );
      const layouts = dependencyLayouts(current.library, [
          ...base.assets.map((a) => a.assetRef),
          ...base.state.overrides.flatMap((v) =>
            v.assetRef ? [v.assetRef] : [],
          ),
          ...patch.operations.flatMap((v) =>
            v.kind === "add" || v.kind === "replace" ? [v.assetRef] : [],
          ),
        ]),
        baseBytes = bytes(collectBuffers([base]));
      const raw = layouts.reduce((n, l) => n + l.sourceBytes, 0),
        decoded = layouts.reduce((n, l) => n + l.decodedBytes, 0),
        nodes =
          (Math.round(base.plan.domain.width / base.terrain.spacing) + 1) *
          (Math.round(base.plan.domain.depth / base.terrain.spacing) + 1),
        geometry = 8 * nodes * 64;
      let peak =
        4 * baseBytes + 4 * raw + 2 * decoded + 8 * 1024 ** 2 + geometry;
      if (accepted) {
        const p = o.proposal!,
          objects = p.instances.reduce((n, i) => {
            const m = o.library!.manifests.find(
              (m) =>
                m.id === i.assetRef.id &&
                m.contentVersion === i.assetRef.contentVersion,
            )!;
            return (
              n +
              Math.max(m.gaussian.full.points, m.gaussian.coarse?.points ?? 0)
            );
          }, 0),
          surfacePoints = base.surfaceStyle
            ? Math.max(0, L.maxWorstSplats - objects)
            : 0;
        // T11 retains its parent capture, full evidence and decoded members through
        // worker copies and surface work. This public-data bound owns that whole
        // outer lifetime; it does not depend on the private patch preflight.
        peak = Math.max(
          peak,
          4 * (baseBytes + raw + decoded + geometry) +
            surfacePoints * (60 * 3 + 56 * 3) +
            8 * 1024 ** 2,
        );
      }
      reserve(
        o,
        peak +
          (requestedNewRefs.size
            ? metadataWorkspace({
                digest: originalLibrary.digest,
                manifests: originalLibrary.manifests,
                styles: originalLibrary.styles,
              })
            : 0),
      );
      emit({ phase: "building", stage: "resolve", operation: identity(o) });
      return track(o, async () => {
        try {
          if (current!.sourceRevisionId) {
            o.library =
              (await ports.store.libraryForRevision(
                current!.sourceRevisionId,
                io(o),
              )) ?? undefined;
            check(o);
            if (!o.library) throw Error("Missing original saved catalog");
            o.ownership = undefined; // fresh stored resolver no longer closes over imported raw members
          }
          if (requestedNewRefs.size) {
            const savedLibrary = o.library!;
            let localLibrary: Promise<AssetLibrary> | undefined;
            // Only explicit new dependencies may consult the local catalog. A
            // missing/corrupt cached member must never silently change source.
            o.library = Object.freeze({
              ...savedLibrary,
              resolveMember: async (ref, name, signal) => {
                signal.throwIfAborted();
                if (!requestedNewRefs.has(canonicalJson(ref)))
                  return savedLibrary.resolveMember(ref, name, signal);
                localLibrary ??= ports.library(signal).then((library) => {
                  signal.throwIfAborted();
                  if (library.digest !== originalLibrary.digest)
                    throw Error(
                      "Asset catalog changed; cannot acquire an uncached original dependency",
                    );
                  return library;
                });
                const library = await localLibrary;
                signal.throwIfAborted();
                return library.resolveMember(ref, name, signal);
              },
            });
          }
          await catalog(o);
          const ctx = {
            ...identity(o),
            signal: o.abort.signal,
            resources: {
              retainedBytes: nestedRetained(o),
            },
          };
          if (!accepted) {
            o.proposal = unwrap(
              await proposeLocalPatch(
                base,
                patch,
                o.library!,
                ctx,
                ports.buildClient,
              ),
            );
            check(o);
            emit({
              phase: "awaiting-review",
              operation: identity(o),
              draft: o.proposal.plan,
              proposal: o.proposal,
            });
            return { ok: true as const, value: o.proposal };
          }
          const out = unwrap(
            await previewLocalPatch(
              base,
              patch,
              o.library!,
              ctx,
              ports.buildClient,
            ),
          );
          check(o);
          o.library =
            ports.buildClient.operationLibrary(o.operationId) ?? o.library;
          o.compiled = out.compiled;
          const refs = out.compiled.snapshot.assets.map((a) => a.assetRef);
          o.assets = refs.flatMap((r) =>
            current!.assets.filter(
              (a) =>
                a.manifest.id === r.id &&
                a.manifest.contentVersion === r.contentVersion,
            ),
          );
          const missing = refs.filter(
            (r) =>
              !o.assets.some(
                (a) =>
                  a.manifest.id === r.id &&
                  a.manifest.contentVersion === r.contentVersion,
              ),
          );
          reserveAssets(o, o.library!, missing);
          for (const ref of missing) {
            o.assets.push(await loadAsset(ref, o.library!, o.abort.signal));
            check(o);
          }
          await display(o, out.compiled);
          return { ok: true as const, value: out };
        } catch (e) {
          return failed(o, e);
        }
      });
    } catch (e) {
      if (active && !tasks.size) active.peak = 0;
      return Promise.resolve(failure(e));
    }
  }
  function use(operationId: string): Promise<Result<SavedReceipt>> {
    const prior = uses.get(operationId);
    if (prior) return prior;
    let o: Operation;
    try {
      gate();
      if (
        !active ||
        active.operationId !== operationId ||
        !active.compiled ||
        !active.swap?.isUsable()
      )
        throw Error("Candidate is not actually visible/current");
      o = active;
      check(o);
      const promise = track(o, async () => {
        try {
          await catalog(o);
          check(o);
          if (!o.swap?.isUsable()) throw Error("Display lost before staging");
          emit({ phase: "saving", stage: "staging", operation: identity(o) });
          o.stage = await ports.store.stage(o.compiled!.snapshot, {
            ...io(o),
            library: o.library ?? null,
          });
          check(o);
          if (!o.swap?.isUsable()) throw Error("Display lost before commit");
          o.commitStarted = true;
          committing = o;
          emit({ phase: "saving", stage: "commit", operation: identity(o) });
          const receipt = await ports.store.commit(
            o.stage,
            o.publicationBase !== undefined
              ? o.publicationBase
              : o.baseRevisionId,
            o.abort.signal,
          );
          o.saved = true;
          let displayStatus: SavedReceipt["displayStatus"] = "ready";
          try {
            if (
              o.abort.signal.aborted ||
              active !== o ||
              ports.display.current() !== o.view
            )
              throw Error("Display superseded after durable save");
            o.swap!.commit();
          } catch {
            displayStatus = "recovering";
          }
          const saved = { ...receipt, displayStatus };
          lastSave = saved;
          if (current?.ownership !== o.ownership) current?.ownership?.dispose();
          current = {
            snapshot: o.compiled!.snapshot,
            library: o.library ?? null,
            assets: o.assets,
            render: o.compiled!.render,
            ownership: o.ownership,
            sourceRevisionId: receipt.revisionId,
            access: "editable",
            issues: [],
          };
          o.ownership = undefined;
          if (active === o) {
            active = null;
            emit({ phase: "committed", receipt: saved });
          } else emit();
          return { ok: true as const, value: saved };
        } catch (e) {
          if (o.stage && !o.saved) {
            try {
              await ports.store.discardStage(o.stage);
            } catch {
              /* Preserve primary transaction error. */
            }
          }
          return failed(o, e);
        } finally {
          if (committing === o) committing = null;
        }
      });
      uses.clear();
      uses.set(operationId, promise);
      return promise;
    } catch (e) {
      return Promise.resolve(failure(e));
    }
  }
  async function restore(
    o: Operation,
    snapshot: SceneSnapshot,
    library: AssetLibrary | null,
    assets?: LoadedAsset[],
    ownership?: ImportedScene["ownership"],
  ): Promise<Current> {
    o.roots.push(snapshot);
    if (snapshot.capability === "legacy-readonly") {
      await ports.display.showLegacy(snapshot, o.abort.signal);
      check(o);
      return {
        snapshot,
        library: null,
        assets: [],
        render: null,
        access: "readonly",
        issues: [],
      };
    }
    const loaded: Current = {
      snapshot,
      library,
      assets: [],
      render: null,
      ownership,
      access: "editable",
      issues: [],
    };
    o.library = library ?? undefined;
    o.catalogMode = "fixed";
    if (!library) {
      loaded.access = "readonly";
      loaded.issues = [
        {
          code: "missing-assets",
          path: "catalog",
          message: "Missing original dependency library",
        },
      ];
      return loaded;
    }
    // Only absent dependencies produce readonly metadata. Geometry/budget/display
    // failures remain failures and preserve the previous current scene.
    if (assets) loaded.assets = assets;
    else {
      reserveAssets(
        o,
        library,
        snapshot.assets.map((a) => a.assetRef),
      );
      o.assets = loaded.assets;
      for (const ref of snapshot.assets.map((a) => a.assetRef)) {
        try {
          loaded.assets.push(await loadAsset(ref, library, o.abort.signal));
        } catch (e) {
          o.abort.signal.throwIfAborted();
          if (/budget|memory|bytes/i.test(String(e))) throw e;
          loaded.access = "readonly";
          loaded.issues = errorIssues(e).map((i) => ({
            ...i,
            code: "missing-assets",
            path: ref.id,
          }));
          return loaded;
        }
        check(o);
      }
    }
    o.assets = loaded.assets;
    const packet = unwrap(
      await storedResultsToRenderPacket(
        snapshot,
        loaded.assets,
        o.abort.signal,
        {
          retainedBytes: nestedRetained(o, [
            { snapshot, assets: loaded.assets },
          ]),
        },
      ),
    );
    check(o);
    loaded.render = packet.render;
    o.compiled = {
      snapshot,
      render: packet.render,
      report: snapshot.quality,
      surfaceSupport: packet.surfaceSupport,
    };
    await display(o, o.compiled);
    return loaded;
  }
  function reopen(sceneId: string): Promise<Result<SceneSnapshot>> {
    let o: Operation;
    try {
      o = operation(crypto.randomUUID(), current?.snapshot.revisionId ?? null);
      emit({ phase: "building", stage: "restore", operation: identity(o) });
      return track(o, async () => {
        try {
          const s = await ports.store.open(sceneId, io(o));
          check(o);
          o.roots.push(s);
          const lib = await ports.store.libraryForRevision(s.revisionId, io(o));
          check(o);
          const loaded = await restore(o, s, lib);
          check(o);
          if (loaded.render) o.swap!.commit();
          current?.ownership?.dispose();
          current = { ...loaded, sourceRevisionId: s.revisionId };
          active = null;
          emit({ phase: "idle" });
          return { ok: true as const, value: s };
        } catch (e) {
          return failed(o, e);
        }
      });
    } catch (e) {
      return Promise.resolve(failure(e));
    }
  }
  function importArchive(input: Uint8Array): Promise<Result<ImportedScene>> {
    let o: Operation;
    try {
      o = operation(crypto.randomUUID(), current?.snapshot.revisionId ?? null);
      o.roots = [input];
      emit({ phase: "building", stage: "import", operation: identity(o) });
      return track(o, async () => {
        try {
          let lib: AssetLibrary | null = null;
          try {
            lib = await ports.library(o.abort.signal);
          } catch {
            o.abort.signal.throwIfAborted();
          }
          const imported = unwrap(
            await decodeGeneralArchive(input, lib, io(o)),
          );
          check(o);
          o.roots.push(imported.snapshot, imported.assets);
          o.ownership = imported.ownership;
          o.library = imported.library ?? undefined;
          o.catalogMode = "fixed";
          if (!imported.editable) {
            issues = imported.missingRefs.map((m) => ({
              code: "missing-assets",
              path: m.id,
              message: m.reason,
            }));
            emit({
              phase: "awaiting-review",
              operation: identity(o),
              draft: null,
              proposal: null,
            });
            return { ok: true as const, value: imported };
          }
          // A new local copy preserves exact results/state and the original parent
          // as provenance. No prior history is invented or overwritten.
          o.sceneId = crypto.randomUUID();
          o.publicationBase = null;
          const snapshot = parseSnapshot({
            ...imported.snapshot,
            sceneId: o.sceneId,
            revisionId: o.revisionId,
            operationId: o.operationId,
          });
          const loaded = await restore(
            o,
            snapshot,
            imported.library,
            imported.assets,
            imported.ownership,
          );
          check(o);
          if (loaded.access !== "editable")
            throw Error("Imported dependencies are unavailable");
          o.restore = loaded;
          imported.snapshot = snapshot;
          return { ok: true as const, value: imported };
        } catch (e) {
          return failed(o, e);
        }
      });
    } catch (e) {
      return Promise.resolve(failure(e));
    }
  }
  function exportArchive(
    mode: "embedded" | "reference",
  ): Promise<Result<Uint8Array>> {
    let o: Operation;
    try {
      if (!current) throw Error("No current scene");
      o = operation(crypto.randomUUID(), current.snapshot.revisionId);
      const source = current;
      o.roots = [source];
      emit({ phase: "building", stage: "export", operation: identity(o) });
      return track(o, async () => {
        try {
          const library = source.sourceRevisionId
            ? await ports.store.libraryForRevision(
                source.sourceRevisionId,
                io(o),
              )
            : source.library;
          check(o);
          const encoded = await encodeGeneralArchive(
            source.snapshot,
            source.assets,
            mode,
            { ...io(o), library },
          );
          const bytes = encoded;
          check(o);
          active = null;
          emit({ phase: "idle" });
          return { ok: true as const, value: bytes };
        } catch (e) {
          return failed(o, e);
        }
      });
    } catch (e) {
      return Promise.resolve(failure(e));
    }
  }
  function getCurrentCatalog(): CatalogView | null {
    const library = current?.library;
    return library
      ? Object.freeze({
          digest: library.digest,
          manifests: library.manifests,
          styles: library.styles,
        })
      : null;
  }
  function redisplayCurrent(): Promise<Result<void>> {
    let o: Operation;
    try {
      if (!current) return Promise.resolve({ ok: true, value: undefined });
      const source = current;
      o = operation(crypto.randomUUID(), source.snapshot.revisionId);
      o.roots = [source];
      o.ownership = source.ownership;
      emit({ phase: "building", stage: "restore", operation: identity(o) });
      return track(o, async () => {
        try {
          if (source.snapshot.capability === "legacy-readonly") {
            await ports.display.showLegacy(source.snapshot, o.abort.signal);
            check(o);
          } else {
            if (!source.render)
              throw Error(
                "Current read-only scene has no available render dependencies",
              );
            await display(o, {
              snapshot: source.snapshot,
              render: source.render,
              report: source.snapshot.quality,
              surfaceSupport: null,
            });
            check(o);
            o.swap!.commit();
          }
          active = null;
          emit({ phase: "idle" });
          return { ok: true as const, value: undefined };
        } catch (e) {
          return failed(o, e);
        }
      });
    } catch (e) {
      return Promise.resolve(failure(e));
    }
  }
  function undo(): Promise<Result<SavedReceipt>> {
    let o: Operation;
    try {
      if (!current?.snapshot.parentRevisionId)
        throw Error("No local parent revision");
      const parent = current.snapshot.parentRevisionId;
      o = operation(
        crypto.randomUUID(),
        current.snapshot.revisionId,
        current.snapshot.sceneId,
      );
      return track(o, async () => {
        try {
          const s = await ports.store.readRevision(parent, io(o));
          check(o);
          if (s.sceneId !== o.sceneId)
            throw Error("Parent belongs to another scene");
          o.roots.push(s);
          const lib = await ports.store.libraryForRevision(parent, io(o));
          const restored = await restore(o, s, lib);
          check(o);
          if (restored.access !== "editable")
            throw Error("Parent dependencies are unavailable");
          committing = o;
          const receipt = await ports.store.checkout(
            o.sceneId,
            parent,
            o.baseRevisionId!,
            o.operationId,
            o.abort.signal,
          );
          o.saved = true;
          let displayStatus: SavedReceipt["displayStatus"] = "ready";
          try {
            if (
              o.abort.signal.aborted ||
              active !== o ||
              ports.display.current() !== o.view
            )
              throw Error("Display superseded after durable checkout");
            o.swap!.commit();
          } catch {
            displayStatus = "recovering";
          }
          const saved: SavedReceipt = { ...receipt, displayStatus };
          if (current?.ownership !== restored.ownership)
            current?.ownership?.dispose();
          current = { ...restored, sourceRevisionId: receipt.revisionId };
          lastSave = saved;
          if (active === o) {
            active = null;
            emit({ phase: "committed", receipt: saved });
          } else emit();
          return { ok: true as const, value: saved };
        } catch (e) {
          return failed(o, e);
        } finally {
          if (committing === o) committing = null;
        }
      });
    } catch (e) {
      return Promise.resolve(failure(e));
    }
  }
  return {
    plan,
    review,
    preview,
    proposePatch: (p: ScenePatch) =>
      local(p, false) as Promise<Result<PatchProposal>>,
    previewPatch: (p: ScenePatch) =>
      local(p, true) as Promise<Result<PatchPreview>>,
    use,
    cancel,
    reopen,
    importArchive,
    exportArchive,
    undo,
    getState,
    getCurrentCatalog,
    redisplayCurrent,
    getResidency,
    whenSettled,
    subscribe(fn: (s: ControllerState) => void) {
      listeners.add(fn);
      fn(getState());
      return () => listeners.delete(fn);
    },
  };
}
export type SceneController = ReturnType<typeof createSceneController>;
