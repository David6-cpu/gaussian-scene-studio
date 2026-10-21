/** Isolated software fixtures for the ordinary workbench; never real asset/model admission. */
import type { Page } from "@playwright/test";
import { buildFixture } from "./general-build-fixture";
import { reply } from "./general-planning-fixture";
import {
  planRequest,
  type PlanningPhase,
  type PlanningRequest,
} from "../../src/general-scene/planner";
import {
  parseIntent,
  parsePlanDraft,
  type AtomicConstraint,
} from "../../src/general-scene/contracts";
import {
  createCatalogView,
  makeAssetLibrary,
  styleContentVersion,
} from "../../src/general-scene/asset-library";
import { assetContentVersion } from "../../src/general-scene/asset-package";
import { sha256 } from "../../src/io/hash";
import type { GeneralTransport } from "../../src/general-scene/model-transport";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

export const workbenchPrompts = {
  dry: "平坦场地，放1个石头和1丛低草，不要水。",
  unspecified: "平坦场地，放1个石头和1丛低草。",
  trees: "森林，放2棵树，不要水。",
  metric: "10米宽的场地，放1个石头，不要水。",
  left: "左边放1个石头，右边放1丛低草，不要水。",
  suggestions: "平坦场地，放1个石头和一些低草，不要水。",
} as const;
export type WorkbenchScenario = keyof typeof workbenchPrompts;

export async function createWorkbenchFixture(
  options: { redistributable?: boolean; unusedVariant?: boolean } = {},
) {
  const f = await buildFixture({
    categories: ["rock", "grass"],
    count: 1,
    unusedVariant: options.unusedVariant,
  });
  const manifests = structuredClone([...f.library.manifests]) as Mutable<
    typeof f.library.manifests
  >;
  const styles = structuredClone([...f.library.styles]) as Mutable<
    typeof f.library.styles
  >;
  // Permission applies exclusively to these generated fixture bytes, never real catalog entries.
  if (options.redistributable !== false) {
    for (const m of [...manifests, ...styles]) {
      m.provenance.license = {
        ...m.provenance.license,
        id: "constructed-workbench-test",
        summary:
          "Redistribution permitted only for isolated constructed test bytes.",
        redistributable: true,
        redistributionBasis:
          "Author-created software fixture bytes; no real asset rights.",
      };
      if ("kind" in m) {
        const p = f.packages.find((p) => p.manifest.id === m.id)!;
        const bytes = new TextEncoder().encode(
          "Permission to redistribute these isolated constructed test bytes only.\n",
        );
        p.members.set("license.txt", bytes);
        const descriptor = m.files.find((file) => file.path === "license.txt")!;
        descriptor.bytes = bytes.length;
        descriptor.sha256 = await sha256(bytes);
        m.resources.cpuSourceBytes = m.files.reduce(
          (n, file) => n + file.bytes,
          0,
        );
        m.quality.humanReview!.files = m.files.map(({ path, sha256 }) => ({
          path,
          sha256,
        }));
        m.contentVersion = await assetContentVersion(m);
        p.manifest = m;
      } else {
        m.contentVersion = await styleContentVersion(m);
        m.quality.humanReview!.files[0].sha256 = m.contentVersion.slice(7);
      }
      m.quality.humanReview!.asset.contentVersion = m.contentVersion;
    }
  }
  const catalog = await createCatalogView(manifests, styles);
  const library = makeAssetLibrary(catalog, async (ref, name, signal) => {
    signal.throwIfAborted();
    const found = f.packages
      .find(
        (p) =>
          p.manifest.id === ref.id &&
          p.manifest.contentVersion === ref.contentVersion,
      )
      ?.members.get(name);
    if (!found) throw Error("Unknown isolated workbench fixture member");
    return new Uint8Array(found);
  });
  const modelAtom = (
    key: string,
    value: AtomicConstraint["value"],
  ): AtomicConstraint => ({
    key,
    value,
    source: "model",
    span: null,
    strength: "suggestion",
    negated: false,
  });
  return {
    catalog,
    library,
    async outcome(request: PlanningRequest, scenario: WorkbenchScenario) {
      const phases: PlanningPhase[] = [];
      const i = structuredClone(f.intent);
      i.requestId = request.operationId;
      i.raw = request.prompt;
      i.operation = request.baseRevisionId === null ? "create" : "patch";
      i.baseRevisionId = request.baseRevisionId;
      i.terrain = [modelAtom("source", "procedural")];
      i.water = {
        mode: scenario === "unspecified" ? "unspecified" : "none",
        constraints: [],
      };
      i.features = (
        scenario === "trees"
          ? ["tree"]
          : scenario === "metric"
            ? ["rock"]
            : ["rock", "grass"]
      ).map((category) => {
        const word =
          category === "rock"
            ? "1个石头"
            : category === "grass"
              ? "1丛低草"
              : "2棵树";
        const at = request.prompt.indexOf(word);
        return {
          featureId: category,
          category,
          required: true,
          quantity:
            category === "grass" && scenario === "suggestions"
              ? null
              : {
                  key: "count",
                  value: category === "tree" ? 2 : 1,
                  source: "user",
                  span: [at, at + 1],
                  strength: "hard",
                  negated: false,
                },
          sourceRestriction: "either",
          constraints: [],
        };
      });
      i.unspecified = scenario === "unspecified" ? ["water"] : [];
      i.conflicts =
        scenario === "left"
          ? [
              {
                code: "needs-clarification",
                path: "relations",
                message: "左右依赖观察方向；请明确东、西或场地坐标。",
              },
            ]
          : [];
      i.unsupported =
        scenario === "metric"
          ? [
              {
                code: "units",
                path: "terrain.width",
                message: "首版使用展示单位，不支持米制换算；请明确展示范围。",
              },
            ]
          : [];
      const intent = parseIntent(i);
      const transport: GeneralTransport = async (request) => {
        if (request.stage === "intent") return reply(intent);
        if (request.stage !== "plan")
          throw Error("Unexpected repair of fixed software fixture");
        const payload = request.payload as {
          bindings: Record<string, unknown>;
          slots: {
            kind: string;
            groupId: string | null;
            count: number;
            countMode: "hard" | "suggestion";
            required: boolean;
            candidates: { assetRef: { id: string; contentVersion: string } }[];
          }[];
        };
        const d = structuredClone(f.draft);
        Object.assign(d, payload.bindings);
        d.water = structuredClone(
          intent.water.mode === "none"
            ? { mode: "none" as const }
            : { mode: "unspecified" as const },
        );
        d.surfaceStyleRef = {
          id: styles[0].id,
          contentVersion: styles[0].contentVersion,
        };
        d.groups = payload.slots
          .filter((s) => s.kind === "object")
          .map((slot) => ({
            ...structuredClone(f.draft.groups[0]),
            groupId: slot.groupId!,
            assetRef: slot.candidates[0].assetRef,
            count: slot.count,
            countMode: slot.countMode,
            required: slot.required,
          }));
        d.review = {
          assumptions: [],
          unsupported: [],
          missing: [],
          substitutions: [],
          acceptedSubstitutions: [],
          manualOverrides: [],
          fieldSources: [],
        };
        d.budgetEstimate = null;
        return reply(parsePlanDraft(d));
      };
      Object.assign(transport, { provenance: "constructed" as const });
      const outcome = await planRequest(
        request,
        {
          library,
          transport,
          countTokens: async () => 100,
          now: () => Date.now(),
          onPhase: (p) => phases.push(p),
        },
        new AbortController().signal,
      );
      return { outcome, phases };
    },
  };
}

export async function installWorkbenchFixture(
  page: Page,
  fixture: Awaited<ReturnType<typeof createWorkbenchFixture>>,
  scenario: WorkbenchScenario = "dry",
) {
  const trace = {
    catalog: 0,
    members: 0,
    memberRefs: [] as { id: string; contentVersion: string; name: string }[],
    planning: [] as PlanningRequest[],
  };
  await page.route("**/api/planner/general/catalog", async (route) => {
    trace.catalog++;
    await route.fulfill({ json: fixture.catalog });
  });
  await page.route("**/api/planner/general/assets/**", async (route) => {
    const match =
      /^\/api\/planner\/general\/assets\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        new URL(route.request().url()).pathname,
      );
    if (!match) throw Error("Unexpected fixture member URL");
    const [id, contentVersion, name] = match.slice(1).map(decodeURIComponent);
    const bytes = await fixture.library.resolveMember(
      { id, contentVersion },
      name,
      new AbortController().signal,
    );
    trace.members++;
    trace.memberRefs.push({ id, contentVersion, name });
    await route.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.from(bytes),
      headers: { "content-length": String(bytes.byteLength) },
    });
  });
  await page.route("**/api/planner/general/plan", async (route) => {
    const request = route.request().postDataJSON() as PlanningRequest;
    trace.planning.push(structuredClone(request));
    const { outcome, phases } = await fixture.outcome(request, scenario);
    if (route.request().headers()["accept"]?.includes("application/x-ndjson")) {
      const identity = {
        operationId: request.operationId,
        baseRevisionId: request.baseRevisionId,
      };
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          ...phases.map((phase) => ({ type: "phase", ...identity, phase })),
          { type: "final", ...identity, outcome },
        ]
          .map((event) => JSON.stringify(event) + "\n")
          .join(""),
      });
    } else await route.fulfill({ json: outcome });
  });
  return trace;
}

/** Read actual native IDB records; do not create the application schema or invent receipts. */
export async function readWorkbenchDatabase(page: Page) {
  return page.evaluate(async () => {
    if (
      !(await indexedDB.databases()).some(
        (db) => db.name === "gaussian-general-scenes",
      )
    )
      return { scenes: [], revisions: [], operations: [] };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("gaussian-general-scenes");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{
        scenes: unknown[];
        revisions: unknown[];
        operations: unknown[];
      }>((resolve, reject) => {
        const transaction = db.transaction(
          ["scenes", "revisions", "operations"],
          "readonly",
        );
        const result = {
          scenes: [] as unknown[],
          revisions: [] as unknown[],
          operations: [] as unknown[],
        };
        for (const name of ["scenes", "revisions", "operations"] as const) {
          const request = transaction.objectStore(name).getAll();
          request.onsuccess = () => {
            result[name] = request.result.map((item) => ({
              ...item,
              descriptor: undefined,
            }));
          };
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () =>
          reject(transaction.error);
      });
    } finally {
      db.close();
    }
  });
}

/** Counts actual WebGL draw API calls per canvas, without changing render results or scheduling. */
export async function installWorkbenchDrawObservation(page: Page) {
  await page.addInitScript(() => {
    const counts: Record<string, number> = {};
    const recent: { canvas: string; at: number }[] = [];
    Object.defineProperty(window, "generalWorkbenchDrawObservation", {
      value: {
        snapshot: () => ({ counts: { ...counts }, recent: recent.slice() }),
      },
    });
    for (const Class of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const prototype = Class.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      for (const method of [
        "drawArrays",
        "drawElements",
        "drawArraysInstanced",
        "drawElementsInstanced",
      ]) {
        const original = prototype[method];
        if (typeof original !== "function") continue;
        prototype[method] = function (
          this: WebGLRenderingContext,
          ...args: unknown[]
        ) {
          const value = original.apply(this, args);
          const canvas = this.canvas;
          const id =
            canvas instanceof HTMLCanvasElement
              ? canvas.id ||
                canvas.getAttribute("aria-label") ||
                "unlabelled-canvas"
              : "offscreen-canvas";
          counts[id] = (counts[id] ?? 0) + 1;
          recent.push({ canvas: id, at: performance.now() });
          if (recent.length > 100) recent.shift();
          return value;
        };
      }
    }
  });
}

/** Observe committed JSON metadata from the native current revision; no restore/generation side effects. */
export async function readWorkbenchStoredMetadata(page: Page) {
  return page.evaluate(async () => {
    if (
      !(await indexedDB.databases()).some(
        (db) => db.name === "gaussian-general-scenes",
      )
    )
      throw Error("Application database has not been created");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("gaussian-general-scenes");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let descriptor: Blob | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(["scenes", "revisions"], "readonly");
        const scenes = transaction.objectStore("scenes").getAll();
        scenes.onsuccess = () => {
          if (scenes.result.length !== 1) {
            transaction.abort();
            reject(Error("Expected exactly one actual saved scene"));
            return;
          }
          const revision = transaction
            .objectStore("revisions")
            .get(scenes.result[0].currentRevisionId);
          revision.onsuccess = () => {
            descriptor = revision.result?.descriptor ?? null;
          };
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () =>
          reject(transaction.error);
      });
    } finally {
      db.close();
    }
    if (!descriptor) throw Error("Missing actual committed descriptor");
    return JSON.parse(await (descriptor as Blob).text()).document;
  });
}

/** Read-only browser diagnostics; expected injected HTTP failures remain explicitly recorded. */
export function observeWorkbenchErrors(page: Page) {
  const log = {
    pageErrors: [] as string[],
    consoleErrors: [] as string[],
    failedRequests: [] as { url: string; error: string | null }[],
  };
  page.on("pageerror", (error) =>
    log.pageErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error") log.consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    log.failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? null,
    }),
  );
  return log;
}
