import { integer } from "../data-validation";
import { sha256 } from "../io/hash";
import { jsonDigest } from "../io/prepared-ground";
import { SH3_KEYS } from "../io/sh3-variant";
import {
  sparkRendererBudget,
  sparkSceneCapacity,
} from "../gaussian/spark-budget";
import { assertGaussianBuffer } from "../gaussian/validate";
import {
  makeAssetLibrary,
  verifyCatalogView,
  styleIdentityProjection,
  type AssetLibrary,
  type CatalogView,
} from "./asset-library";
import { loadAsset, type LoadedAsset, type SplatSource } from "./asset-loader";
import {
  assetIdentityProjection,
  assertAssetLayout,
  lodMemberNames,
  verifyAssetManifest,
  verifyAssetMember,
} from "./asset-package";
import type { AssetManifestV2, SurfaceStyle } from "./asset-manifest";
import {
  canonicalJson,
  cpuBufferDigest,
  documentDigest,
  encodeAssetDigestBinding,
  geometryKey,
} from "./canonical";
import {
  instanceIdFor,
  inspectCpuBuffer,
  parseCompileContext,
  parseEditableState,
  parsePatch,
  parseIntent,
  parsePlanDraft,
  parseScenePlan,
  parseSnapshot,
  type AtomicConstraint,
  type BuildResourceContext,
  type CompileContext,
  type EditableSnapshot,
  type EditableState,
  type HeightGridResult,
  type PlanDraft,
  type QualityReport,
  type SceneInstance,
  type Polygon,
  type ScenePlan,
  type ScenePatch,
  type RevisionContext,
  type SurfaceResult,
  type WaterResult,
} from "./contracts";
import {
  assertBudget,
  GENERAL_LIMITS as L,
  type AssetRef,
  type Issue,
  type Result,
} from "./core";
import {
  placeInstances,
  instanceEnvelope,
  footprintInPolygon,
  reattachInstance,
} from "./placement";
import { requestedQuantity, requirementValue } from "./query";
import { sourceBytes, sourceOwnedBytes } from "./render/source-bytes";
import { sourcePlacement, type RenderPacket } from "./render/types";
import {
  analyzeSurfaceSupport,
  sampleSurfaces,
  type SurfaceBuffers,
  type SurfaceSupport,
  type SurfaceSupportField,
} from "./surface";
import { buildTerrain, TERRAIN_ALGORITHM_VERSION } from "./terrain";
import {
  solveWater,
  sampleWaterDomain,
  WATER_ALGORITHM_VERSION,
  type WaterSolution,
} from "./water";

export type SourceEvidence = {
  version: 1;
  members: { assetRef: AssetRef; path: string; bytes: Uint8Array }[];
};
export type ResolveDependencies = {
  patch: CompileContext["patch"];
  baseSnapshot: EditableSnapshot | null;
};
export type BuildInputs = {
  catalog: CatalogView;
  sourceEvidence: SourceEvidence;
  transientRefs: AssetRef[];
};
export type ResolvedPlan = BuildInputs & {
  version: 1;
  plan: ScenePlan;
  geometry: WaterSolution;
  geometryDigest: string;
  stateDigest: string;
  inputKey: string;
  assetBindings: string[];
  style: SurfaceStyle | null;
};
export type CompiledScene = {
  snapshot: EditableSnapshot;
  render: RenderPacket;
  report: QualityReport;
  surfaceSupport: SurfaceSupport | null;
};
const refKey = (r: AssetRef) => canonicalJson([r.id, r.contentVersion]);
const ref = (r: AssetRef): AssetRef => ({
  id: r.id,
  contentVersion: r.contentVersion,
});
const WORKSPACE = 8 * 1024 ** 2;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
// Lock metadata is reviewed separately and does not move an instance into R/H.
// Keep every other field in the frozen-output and changed-instance comparisons.
function instanceChangeProjection(instance: SceneInstance | null) {
  if (instance === null) return null;
  const { locked: _locked, ...unchangedFields } = instance;
  return unchangedFields;
}
class BuildFailure extends Error {
  constructor(readonly issues: Issue[]) {
    super(issues.map((i) => i.message).join("; "));
  }
}
function fail(code: string, path: string, message: string): never {
  throw new BuildFailure([{ code, path, message }]);
}
function take<T>(r: Result<T>): T {
  if (!r.ok) throw new BuildFailure(r.issues);
  return r.value;
}
function failure(e: unknown): Result<never> {
  return {
    ok: false,
    issues:
      e instanceof BuildFailure
        ? e.issues
        : [
            {
              code:
                e instanceof DOMException && e.name === "AbortError"
                  ? "cancelled"
                  : "build-input",
              path: "build",
              message: e instanceof Error ? e.message : "Invalid build",
            },
          ],
  };
}
/** Actual distinct full backing buffers only; Map is runtime render ownership, never document hashing. */
export function buildOwnedBytes(value: unknown): number {
  const buffers = new Set<ArrayBufferLike>(),
    seen = new Set<object>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      const m = inspectCpuBuffer(v);
      buffers.add(m.value.buffer);
      return;
    }
    if (v instanceof Map) {
      v.forEach(visit);
      return;
    }
    for (const x of Object.values(v)) visit(x);
  };
  visit(value);
  return [...buffers].reduce((n, b) => n + b.byteLength, 0);
}
function hashWorkspace(value: unknown): number {
  let maximum = 0;
  const seen = new Set<object>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      maximum = Math.max(maximum, inspectCpuBuffer(v).byteLength);
      return;
    }
    if (v instanceof Map) v.forEach(visit);
    else Object.values(v).forEach(visit);
  };
  visit(value);
  return WORKSPACE + 3 * maximum;
}
function budget(
  candidate: number,
  retained: number,
  extra = 0,
  worstSplats = 0,
  instances = 0,
) {
  integer(retained, 0, Number.MAX_SAFE_INTEGER);
  integer(candidate, 0, Number.MAX_SAFE_INTEGER);
  integer(extra, 0, Number.MAX_SAFE_INTEGER);
  try {
    assertBudget(
      {
        instances,
        worstSplats,
        candidateCpuBytes: candidate,
        transitionBytes: retained + candidate + extra,
      },
      L,
    );
  } catch (e) {
    fail(
      "budget",
      "resources",
      e instanceof Error ? e.message : "Budget exceeded",
    );
  }
}
function dependencyRefs(p: PlanDraft, s: EditableState): AssetRef[] {
  const refs = [
    ...p.groups.flatMap((g) => (g.assetRef ? [g.assetRef] : [])),
    ...(p.terrain.source === "patch" ? [p.terrain.assetRef] : []),
    ...s.overrides.flatMap((o) => (o.assetRef ? [o.assetRef] : [])),
  ];
  return [...new Map(refs.map((r) => [refKey(r), ref(r)])).values()].sort(
    (a, b) => (refKey(a) < refKey(b) ? -1 : 1),
  );
}
function transientDependencies(
  p: PlanDraft,
  s: EditableState,
  context?: ResolveDependencies,
): AssetRef[] {
  if (!context) return [];
  const patch = context.patch ? parsePatch(context.patch) : null,
    base = context.baseSnapshot ? parseSnapshot(context.baseSnapshot) : null;
  if (base && base.capability !== "editable")
    fail(
      "patch-scope",
      "resolve",
      "Legacy base cannot supply editable dependencies",
    );
  if (patch && (!base || base.revisionId !== patch.baseRevisionId))
    fail(
      "patch-scope",
      "resolve",
      "Dependency scope has no matching actual base",
    );
  const finals = new Set(dependencyRefs(p, s).map(refKey)),
    refs = [
      ...(base?.instances.map((i) => i.assetRef) ?? []),
      ...(patch?.operations.flatMap((o) =>
        o.kind === "add" || o.kind === "replace" ? [o.assetRef] : [],
      ) ?? []),
    ];
  return [
    ...new Map(
      refs
        .filter((r) => !finals.has(refKey(r)))
        .map((r) => [refKey(r), ref(r)]),
    ).values(),
  ].sort((a, b) => (refKey(a) < refKey(b) ? -1 : 1));
}
function selectedManifests(
  p: PlanDraft,
  s: EditableState,
  c: CatalogView,
  transient: AssetRef[] = [],
) {
  return [...dependencyRefs(p, s), ...transient].map((r) => {
    const m = c.manifests.find((m) => refKey(m) === refKey(r));
    if (!m) fail("asset", "assets", "Missing exact selected asset version");
    return m;
  });
}
function admitted(m: AssetManifestV2 | SurfaceStyle) {
  if (
    m.quality.status !== "accepted" ||
    !m.quality.humanReview ||
    m.provenance.license.id === "unknown" ||
    !m.provenance.license.evidence
  )
    fail(
      "asset-admission",
      `assets.${m.id}`,
      "Asset/style has no current admission and license evidence",
    );
  if ("kind" in m) {
    if (
      m.kind === "environment" ||
      m.coordinates.unit !== "display-unit" ||
      !m.quality.operations.includes(
        m.kind === "patch" ? "place-on-patch" : "place",
      ) ||
      m.gaussian.full.quality.status !== "passed" ||
      m.gaussian.validatedDistance === null ||
      (m.gaussian.coarse && m.gaussian.coarse.quality.status !== "passed")
    )
      fail(
        "asset-admission",
        `assets.${m.id}`,
        "Selected source lacks admitted placement, LOD or viewing capability",
      );
  }
}
function metadata(
  p: PlanDraft,
  s: EditableState,
  c: CatalogView,
  transient: AssetRef[] = [],
) {
  if (p.catalogDigest !== c.digest)
    fail(
      "catalog-binding",
      "plan.catalogDigest",
      "Frozen original catalog differs from plan",
    );
  if (
    p.generatorVersion !== "general-planner-v1" ||
    p.rulesVersion !== "general-rules-v1"
  )
    fail("build-version", "plan", "Unsupported generator/rules version");
  const manifests = selectedManifests(p, s, c, transient);
  if (new Set(manifests.map(refKey)).size !== manifests.length)
    fail("asset", "assets", "Duplicate transient dependency");
  manifests.forEach(admitted);
  for (const g of p.groups) {
    const m = manifests.find(
      (m) => g.assetRef && refKey(m) === refKey(g.assetRef),
    );
    if (!m || m.kind !== "object")
      fail("asset", "groups." + g.groupId, "Exact object is required");
    const o = m.object;
    if (
      g.scaleRange[0] < o.scaleRange[0] ||
      g.scaleRange[1] > o.scaleRange[1] ||
      g.placementPolicy.maxSlopeDegrees > o.maxSlopeDegrees ||
      g.orientation.mode !== o.rotation ||
      (!m.quality.operations.includes("uniform-scale") &&
        !same(g.scaleRange, [1, 1]))
    )
      fail(
        "asset-capability",
        "groups." + g.groupId,
        "Requested scale/slope/orientation exceeds asset admission",
      );
    const [a, b] = g.orientation.yawDegrees;
    if (
      o.rotation === "fixed"
        ? a !== b || !o.verifiedYawDegrees.includes(a)
        : !m.quality.operations.includes("rotate")
          ? a !== 0 ||
            b !== 0 ||
            !o.verifiedYawDegrees.includes(0) ||
            (o.rotation === "surface-normal" &&
              g.placementPolicy.maxSlopeDegrees !== 0)
          : m.gaussian.shDegree > 0 && m.gaussian.shRotation === "fixed"
    )
      fail(
        "asset-capability",
        "groups." + g.groupId,
        "Requested rotation has no corresponding admission",
      );
  }
  if (p.terrain.source === "patch") {
    const terrain = p.terrain,
      m = manifests.find((m) => refKey(m) === refKey(terrain.assetRef));
    if (
      !m ||
      m.kind !== "patch" ||
      !same(terrain.transform, m.patch.displayTransform)
    )
      fail(
        "asset-capability",
        "terrain",
        "Fixed patch D must equal registered display transform",
      );
  }
  const style = p.surfaceStyleRef
    ? (c.styles.find((s) => refKey(s) === refKey(p.surfaceStyleRef!)) ?? null)
    : null;
  if (p.surfaceStyleRef && !style)
    fail("asset-admission", "surfaceStyle", "Missing selected style version");
  if (style) admitted(style);
  if ((p.terrain.source === "procedural" || p.water.mode !== "none") && !style)
    fail(
      "asset-admission",
      "surfaceStyle",
      "Generated surfaces require selected admitted style",
    );
  return { manifests, style };
}
/** Capture exact full catalog before await. Raw members are operation-owned, never permanent LoadedAsset fields. */
export async function acquireBuildInputs(
  draft: PlanDraft,
  state: EditableState,
  library: AssetLibrary,
  signal: AbortSignal,
  resources: BuildResourceContext,
  dependencies?: ResolveDependencies,
): Promise<BuildInputs> {
  signal.throwIfAborted();
  const p = parsePlanDraft(draft),
    s = parseEditableState(state),
    stable = makeAssetLibrary(
      {
        digest: library.digest,
        manifests: library.manifests,
        styles: library.styles,
      },
      library.resolveMember,
    );
  const catalog: CatalogView = {
    digest: stable.digest,
    manifests: stable.manifests,
    styles: stable.styles,
  };
  const transientRefs = transientDependencies(p, s, dependencies),
    { manifests } = metadata(p, s, catalog, transientRefs),
    layouts = manifests.map(assertAssetLayout),
    raw = layouts.reduce((n, l) => n + l.sourceBytes, 0),
    decoded = layouts.reduce((n, l) => n + l.decodedBytes, 0),
    maximum = Math.max(0, ...layouts.map((l) => l.maxMemberBytes));
  budget(
    raw + decoded + 3 * maximum + WORKSPACE + L.maxHeightNodes * 64,
    resources.retainedBytes,
  );
  await verifyCatalogView(catalog);
  signal.throwIfAborted();
  const members: SourceEvidence["members"] = [];
  for (const declaration of manifests) {
    const m = await verifyAssetManifest(declaration);
    signal.throwIfAborted();
    for (const file of m.files) {
      const returned = await stable.resolveMember(m, file.path, signal);
      signal.throwIfAborted();
      if (
        !(returned instanceof Uint8Array) ||
        returned.byteLength !== file.bytes ||
        returned.byteLength > L.maxCandidateCpuBytes
      )
        fail(
          "asset-integrity",
          file.path,
          "Resolver returned an invalid or overlong member before ownership copy",
        );
      const bytes = new Uint8Array(returned);
      await verifyAssetMember(m, file.path, bytes);
      signal.throwIfAborted();
      members.push({ assetRef: ref(m), path: file.path, bytes });
    }
  }
  return { catalog, sourceEvidence: { version: 1, members }, transientRefs };
}
function evidenceLibrary(inputs: BuildInputs): AssetLibrary {
  return makeAssetLibrary(inputs.catalog, async (r, path, signal) => {
    signal.throwIfAborted();
    const member = inputs.sourceEvidence.members.find(
      (m) => refKey(m.assetRef) === refKey(r) && m.path === path,
    );
    if (!member) throw Error("Missing original source member");
    return member.bytes;
  });
}
async function verifyInputs(
  p: PlanDraft,
  s: EditableState,
  inputs: BuildInputs,
  signal: AbortSignal,
) {
  try {
    if (inputs.sourceEvidence.version !== 1)
      throw Error("Unknown source evidence version");
    await verifyCatalogView(inputs.catalog);
    signal.throwIfAborted();
    const { manifests, style } = metadata(
        p,
        s,
        inputs.catalog,
        inputs.transientRefs,
      ),
      keys = new Set<string>();
    for (const m of manifests) {
      await verifyAssetManifest(m);
      signal.throwIfAborted();
      for (const file of m.files) {
        const key = refKey(m) + "/" + file.path;
        const found = inputs.sourceEvidence.members.filter(
          (x) => refKey(x.assetRef) === refKey(m) && x.path === file.path,
        );
        if (found.length !== 1)
          throw Error("Missing/duplicate exact source member");
        keys.add(key);
        await verifyAssetMember(m, file.path, found[0].bytes);
        signal.throwIfAborted();
      }
    }
    if (
      inputs.sourceEvidence.members.some(
        (m) => !keys.has(refKey(m.assetRef) + "/" + m.path),
      )
    )
      throw Error("Unrelated source evidence is not permitted");
    const assetBindings = [];
    for (const m of manifests)
      assetBindings.push(
        encodeAssetDigestBinding(
          ref(m),
          await jsonDigest(assetIdentityProjection(m)),
        ),
      );
    if (style)
      assetBindings.push(
        encodeAssetDigestBinding(
          ref(style),
          await jsonDigest(styleIdentityProjection(style)),
        ),
      );
    return { manifests, style, assetBindings };
  } catch (e) {
    if (signal.aborted) signal.throwIfAborted();
    if (e instanceof BuildFailure) throw e;
    fail(
      "asset-integrity",
      "sourceEvidence",
      e instanceof Error ? e.message : "Source integrity failed",
    );
  }
}
async function geometryDigest(
  plan: ScenePlan,
  state: EditableState,
  geometry: WaterSolution,
  bindings: string[],
) {
  return documentDigest({
    version: 1,
    terrainVersion: TERRAIN_ALGORITHM_VERSION,
    waterVersion: WATER_ALGORITHM_VERSION,
    inputKey: await geometryKey(plan, state, bindings),
    geometry,
  });
}
/** Pure-data worker entry. Does the actual terrain/water work; never invokes a model. */
export async function resolvePreparedPlan(
  draft: PlanDraft,
  inputState: EditableState,
  inputs: BuildInputs,
  signal: AbortSignal,
  resources: BuildResourceContext,
): Promise<Result<ResolvedPlan>> {
  try {
    signal.throwIfAborted();
    const p = parsePlanDraft(draft),
      state = parseEditableState(inputState);
    const patchRef = p.terrain.source === "patch" ? p.terrain.assetRef : null;
    const patchManifest = patchRef
      ? metadata(p, state, inputs.catalog, inputs.transientRefs).manifests.find(
          (m) => refKey(m) === refKey(patchRef),
        )!
      : null;
    // Both evidence copies coexist with loadAsset's full/coarse padded arrays and proxy.
    const decoded = patchManifest
      ? assertAssetLayout(patchManifest).decodedBytes
      : 0;
    const declared = buildOwnedBytes(inputs),
      peak =
        declared * 2 + decoded + hashWorkspace(inputs) + L.maxHeightNodes * 64;
    budget(peak, resources.retainedBytes);
    const stable = structuredClone(inputs);
    const { style, assetBindings } = await verifyInputs(
      p,
      state,
      stable,
      signal,
    );
    const patch =
      p.terrain.source === "patch"
        ? await loadAsset(p.terrain.assetRef, evidenceLibrary(stable), signal)
        : null;
    signal.throwIfAborted();
    const field = take(buildTerrain(p, state, patch?.patch ?? null));
    signal.throwIfAborted();
    const geometry = take(solveWater(p, field));
    const plan = parseScenePlan({ ...p, water: geometry.resolvedWater });
    const resolved: ResolvedPlan = {
      version: 1,
      ...stable,
      plan,
      geometry,
      style,
      assetBindings,
      stateDigest: await documentDigest(state),
      inputKey: await geometryKey(plan, state, assetBindings),
      geometryDigest: await geometryDigest(
        plan,
        state,
        geometry,
        assetBindings,
      ),
    };
    signal.throwIfAborted();
    budget(
      // Keep the complete decoded allocation charged through resolution, including proxy normals.
      buildOwnedBytes(resolved) + declared + decoded + hashWorkspace(resolved),
      resources.retainedBytes,
    );
    return { ok: true, value: resolved };
  } catch (e) {
    return failure(e);
  }
}
export async function resolvePlan(
  draft: PlanDraft,
  state: EditableState,
  library: AssetLibrary,
  signal: AbortSignal,
  resources: BuildResourceContext,
  dependencies?: ResolveDependencies,
): Promise<Result<ResolvedPlan>> {
  try {
    const inputs = await acquireBuildInputs(
      draft,
      state,
      library,
      signal,
      resources,
      dependencies,
    );
    return await resolvePreparedPlan(draft, state, inputs, signal, resources);
  } catch (e) {
    return failure(e);
  }
}
function rawBytes(array: Float32Array | Uint32Array): Uint8Array {
  const out = new Uint8Array(array.byteLength),
    view = new DataView(out.buffer);
  array.forEach((v, i) =>
    array instanceof Float32Array
      ? view.setFloat32(i * 4, v, true)
      : view.setUint32(i * 4, v, true),
  );
  return out;
}
async function verifyLoaded(
  manifests: readonly AssetManifestV2[],
  assets: LoadedAsset[],
  signal: AbortSignal,
) {
  try {
    if (
      assets.length !== manifests.length ||
      new Set(assets.map((a) => refKey(a.manifest))).size !== assets.length
    )
      throw Error("Missing/duplicate/unrelated decoded dependencies");
    for (const m of manifests) {
      const a = assets.find((a) => refKey(a.manifest) === refKey(m));
      if (!a || !same(m, a.manifest))
        throw Error("Decoded descriptor differs from frozen catalog");
      for (const lod of ["full", "coarse"] as const) {
        const source = a[lod],
          meta = m.gaussian[lod];
        if (!meta) {
          if (source) throw Error("Unexpected decoded LOD");
          continue;
        }
        if (!source || source.count !== meta.points)
          throw Error("Decoded source point mismatch");
        sourceBytes(source);
        const names = lodMemberNames(m, lod);
        if (m.gaussian.shDegree === 0) {
          if (source.kind !== "float14") throw Error("Decoded source kind");
          assertGaussianBuffer(source);
          await verifyAssetMember(m, names[0], rawBytes(source.data));
        } else {
          if (source.kind !== "ext-sh3") throw Error("Decoded source kind");
          for (let j = 0; j < SH3_KEYS.length; j++)
            await verifyAssetMember(
              m,
              names[j],
              rawBytes(source.arrays[SH3_KEYS[j]]),
            );
        }
        signal.throwIfAborted();
      }
      if (m.kind === "patch") {
        const p = a.patch;
        if (
          !p ||
          p.width !== 4 ||
          p.depth !== 4 ||
          p.spacing !== 0.1 ||
          p.errorBound !== m.patch.heightProxy.maxError ||
          !same(p.transform, m.patch.displayTransform) ||
          !same(p.validPolygon, m.patch.usablePolygon) ||
          !same(p.voidMask, m.patch.voidMask)
        )
          throw Error("Decoded fixed proxy mismatch");
        await verifyAssetMember(
          m,
          m.patch.heightProxy.heightFile,
          rawBytes(p.heights),
        );
      } else if (a.patch) throw Error("Unexpected decoded proxy");
    }
  } catch (e) {
    if (signal.aborted) signal.throwIfAborted();
    fail(
      "asset-integrity",
      "assets",
      e instanceof Error ? e.message : "Decoded source integrity failed",
    );
  }
}
function atomicMatches(a: AtomicConstraint, actual: unknown) {
  return a.negated
    ? !same(actual ?? null, a.value)
    : same(actual ?? null, a.value);
}
const TERRAIN_FIELDS = [
  "source",
  "width",
  "depth",
  "environment",
  "biome",
  "elevation",
  "slopeDegrees",
  "slopeAzimuthDegrees",
  "noiseAmplitude",
  "noiseScale",
  "noiseOctaves",
  "spacing",
];
function effectiveBuildIntent(plan: ScenePlan, ctx: CompileContext) {
  const value = structuredClone(ctx.intent),
    seen = new Set<string>();
  for (const atom of plan.review.manualOverrides) {
    if (
      atom.source !== "manual" ||
      atom.span !== null ||
      atom.negated ||
      seen.has(atom.key)
    )
      fail(
        "manual-override",
        "review",
        "Invalid or duplicate explicit manual override",
      );
    seen.add(atom.key);
    if (atom.key.startsWith("accept.")) continue;
    const m = /^features\.([^.]+)\.(count|sourceRestriction|required)$/.exec(
      atom.key,
    );
    if (m) {
      const f = value.features.find((f) => f.featureId === m[1]);
      if (!f) fail("manual-override", atom.key, "Unknown feature");
      if (m[2] === "count") f.quantity = { ...atom, key: "count" };
      else if (m[2] === "required") {
        if (typeof atom.value !== "boolean")
          fail("manual-override", atom.key, "Invalid necessity");
        f.required = atom.value;
      } else {
        if (
          !["either", "captured", "procedural", "generated"].includes(
            String(atom.value),
          )
        )
          fail("manual-override", atom.key, "Invalid source");
        f.sourceRestriction = atom.value as typeof f.sourceRestriction;
      }
      continue;
    }
    if (
      atom.key.startsWith("terrain.") &&
      TERRAIN_FIELDS.includes(atom.key.slice(8))
    ) {
      const key = atom.key.slice(8);
      value.terrain = value.terrain.filter(
        (a) => a.key !== key && a.key !== atom.key,
      );
      value.terrain.push({ ...atom, key });
      continue;
    }
    if (atom.key === "water.mode") {
      if (!["none", "river", "surface"].includes(String(atom.value)))
        fail("manual-override", atom.key, "Invalid water choice");
      value.water.mode = atom.value as "none" | "river" | "surface";
      continue;
    }
    if (atom.key === "water.level") {
      value.water.constraints = value.water.constraints.filter(
        (a) => a.key !== "level",
      );
      value.water.constraints.push({ ...atom, key: "level" });
      continue;
    }
    if (atom.key === "seed") {
      value.seed = atom;
      continue;
    }
    if (atom.key === "note" && atom.strength === "suggestion") continue;
    fail("manual-override", atom.key, "Unsupported manual field");
  }
  return parseIntent(value);
}
async function validateConfirmations(
  plan: ScenePlan,
  ctx: CompileContext,
  manifests: readonly AssetManifestV2[],
  style: SurfaceStyle | null,
) {
  const requirementDigest = await documentDigest({
    operationId: ctx.intent.requestId,
    prompt: ctx.intent.raw,
    baseRevisionId: ctx.intent.baseRevisionId,
    manualOverrides: plan.review.manualOverrides.filter(
      (a) => !a.key.startsWith("accept."),
    ),
  });
  const choices: {
    slotId: string;
    groupId: string | null;
    assetRef: AssetRef;
    digest: string;
    object: boolean;
  }[] = [];
  for (const [index, f] of ctx.intent.features.entries()) {
    const g = plan.groups.find((g) => g.groupId === f.featureId);
    if (!g) continue;
    const m = manifests.find((m) => refKey(m) === refKey(g.assetRef))!;
    if (m.origin === "procedural")
      choices.push({
        slotId: `object:${index}`,
        groupId: g.groupId,
        assetRef: ref(m),
        digest: m.contentVersion.slice(7),
        object: true,
      });
  }
  if (plan.terrain.source === "patch") {
    const terrain = plan.terrain,
      m = manifests.find((m) => refKey(m) === refKey(terrain.assetRef))!;
    if (m.origin === "procedural")
      choices.push({
        slotId: "patch:terrain",
        groupId: null,
        assetRef: ref(m),
        digest: m.contentVersion.slice(7),
        object: false,
      });
  }
  if (style)
    choices.push({
      slotId: "style:surfaceStyle",
      groupId: null,
      assetRef: ref(style),
      digest: style.contentVersion.slice(7),
      object: false,
    });
  for (const c of choices) {
    const atom = plan.review.manualOverrides.find(
        (a) => a.key === `accept.procedural.${c.slotId}`,
      ),
      expected = {
        groupId: c.groupId,
        requirementDigest,
        catalogDigest: plan.catalogDigest,
        assetRef: c.assetRef,
        digest: c.digest,
      };
    if (
      !atom ||
      atom.source !== "manual" ||
      atom.span !== null ||
      atom.negated ||
      atom.strength !== "hard" ||
      !same(atom.value, expected)
    )
      fail(
        "confirmation",
        "review",
        `Current procedural choice ${c.slotId} lacks bound confirmation`,
      );
    if (c.object) {
      const id = `procedural:${c.slotId}`,
        sub = plan.review.substitutions.find((s) => s.substitutionId === id),
        accepted = plan.review.acceptedSubstitutions.find(
          (a) => a.substitutionId === id,
        );
      if (
        !sub ||
        !accepted ||
        sub.groupId !== c.groupId ||
        !same(sub.assetRef, c.assetRef) ||
        sub.digest !== c.digest ||
        accepted.planId !== plan.planId ||
        accepted.catalogDigest !== plan.catalogDigest ||
        !same(accepted.assetRef, c.assetRef) ||
        accepted.digest !== c.digest
      )
        fail(
          "confirmation",
          "review",
          "Procedural object substitution binding is absent or stale",
        );
    }
  }
  if (
    plan.review.manualOverrides.some(
      (a) =>
        a.key.startsWith("accept.") &&
        !choices.some((c) => a.key === `accept.procedural.${c.slotId}`),
    )
  )
    fail(
      "confirmation",
      "review",
      "Confirmation scope no longer matches selection",
    );
}
/** Shared reviewed-result validation; model-output authority remains T5's responsibility. */
export function validateBuildSemantics(
  plan: ScenePlan,
  context: CompileContext,
  manifests: readonly AssetManifestV2[],
  manualCounts: ReadonlyMap<string, number> = new Map(),
  state?: EditableState,
): Issue[] {
  const i = effectiveBuildIntent(plan, context),
    issues: Issue[] = [],
    problem = (path: string, message: string) =>
      issues.push({ code: "semantic", path, message });
  if (
    i.conflicts.length ||
    i.unsupported.length ||
    plan.review.unsupported.length ||
    plan.review.missing.some((m) => m.required)
  )
    problem("intent", "Unresolved necessary/unsupported intent");
  if (plan.water.mode !== i.water.mode)
    problem("water", "Explicit water choice changed");
  const source = requirementValue(i.terrain, "source") ?? "procedural";
  if (plan.terrain.source !== source)
    problem("terrain.source", "Explicit terrain source changed");
  for (const a of i.terrain)
    if (a.strength === "hard") {
      const k = a.key.replace(/^terrain\./, "");
      if (["environment", "biome"].includes(k)) continue;
      if (!TERRAIN_FIELDS.includes(k))
        problem("terrain." + k, "Unsupported hard terrain field");
      const actual =
        k === "width" || k === "depth"
          ? plan.domain[k]
          : (plan.terrain as unknown as Record<string, unknown>)[k];
      if (!atomicMatches(a, actual))
        problem("terrain." + k, "Hard terrain constraint changed");
    }
  const explicitLevel = requirementValue(i.water.constraints, "level");
  if (
    explicitLevel !== undefined &&
    (!("level" in plan.water) || plan.water.level !== explicitLevel)
  )
    problem(
      "water.level",
      "Explicit water level changed, including a suggested value",
    );
  for (const a of i.water.constraints)
    if (a.strength === "hard") {
      if (
        a.negated ||
        ![
          "level",
          "width",
          "depth",
          "bankWidth",
          "reshapePolicy",
          "controlPoints",
          "polygon",
        ].includes(a.key) ||
        !atomicMatches(
          a,
          (plan.water as unknown as Record<string, unknown>)[a.key],
        )
      )
        problem(
          "water." + a.key,
          "Hard water constraint changed or unsupported",
        );
      if (
        a.key === "level" &&
        "levelSource" in plan.water &&
        plan.water.levelSource !== a.source
      )
        problem("water.levelSource", "Explicit water level provenance changed");
    }
  if (i.seed && !atomicMatches(i.seed, plan.seed))
    problem("seed", "Explicit seed changed");
  for (const f of i.features) {
    const g = plan.groups.find((g) => g.groupId === f.featureId),
      q = requestedQuantity(f);
    if (!g) {
      if (f.required && q.count > 0)
        problem("groups." + f.featureId, "Required feature removed");
      continue;
    }
    const m = manifests.find((m) => refKey(m) === refKey(g.assetRef));
    if (!m || m.kind !== "object" || m.category !== f.category)
      problem("groups." + f.featureId, "Authoritative category changed");
    if (
      g.count !== (manualCounts.get(g.groupId) ?? q.count) ||
      g.countMode !== q.countMode ||
      g.required !== f.required
    )
      problem("groups." + f.featureId, "Exact quantity or necessity changed");
    if (
      m &&
      f.sourceRestriction !== "either" &&
      m.origin !== f.sourceRestriction
    )
      problem("groups." + f.featureId, "Source restriction changed");
    for (const a of f.constraints)
      if (a.strength === "hard") {
        if (a.negated)
          problem(
            "groups." + f.featureId,
            "Unsupported negated feature constraint",
          );
        if (a.key === "scale" && !same(g.scaleRange, [a.value, a.value]))
          problem("groups." + f.featureId, "Explicit scale changed");
        else if (
          a.key === "maxSlopeDegrees" &&
          (typeof a.value !== "number" ||
            g.placementPolicy.maxSlopeDegrees > a.value)
        )
          problem("groups." + f.featureId, "Explicit slope bound changed");
        else if (
          a.key === "environment" &&
          (!m ||
            typeof a.value !== "string" ||
            !m.environments.includes(a.value))
        )
          problem("groups." + f.featureId, "Feature environment mismatch");
        else if (
          a.key === "viewDistance" &&
          (!m ||
            typeof a.value !== "number" ||
            !m.gaussian.validatedDistance ||
            a.value < m.gaussian.validatedDistance[0] ||
            a.value > m.gaussian.validatedDistance[1])
        )
          problem("groups." + f.featureId, "Unvalidated view distance");
        else if (
          !["scale", "maxSlopeDegrees", "environment", "viewDistance"].includes(
            a.key,
          )
        )
          problem(
            "groups." + f.featureId,
            "Unsupported hard feature constraint",
          );
      }
  }
  for (const override of state?.overrides ?? []) {
    if (!override.assetRef) continue;
    const feature = i.features.find((f) => f.featureId === override.groupId),
      m = manifests.find((m) => refKey(m) === refKey(override.assetRef!));
    if (
      !feature ||
      !m ||
      m.kind !== "object" ||
      m.category !== feature.category ||
      (feature.sourceRestriction !== "either" &&
        m.origin !== feature.sourceRestriction)
    )
      problem(
        "overrides." + override.instanceId,
        "Actual replacement violates unchanged category/source requirement",
      );
    if (feature && m)
      for (const a of feature.constraints.filter(
        (a) => a.strength === "hard",
      )) {
        if (
          a.key === "environment" &&
          (typeof a.value !== "string" || !m.environments.includes(a.value))
        )
          problem(
            "overrides." + override.instanceId,
            "Actual replacement fails feature environment",
          );
        if (
          a.key === "viewDistance" &&
          (typeof a.value !== "number" ||
            !m.gaussian.validatedDistance ||
            a.value < m.gaussian.validatedDistance[0] ||
            a.value > m.gaussian.validatedDistance[1])
        )
          problem(
            "overrides." + override.instanceId,
            "Actual replacement has no admitted requested viewing distance",
          );
        if (a.key === "scale" && override.transform?.scale !== a.value)
          problem(
            "overrides." + override.instanceId,
            "Actual replacement violates explicit scale",
          );
      }
  }
  for (const g of plan.groups)
    if (!i.features.some((f) => f.featureId === g.groupId))
      problem("groups." + g.groupId, "Unrequested feature group");
  const environment =
    requirementValue(i.terrain, "environment") ??
    requirementValue(i.terrain, "biome");
  if (
    typeof environment === "string" &&
    manifests.some((m) => !m.environments.includes(environment))
  )
    problem(
      "terrain.environment",
      "Selected dependency fails global environment",
    );
  for (const a of i.sourceConstraints)
    if (a.strength === "hard") {
      if (a.key !== "origin" || a.negated)
        problem("sourceConstraints", "Unsupported source constraint");
      else if (
        a.value !== "either" &&
        manifests
          .filter((m) => m.kind === "object")
          .some((m) => m.origin !== a.value)
      )
        problem("sourceConstraints", "Global source restriction changed");
    }
  for (const a of i.prohibitions) {
    if (a.key === "category" && a.negated) {
      if (
        plan.groups.some(
          (g) =>
            g.count > 0 &&
            manifests.find((m) => refKey(m) === refKey(g.assetRef))
              ?.category === a.value,
        )
      )
        problem("prohibitions", "Prohibited category present");
    } else if (a.negated && /^[a-z][a-z0-9-]*\.origin$/.test(a.key)) {
      if (
        manifests.some(
          (m) =>
            m.kind === "object" &&
            a.key === m.category + ".origin" &&
            m.origin === a.value,
        )
      )
        problem("prohibitions", "Prohibited category origin present");
    } else
      problem(
        "prohibitions",
        "Unsupported prohibition requires explicit resolution",
      );
  }
  for (const a of i.relations) {
    if (
      a.negated ||
      !a.value ||
      typeof a.value !== "object" ||
      Array.isArray(a.value)
    )
      problem("relations", "Unsupported relation");
    else if (
      a.strength === "hard" &&
      !plan.relations.some((r) =>
        same(r, { ...(a.value as object), kind: a.key }),
      )
    )
      problem("relations", "Hard spatial relation omitted");
  }
  return issues;
}
function semanticMode(
  p: ScenePlan,
  ctx: CompileContext,
  state: EditableState,
  geometryDigest: string,
): QualityReport["semanticMode"] {
  const base = ctx.baseSnapshot;
  if (
    !ctx.patch &&
    base &&
    base.quality.semanticMode === "manual-corrected" &&
    base.quality.semantic.status === "pass" &&
    base.quality.geometryDigest === base.geometryDigest &&
    geometryDigest === base.geometryDigest &&
    same(p, base.plan) &&
    same(state, base.state) &&
    same(ctx.intent, base.intent)
  )
    return "manual-corrected";
  if (
    ctx.patch ||
    p.review.manualOverrides.some((a) => !a.key.startsWith("accept.")) ||
    p.review.fieldSources.some(
      (a) =>
        a.source === "manual" &&
        a.span === null &&
        a.strength === "hard" &&
        !a.negated &&
        a.key === "manual-intent" &&
        same(a.value, {
          requestId: ctx.intent.requestId,
          intentDigest: p.intentDigest,
        }),
    )
  )
    return "manual-corrected";
  const stages = ctx.modelEvidence.filter(
    (e) =>
      e.failureReason === null &&
      e.provenance === "real" &&
      e.model === e.requestedModel &&
      e.promptVersion === p.generatorVersion &&
      e.raw !== null,
  );
  const boundIntent = stages.some((e) => {
    if (e.stage !== "intent" && e.stage !== "repair") return false;
    try {
      return same(parseIntent(JSON.parse(e.raw!)), ctx.intent);
    } catch {
      return false;
    }
  });
  const boundPlan = stages.some((e) => {
    if (e.stage !== "plan" && e.stage !== "repair") return false;
    try {
      const original = parsePlanDraft(JSON.parse(e.raw!));
      const project = (v: PlanDraft) => {
        const { review: _, budgetEstimate: __, ...geometry } = v;
        return geometry;
      };
      const actual = project(p);
      if (
        "levelStatus" in original.water &&
        original.water.levelStatus === "pending" &&
        "levelStatus" in actual.water &&
        actual.water.mode === original.water.mode
      )
        actual.water = {
          ...actual.water,
          level: original.water.level,
          levelStatus: original.water.levelStatus,
          levelSource: original.water.levelSource,
        };
      return same(project(original), actual);
    } catch {
      return false;
    }
  });
  return boundIntent && boundPlan ? "model-verified" : "unverified";
}
async function gridResult(solution: WaterSolution): Promise<HeightGridResult> {
  const { domain: _, patchSupport: __, tiles, ...base } = solution.field;
  const result = {
    ...base,
    tiles: await Promise.all(
      tiles.map(async (tile) => ({
        ...tile,
        digest: await gridTileDigest(base, tile),
      })),
    ),
    digest: "",
  };
  result.digest = await documentDigest({ ...result, digest: null });
  return result;
}
async function gridTileDigest(
  grid: Pick<HeightGridResult, "heights" | "normals" | "heightModel">,
  tile: Pick<
    HeightGridResult["tiles"][number],
    "id" | "bounds" | "nodeIndices" | "outputIndices"
  >,
) {
  return documentDigest({
    tile: {
      id: tile.id,
      bounds: tile.bounds,
      nodeIndices: tile.nodeIndices,
      outputIndices: tile.outputIndices,
    },
    heights: Array.from(tile.nodeIndices, (i) => grid.heights[i]),
    normals: Array.from(tile.nodeIndices, (i) =>
      Array.from(grid.normals.subarray(i * 3, i * 3 + 3)),
    ),
    baseHeights:
      grid.heightModel.kind === "water-profile"
        ? Array.from(
            tile.nodeIndices,
            (i) =>
              (
                grid.heightModel as Extract<
                  HeightGridResult["heightModel"],
                  { kind: "water-profile" }
                >
              ).baseHeights[i],
          )
        : null,
  });
}
export async function surfaceTilePayloadDigest(
  data: Float32Array,
  tile: { tileId: string; outputIndices: Uint32Array },
) {
  const points = new Float32Array(tile.outputIndices.length * 14);
  tile.outputIndices.forEach((index, j) =>
    points.set(data.subarray(index * 14, index * 14 + 14), j * 14),
  );
  return documentDigest({ tileId: tile.tileId, points });
}
async function surfaceResults(
  buffers: SurfaceBuffers,
  plan: ScenePlan,
): Promise<SurfaceResult[]> {
  const results: SurfaceResult[] = [];
  if (buffers.terrain.size) {
    const entries = [...buffers.terrain.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
      count = entries.reduce((n, [, s]) => n + s.count, 0),
      data = new Float32Array(count * 14),
      tiles: SurfaceResult["tiles"] = [];
    let offset = 0;
    for (const [tileId, s] of entries) {
      if (s.kind !== "float14") throw Error("Surface format");
      data.set(s.data, offset * 14);
      const outputIndices = Uint32Array.from(
        { length: s.count },
        (_, i) => offset + i,
      );
      tiles.push({
        tileId,
        outputIndices,
        digest: await surfaceTilePayloadDigest(data, { tileId, outputIndices }),
      });
      offset += s.count;
    }
    const surface: SurfaceResult = {
      role: "terrain",
      waterId: null,
      format: "float14",
      count,
      data,
      tiles,
      digest: "",
    };
    surface.digest = await documentDigest({ ...surface, digest: null });
    results.push(surface);
  }
  if (buffers.water) {
    if (
      buffers.water.kind !== "float14" ||
      plan.water.mode === "none" ||
      !buffers.sampling
    )
      throw Error("Missing exact water ownership");
    const data = new Float32Array(buffers.water.data),
      tiles = [];
    for (const tile of buffers.sampling.waterTiles) {
      const outputIndices = new Uint32Array(tile.outputIndices);
      tiles.push({
        tileId: tile.tileId,
        outputIndices,
        digest: await surfaceTilePayloadDigest(data, {
          tileId: tile.tileId,
          outputIndices,
        }),
      });
    }
    const surface: SurfaceResult = {
      role: "water",
      waterId: plan.water.waterId,
      format: "float14",
      count: buffers.water.count,
      data,
      tiles,
      digest: "",
    };
    surface.digest = await documentDigest({ ...surface, digest: null });
    results.push(surface);
  }
  return results;
}
async function waterResult(solution: WaterSolution): Promise<WaterResult> {
  const w = solution.resolvedWater;
  if (w.mode === "none") return { mode: "none" };
  const result = {
    mode: w.mode,
    waterId: w.waterId,
    level: w.level,
    nx: solution.field.nx,
    nz: solution.field.nz,
    mask: new Uint8Array(solution.wetMask),
    bankMask: new Uint8Array(solution.bankMask),
    signedDistance: new Float32Array(solution.shoreDistance),
    digest: "",
  };
  result.digest = await documentDigest({ ...result, digest: null });
  return result;
}
async function finalGeometryDigest(
  snapshot: Pick<
    EditableSnapshot,
    | "plan"
    | "state"
    | "assets"
    | "surfaceStyle"
    | "terrain"
    | "water"
    | "surfaces"
    | "instances"
  >,
) {
  const bindings = snapshot.assets.map((a) =>
    encodeAssetDigestBinding(a.assetRef, a.digest),
  );
  if (snapshot.surfaceStyle)
    bindings.push(
      encodeAssetDigestBinding(
        snapshot.surfaceStyle.assetRef,
        snapshot.surfaceStyle.digest,
      ),
    );
  return documentDigest({
    version: 1,
    terrainVersion: TERRAIN_ALGORITHM_VERSION,
    waterVersion: WATER_ALGORITHM_VERSION,
    key: await geometryKey(snapshot.plan, snapshot.state, bindings),
    terrain: snapshot.terrain,
    water: snapshot.water,
    surfaces: snapshot.surfaces,
    instances: snapshot.instances,
  });
}
/** Saved-result integrity only. No terrain/water/placement/surface generation on reopen. */
export async function verifyStoredResults(
  input: EditableSnapshot,
  signal: AbortSignal,
) {
  const s = parseSnapshot(input);
  if (s.capability !== "editable")
    fail("snapshot", "snapshot", "Expected editable snapshot");
  signal.throwIfAborted();
  if (s.plan.intentDigest !== (await documentDigest(s.intent)))
    fail("semantic", "intentDigest", "Stored intent binding differs");
  for (const a of s.assets) {
    await verifyAssetManifest(a.manifest);
    admitted(a.manifest);
    if (
      !same(a.assetRef, ref(a.manifest)) ||
      a.digest !== (await jsonDigest(assetIdentityProjection(a.manifest)))
    )
      fail("asset-integrity", "assets", "Stored descriptor identity differs");
  }
  if (s.surfaceStyle) {
    const a = s.surfaceStyle,
      digest = await jsonDigest(styleIdentityProjection(a.descriptor));
    admitted(a.descriptor);
    if (
      !same(a.assetRef, ref(a.descriptor)) ||
      a.digest !== digest ||
      a.descriptor.contentVersion !== "sha256-" + digest
    )
      fail(
        "asset-integrity",
        "surfaceStyle",
        "Stored style descriptor identity differs",
      );
  }
  for (const t of s.terrain.tiles)
    if (t.digest !== (await gridTileDigest(s.terrain, t)))
      fail(
        "geometry-binding",
        "terrain.tiles." + t.id,
        "Saved tile bytes differ from digest",
      );
  if (
    s.terrain.digest !== (await documentDigest({ ...s.terrain, digest: null }))
  )
    fail(
      "geometry-binding",
      "terrain",
      "Saved continuous source/cache differs from digest",
    );
  if (
    s.water.mode !== "none" &&
    s.water.digest !== (await documentDigest({ ...s.water, digest: null }))
  )
    fail("geometry-binding", "water", "Saved water bytes differ from digest");
  for (const surface of s.surfaces) {
    for (const tile of surface.tiles)
      if (tile.digest !== (await surfaceTilePayloadDigest(surface.data, tile)))
        fail(
          "geometry-binding",
          "surface.tiles." + tile.tileId,
          "Saved surface ownership/bytes differ",
        );
    if (surface.digest !== (await documentDigest({ ...surface, digest: null })))
      fail("geometry-binding", "surfaces", "Saved surface bytes differ");
  }
  if (s.geometryDigest !== (await finalGeometryDigest(s)))
    fail(
      "geometry-binding",
      "snapshot.geometryDigest",
      "Saved complete CPU geometry differs",
    );
  signal.throwIfAborted();
  return s;
}
function sourceKey(m: AssetManifestV2, lod: "full" | "coarse") {
  return canonicalJson(["asset", m.id, m.contentVersion, lod]);
}
function packetFromStored(
  s: EditableSnapshot,
  assets: LoadedAsset[],
): RenderPacket {
  const sources = new Map<string, SplatSource>(),
    instances: RenderPacket["instances"] = [],
    identity = {
      position: [0, 0, 0] as const,
      quaternion: [0, 0, 0, 1] as const,
      scale: 1,
    };
  const install = (
    r: AssetRef,
    id: string,
    anchor: readonly [number, number, number],
    transform: SceneInstance["transform"],
  ) => {
    const a = assets.find((a) => refKey(a.manifest) === refKey(r));
    if (!a) throw Error("Missing render source");
    const key = sourceKey(a.manifest, "full"),
      coarse = a.coarse ? sourceKey(a.manifest, "coarse") : null;
    sources.set(key, a.full);
    if (coarse) sources.set(coarse, a.coarse!);
    instances.push({
      id,
      sourceKey: key,
      coarseSourceKey: coarse,
      ...sourcePlacement(
        anchor,
        a.manifest.coordinates.sourceToCanonical,
        transform,
      ),
    });
  };
  if (s.plan.terrain.source === "patch")
    install(
      s.plan.terrain.assetRef,
      "fixed-patch",
      [0, 0, 0],
      s.plan.terrain.transform,
    );
  for (const i of s.instances) {
    const m = assets.find(
      (a) => refKey(a.manifest) === refKey(i.assetRef),
    )!.manifest;
    if (m.kind !== "object") throw Error("Object renderer dependency");
    install(i.assetRef, i.instanceId, m.object.anchor, i.transform);
  }
  for (const surface of s.surfaces) {
    if (surface.role === "water") {
      const key = canonicalJson(["surface", s.geometryDigest, "water"]);
      sources.set(key, {
        kind: "float14",
        count: surface.count,
        data: surface.data,
      });
      instances.push({
        id: "water",
        sourceKey: key,
        coarseSourceKey: null,
        anchor: [0, 0, 0],
        transform: identity,
      });
    } else
      for (const tile of surface.tiles) {
        const data = new Float32Array(tile.outputIndices.length * 14);
        tile.outputIndices.forEach((index, j) =>
          data.set(surface.data.subarray(index * 14, index * 14 + 14), j * 14),
        );
        const key = canonicalJson([
          "surface",
          s.geometryDigest,
          "terrain",
          tile.tileId,
        ]);
        sources.set(key, {
          kind: "float14",
          count: tile.outputIndices.length,
          data,
        });
        instances.push({
          id: "terrain:" + tile.tileId,
          sourceKey: key,
          coarseSourceKey: null,
          anchor: [0, 0, 0],
          transform: identity,
        });
      }
  }
  if (instances.length > 121)
    fail("budget", "render", "Renderer node limit exceeded");
  return { sources, instances };
}
/** Captures independent stable arrays before any await. resources excludes these supplied inputs;
 * both originals, candidate clones, hash scratch and the prospective Spark reservation are charged. */
export async function storedResultsToRenderPacket(
  input: EditableSnapshot,
  assets: LoadedAsset[],
  signal: AbortSignal,
  resources: BuildResourceContext,
): Promise<
  Result<{ render: RenderPacket; surfaceSupport: SurfaceSupport | null }>
> {
  try {
    signal.throwIfAborted();
    const bytes = buildOwnedBytes({ input, assets }),
      retained = resources.retainedBytes;
    budget(bytes * 2 + hashWorkspace({ input, assets }), retained);
    const stable = structuredClone({ input, assets });
    const s = await verifyStoredResults(stable.input, signal);
    await verifyLoaded(
      s.assets.map((a) => a.manifest),
      stable.assets,
      signal,
    );
    const used = new Set<string>(),
      counts: number[] = [];
    const addAsset = (r: AssetRef) => {
      const a = stable.assets.find((a) => refKey(a.manifest) === refKey(r));
      if (!a) fail("asset", "render", "Missing saved dependency");
      used.add(refKey(r));
      counts.push(Math.max(a.full.count, a.coarse?.count ?? 0));
    };
    s.instances.forEach((i) => addAsset(i.assetRef));
    if (s.plan.terrain.source === "patch") addAsset(s.plan.terrain.assetRef);
    let extraTerrain = 0,
      sourceReservation = stable.assets
        .filter((a) => used.has(refKey(a.manifest)))
        .reduce(
          (n, a) =>
            n +
            sourceOwnedBytes(a.full) +
            (a.coarse ? sourceOwnedBytes(a.coarse) : 0),
          0,
        );
    for (const surface of s.surfaces) {
      const nodes =
        surface.role === "water"
          ? [surface.count]
          : surface.tiles.map((t) => t.outputIndices.length);
      counts.push(...nodes);
      for (const count of nodes)
        sourceReservation += count * 56 + Math.ceil(count / 2048) * 2048 * 32;
      if (surface.role === "terrain") extraTerrain += surface.data.byteLength;
    }
    const renderer =
      sparkRendererBudget(sparkSceneCapacity(counts)).reservedBytes +
      sourceReservation;
    budget(
      bytes + extraTerrain + hashWorkspace(stable),
      retained,
      bytes + renderer,
      s.validation.usage.worstSplats,
      s.instances.length,
    );
    signal.throwIfAborted();
    const render = packetFromStored(s, stable.assets),
      surfaceSupport = s.surfaceStyle
        ? take(
            analyzeSurfaceSupport(
              s.surfaces.map((x) => ({
                kind: "float14" as const,
                count: x.count,
                data: x.data,
              })),
              s.terrain,
              s.surfaceStyle.descriptor,
            ),
          )
        : null;
    return { ok: true, value: { render, surfaceSupport } };
  } catch (e) {
    return failure(e);
  }
}

export type BrushScope = {
  effectiveRegion: Polygon;
  affectedTileIds: string[];
  normalReach: number;
  surfaceReach: number;
  maxObjectRadius: number;
  spacingReach: number;
  halo: number;
};
/** Finite shared H policy for T9 validation / T11 proposal. Pure support analysis
 * of saved bytes + original style and candidate descriptor; never resamples. */
export function requiredBrushScope(
  base: EditableSnapshot,
  plan: ScenePlan,
  assets: LoadedAsset[],
  requested: Polygon,
  field: SurfaceSupportField = base.terrain,
): Result<BrushScope> {
  try {
    if (
      plan.terrain.source !== "procedural" ||
      !base.surfaceStyle ||
      !plan.surfaceStyleRef ||
      !same(base.surfaceStyle.assetRef, plan.surfaceStyleRef)
    )
      fail(
        "patch-scope",
        "brush",
        "Local brush requires the same procedural surface style",
      );
    if (
      requested.some(
        (p) =>
          Math.abs(p[0]) > plan.domain.width / 2 ||
          Math.abs(p[1]) > plan.domain.depth / 2,
      )
    )
      fail("patch-scope", "brush", "Request polygon leaves the scene domain");
    const saved = take(
        analyzeSurfaceSupport(
          base.surfaces.map((s) => ({
            kind: "float14" as const,
            count: s.count,
            data: s.data,
          })),
          base.terrain,
          base.surfaceStyle.descriptor,
        ),
      ),
      candidate = take(
        analyzeSurfaceSupport([], field, base.surfaceStyle.descriptor),
      );
    const normalReach = Math.max(saved.normalReach, candidate.normalReach),
      surfaceReach = Math.max(
        saved.maxLogicalRadius,
        saved.candidateLogicalRadius,
        candidate.candidateLogicalRadius,
      );
    const all = new Map([
      ...base.assets.map((a) => [refKey(a.assetRef), a.manifest] as const),
      ...assets.map((a) => [refKey(a.manifest), a.manifest] as const),
    ]);
    let maxObjectRadius = 0;
    for (const m of all.values())
      if (m.kind === "object") {
        const groups = plan.groups.filter(
            (g) =>
              refKey(g.assetRef) === refKey(m) ||
              all.get(refKey(g.assetRef))?.category === m.category,
          ),
          actual = [
            ...base.instances
              .filter((i) => refKey(i.assetRef) === refKey(m))
              .map((i) => instanceEnvelope(m, i.transform).radius),
          ];
        let bound = 0;
        for (const g of groups) {
          const anchor = m.object.anchor;
          bound = Math.max(
            bound,
            m.object.collisionRadius * g.scaleRange[1],
            ...m.object.footprint.map(
              (p) =>
                Math.hypot(p[0] - anchor[0], p[1] - anchor[2]) *
                g.scaleRange[1],
            ),
          );
          if (g.orientation.mode === "surface-normal")
            bound = Math.max(
              bound,
              Math.hypot(
                ...m.coordinates.fullBounds.max.map((v, k) =>
                  Math.max(
                    Math.abs(v - anchor[k]),
                    Math.abs(m.coordinates.fullBounds.min[k] - anchor[k]),
                  ),
                ),
              ) * g.scaleRange[1],
            );
        }
        maxObjectRadius = Math.max(maxObjectRadius, bound, ...actual);
      }
    const spacingReach = Math.max(
        0.1,
        ...plan.groups.map((g) => g.placementPolicy.spacingMargin),
        ...plan.relations.flatMap((r) =>
          r.kind === "minSpacing" ? [r.distance] : [],
        ),
      ),
      halo = normalReach + surfaceReach + maxObjectRadius + spacingReach;
    const min = [
        Math.max(
          -plan.domain.width / 2,
          Math.min(...requested.map((p) => p[0])) - halo,
        ),
        Math.max(
          -plan.domain.depth / 2,
          Math.min(...requested.map((p) => p[1])) - halo,
        ),
      ],
      max = [
        Math.min(
          plan.domain.width / 2,
          Math.max(...requested.map((p) => p[0])) + halo,
        ),
        Math.min(
          plan.domain.depth / 2,
          Math.max(...requested.map((p) => p[1])) + halo,
        ),
      ];
    const tiles = base.terrain.tiles.filter(
      (t) =>
        t.bounds.max[0] >= min[0] &&
        t.bounds.min[0] <= max[0] &&
        t.bounds.max[1] >= min[1] &&
        t.bounds.min[1] <= max[1],
    );
    if (!tiles.length) fail("patch-scope", "brush", "No affected tiles");
    const x0 = Math.min(...tiles.map((t) => t.bounds.min[0])),
      x1 = Math.max(...tiles.map((t) => t.bounds.max[0])),
      z0 = Math.min(...tiles.map((t) => t.bounds.min[1])),
      z1 = Math.max(...tiles.map((t) => t.bounds.max[1]));
    return {
      ok: true,
      value: {
        effectiveRegion: [
          [x0, z0],
          [x1, z0],
          [x1, z1],
          [x0, z1],
        ],
        affectedTileIds: tiles.map((t) => t.id).sort(),
        normalReach,
        surfaceReach,
        maxObjectRadius,
        spacingReach,
        halo,
      },
    };
  } catch (e) {
    return failure(e);
  }
}
export type PatchProposal = {
  patch: ScenePatch;
  plan: ScenePlan;
  state: EditableState;
  instances: SceneInstance[];
  requestedRegion: Polygon;
  effectiveRegion: Polygon;
  changedInstanceIds: string[];
  changedTileIds: string[];
};
type PatchPreparation = {
  proposal?: PatchProposal;
  placementStats?: Record<string, Record<string, number>>;
  attempts?: number;
  placementState?: EditableState;
  frozen: SceneInstance[];
  manualCounts: Map<string, number>;
  region: readonly (readonly [number, number])[] | undefined;
};
function manualGroupCounts(plan: ScenePlan) {
  const map = new Map<string, number>();
  for (const a of plan.review.fieldSources.filter(
    (a) => a.key === "manual-group-count",
  )) {
    const v = a.value;
    if (
      a.source !== "manual" ||
      a.span !== null ||
      a.negated ||
      a.strength !== "hard" ||
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).sort().join(",") !== "count,groupId" ||
      typeof v.groupId !== "string" ||
      !Number.isSafeInteger(v.count) ||
      Number(v.count) < 0 ||
      Number(v.count) > 20 ||
      map.has(v.groupId)
    )
      fail(
        "manual-provenance",
        "review.fieldSources",
        "Invalid cumulative group count provenance",
      );
    map.set(v.groupId, Number(v.count));
  }
  return map;
}
function patchScopeAtom(patch: ScenePatch): AtomicConstraint {
  const { review: _, ...scope } = patch;
  return {
    key: "manual-patch-scope",
    value: JSON.parse(canonicalJson(scope)),
    source: "manual",
    span: null,
    strength: "hard",
    negated: false,
  };
}
function setEqual(a: readonly string[], b: readonly string[]) {
  return same([...a].sort(), [...b].sort());
}
async function preparePatch(
  plan: ScenePlan,
  state: EditableState,
  assets: LoadedAsset[],
  ctx: CompileContext,
  bindings: string[],
  solution: WaterSolution,
  deriving = false,
): Promise<PatchPreparation> {
  let counts = manualGroupCounts(plan);
  const base = ctx.baseSnapshot;
  let patch = ctx.patch;
  if (patch && base && !deriving) {
    const record = {
      requestedRegion: patch.requestedRegion,
      effectiveRegion: patch.effectiveRegion,
      tileIds: [...patch.affectedTileIds].sort(),
      instanceIds: [...patch.affectedInstanceIds].sort(),
    };
    if (
      !same(state.deduplications, base.state.deduplications) ||
      (!same(state.affectedRegions, base.state.affectedRegions) &&
        !same(state.affectedRegions, [...base.state.affectedRegions, record]))
    )
      fail(
        "patch-scope",
        "state.affectedRegions",
        "Local edit changes unrelated history or dedupe records",
      );
  }
  if (!base) {
    if (counts.size)
      fail(
        "manual-provenance",
        "review.fieldSources",
        "Cumulative count requires actual validated base",
      );
    return { frozen: [], manualCounts: counts, region: undefined };
  }
  await verifyStoredResults(base, ctx.signal);
  if (!patch) {
    const scopeMarkers = (p: ScenePlan) =>
      p.review.fieldSources.filter((a) => a.key === "manual-patch-scope");
    if (!same(scopeMarkers(plan), scopeMarkers(base.plan)))
      fail(
        "manual-provenance",
        "review.fieldSources",
        "Original-version rebuild must retain the saved scope provenance",
      );
    for (const [id, n] of counts) {
      if (
        manualGroupCounts(base.plan).get(id) !== n ||
        base.plan.groups.find((g) => g.groupId === id)?.count !== n ||
        plan.groups.find((g) => g.groupId === id)?.count !== n
      )
        fail(
          "manual-provenance",
          "review.fieldSources",
          "Count marker is not inherited from actual base",
        );
    }
    return {
      frozen:
        same(plan, base.plan) && same(state, base.state)
          ? base.instances
          : base.instances.filter((i) =>
              state.lockedInstanceIds.includes(i.instanceId),
            ),
      manualCounts: counts,
      region: undefined,
    };
  }
  if (
    !deriving &&
    (!patch.review.scopeAccepted ||
      patch.review.planDigest !== (await documentDigest(plan)) ||
      patch.review.catalogDigest !== plan.catalogDigest ||
      !setEqual(
        patch.review.assetBindings.map((x) => canonicalJson(x)),
        bindings,
      ) ||
      !same(ctx.intent, base.intent) ||
      !same(ctx.modelEvidence, base.modelEvidence) ||
      plan.intentDigest !== base.plan.intentDigest)
  )
    fail(
      "patch-scope",
      "patch.review",
      "Scope/plan/catalog/base intent bindings differ from reviewed proposal",
    );
  const scopeAtoms = plan.review.fieldSources.filter(
    (a) => a.key === "manual-patch-scope",
  );
  if (
    !deriving &&
    scopeAtoms.length &&
    (scopeAtoms.length !== 1 || !same(scopeAtoms[0], patchScopeAtom(patch)))
  )
    fail(
      "patch-scope",
      "review.fieldSources",
      "Concrete reviewed operations and R/H binding changed",
    );
  const staticPlan = (p: ScenePlan) => ({
    domain: p.domain,
    terrain: p.terrain,
    water: p.water,
    seed: p.seed,
    regions: p.regions,
    relations: p.relations,
    surfaceStyleRef: p.surfaceStyleRef,
    catalogDigest: p.catalogDigest,
    generatorVersion: p.generatorVersion,
    rulesVersion: p.rulesVersion,
    prngVersion: p.prngVersion,
    groups: p.groups.map(({ count: _, ...g }) => g),
    manualOverrides: p.review.manualOverrides,
  });
  if (!same(staticPlan(plan), staticPlan(base.plan)))
    fail(
      "patch-scope",
      "plan",
      "Local edits cannot change global fields, group defaults or untouched constraints",
    );
  if (
    !setEqual(state.lockedInstanceIds, patch.lockedInstanceIds) ||
    base.state.lockedInstanceIds.some(
      (id) => !state.lockedInstanceIds.includes(id),
    )
  )
    fail(
      "patch-scope",
      "state.lockedInstanceIds",
      "Patch loses an existing lock or differs from reviewed locks",
    );
  const brushes = patch.operations.filter((o) => o.kind === "brush"),
    oldBrushCount = base.state.brushes.length;
  if (
    !same(state.brushes.slice(0, oldBrushCount), base.state.brushes) ||
    state.brushes.length !== oldBrushCount + brushes.length
  )
    fail(
      "patch-scope",
      "state.brushes",
      "Brushes must append exactly the ordered reviewed operations",
    );
  const scope = brushes.length
    ? take(
        requiredBrushScope(
          base,
          plan,
          assets,
          patch.requestedRegion,
          solution.field,
        ),
      )
    : null;
  if (deriving) {
    patch = parsePatch({
      ...patch,
      effectiveRegion: scope?.effectiveRegion ?? patch.requestedRegion,
      affectedTileIds: scope?.affectedTileIds ?? [],
    });
    state = parseEditableState({
      ...state,
      brushes: state.brushes.map((b, i) =>
        i < oldBrushCount
          ? b
          : {
              ...b,
              requestedRegion: patch!.requestedRegion,
              effectiveRegion: patch!.effectiveRegion,
            },
      ),
    });
  }
  if (
    scope
      ? !same(scope.effectiveRegion, patch.effectiveRegion) ||
        !setEqual(scope.affectedTileIds, patch.affectedTileIds)
      : patch.affectedTileIds.length > 0
  )
    fail(
      "patch-scope",
      "patch.effectiveRegion",
      "Reviewed H/tiles differ from the finite support policy",
    );
  const current = new Map(
      base.instances.map((i) => [
        i.instanceId,
        {
          ...structuredClone(i),
          locked: state.lockedInstanceIds.includes(i.instanceId),
        },
      ]),
    ),
    overrides = new Map(
      base.state.overrides.map((o) => [o.instanceId, structuredClone(o)]),
    ),
    removed = new Set(base.state.tombstones),
    allocators = structuredClone(base.state.groups),
    touched = new Set<string>(),
    explicitMoves = new Set<string>();
  let brushCount = 0,
    attempts = 0;
  const stats: Record<string, Record<string, number>> = Object.create(null);
  // The initial authority is the actual saved base. Domain descriptors are unchanged by this local patch.
  let working: WaterSolution = {
    ...solution,
    field: {
      ...base.terrain,
      domain: plan.domain,
      patchSupport: solution.field.patchSupport,
    },
    wetMask: base.water.mode === "none" ? solution.wetMask : base.water.mask,
    bankMask:
      base.water.mode === "none" ? solution.bankMask : base.water.bankMask,
    shoreDistance:
      base.water.mode === "none"
        ? solution.shoreDistance
        : base.water.signedDistance,
  };
  const object = (r: AssetRef) => {
    const m = assets.find((a) => refKey(a.manifest) === refKey(r))?.manifest;
    if (!m || m.kind !== "object")
      fail("asset", "patch", "Missing exact working object dependency");
    return m;
  };
  const compatible = (r: AssetRef, id: string) => {
    const g = plan.groups.find((g) => g.groupId === id);
    if (!g || object(r).category !== object(g.assetRef).category)
      fail(
        "patch-scope",
        "patch.replace",
        "Cross-category replacement requires global planning review",
      );
  };
  const fits = (i: SceneInstance) => {
    const e = instanceEnvelope(object(i.assetRef), i.transform),
      g = plan.groups.find((g) => g.groupId === i.groupId)!;
    return footprintInPolygon(
      patch!.requestedRegion,
      e.center,
      e.radius +
        Math.max(
          0.1,
          g.placementPolicy.spacingMargin,
          ...plan.relations.flatMap((r) =>
            r.groupId === g.groupId && r.kind === "minSpacing"
              ? [r.distance]
              : [],
          ),
        ),
    );
  };
  const record = (i: SceneInstance, kind: "add" | "move" | "replace") => {
    overrides.set(i.instanceId, {
      instanceId: i.instanceId,
      groupId: i.groupId,
      kind,
      assetRef: i.assetRef,
      transform: i.transform,
    });
    touched.add(i.instanceId);
  };
  const remove = (id: string) => {
    const old = current.get(id);
    if (!old || old.locked || !fits(old))
      fail(
        "patch-scope",
        "patch.remove",
        "Removal requires a live unlocked complete footprint in R",
      );
    current.delete(id);
    explicitMoves.delete(id);
    removed.add(id);
    overrides.set(id, {
      instanceId: id,
      groupId: old.groupId,
      kind: "remove",
      assetRef: null,
      transform: null,
    });
    touched.add(id);
  };
  const workingState = () =>
    parseEditableState({
      ...base.state,
      groups: allocators,
      tombstones: [...removed],
      lockedInstanceIds: state.lockedInstanceIds,
      overrides: [...overrides.values()],
      brushes: state.brushes.slice(0, oldBrushCount + brushCount),
    });
  const add = (groupId: string, assetRef: AssetRef, count: number) => {
    const allocator = allocators.find((g) => g.groupId === groupId);
    if (!allocator || allocator.retired)
      fail(
        "patch-scope",
        "patch.add",
        "Only an existing nonretired group can grow",
      );
    compatible(assetRef, groupId);
    for (let n = 0; n < count; n++) {
      const id = instanceIdFor(groupId, allocator.nextSlot++),
        stepPlan = parseScenePlan({
          ...plan,
          groups: plan.groups.map((g) => ({
            ...g,
            assetRef: g.groupId === groupId ? assetRef : g.assetRef,
            count:
              [...current.values()].filter((i) => i.groupId === g.groupId)
                .length + (g.groupId === groupId ? 1 : 0),
          })),
        });
      // Temporary exact bindings freeze retained members while one reserved slot uses the requested asset.
      const bindings = [...overrides.values()].filter(
        (o) => o.kind === "remove",
      );
      for (const i of current.values())
        bindings.push({
          instanceId: i.instanceId,
          groupId: i.groupId,
          kind: "move",
          assetRef: i.assetRef,
          transform: i.transform,
        });
      const placed = take(
        placeInstances(
          stepPlan,
          working,
          assets,
          parseEditableState({ ...workingState(), overrides: bindings }),
          [...current.values()],
          patch!.requestedRegion,
          {
            instanceIds: [id],
            remainingAttempts: L.maxPlacementAttempts - attempts,
          },
        ),
      );
      attempts += placed.attempts;
      for (const [group, reasons] of Object.entries(placed.groupRejections))
        for (const [reason, n] of Object.entries(reasons)) {
          const groupStats = (stats[group] ??= {});
          groupStats[reason] = (groupStats[reason] ?? 0) + n;
        }
      const item = placed.instances.find((i) => i.instanceId === id);
      if (!item)
        throw new BuildFailure([
          {
            code: "quantity",
            path: "groups." + groupId,
            message: "Unable to place the exact ordered local addition " + id,
          },
          ...Object.keys(placed.rejections).map((code) => ({
            code,
            path: "groups." + groupId,
            message: `${placed.rejections[code]} actual rejected candidates`,
          })),
        ]);
      current.set(id, item);
      record(item, "add");
    }
  };
  for (const op of patch.operations) {
    ctx.signal.throwIfAborted();
    if (op.kind === "brush") {
      const edit = state.brushes[oldBrushCount + brushCount];
      if (
        edit.sequence !==
          (base.state.brushes.at(-1)?.sequence ?? 0) + brushCount + 1 ||
        !same(edit.center, op.center) ||
        edit.radius !== op.radius ||
        edit.delta !== op.delta ||
        !same(edit.requestedRegion, patch.requestedRegion) ||
        !same(edit.effectiveRegion, patch.effectiveRegion)
      )
        fail(
          "patch-scope",
          "state.brushes",
          "Brush parameters/order/R/H differ from review",
        );
      if (working.resolvedWater.mode !== "none") {
        const q = take(sampleWaterDomain(working, op.center[0], op.center[1]));
        if (
          q.wet !== false ||
          q.signedDistance - q.distanceError - op.radius - scope!.halo <=
            working.resolvedWater.bankWidth
        )
          fail(
            "patch-scope",
            "brush.water",
            "Brush plus support halo touches water or bank",
          );
      }
      brushCount++;
      working = take(
        solveWater(plan, take(buildTerrain(plan, workingState(), null))),
      );
      if (!same(working.resolvedWater, plan.water))
        fail(
          "patch-scope",
          "brush.water",
          "Intermediate brush changed the resolved water",
        );
      const stepScope = take(
        requiredBrushScope(
          base,
          plan,
          assets,
          patch.requestedRegion,
          working.field,
        ),
      );
      if (!same(stepScope.effectiveRegion, patch.effectiveRegion))
        fail(
          "patch-scope",
          "brush",
          "Intermediate support needs a different reviewed H",
        );
      for (const [id, i] of current) {
        const m = object(i.assetRef),
          e = instanceEnvelope(m, i.transform);
        if (footprintInPolygon(patch.effectiveRegion, e.center, e.radius)) {
          const next = take(reattachInstance(i, working, m));
          if (explicitMoves.has(id) && !same(next.transform, i.transform))
            fail(
              "support",
              "patch.brush",
              "Later brush would change an explicit move transform",
            );
          current.set(id, next);
          const old = overrides.get(id);
          if (old && old.kind !== "remove")
            overrides.set(id, { ...old, transform: next.transform });
        }
      }
    } else if (op.kind === "remove") remove(op.instanceId);
    else if (op.kind === "add") add(op.groupId, op.assetRef, op.count);
    else if (op.kind === "set-count") {
      const group = plan.groups.find((g) => g.groupId === op.groupId);
      if (!group) fail("patch-scope", "patch.set-count", "Unknown group");
      const local = [...current.values()].filter(
          (i) => i.groupId === op.groupId && fits(i),
        ),
        locked = local.filter((i) => i.locked);
      if (op.count < locked.length)
        fail(
          "patch-scope",
          "patch.set-count",
          "Target is below local locked count",
        );
      if (op.count < local.length) {
        const available = local
          .filter((i) => !i.locked)
          .sort(
            (a, b) =>
              Number(b.instanceId.slice(b.instanceId.lastIndexOf(":") + 1)) -
              Number(a.instanceId.slice(a.instanceId.lastIndexOf(":") + 1)),
          );
        for (const i of available.slice(0, local.length - op.count))
          remove(i.instanceId);
      } else add(op.groupId, group.assetRef, op.count - local.length);
    } else {
      const old = current.get(op.instanceId);
      if (!old || old.locked || !fits(old))
        fail(
          "patch-scope",
          "patch." + op.kind,
          "Operation requires a live unlocked complete footprint in R",
        );
      let next: SceneInstance;
      if (op.kind === "move") {
        next = { ...old, transform: op.transform };
        explicitMoves.add(op.instanceId);
      } else {
        compatible(op.assetRef, old.groupId);
        next = take(
          reattachInstance(
            { ...old, assetRef: op.assetRef },
            working,
            object(op.assetRef),
          ),
        );
        if (
          explicitMoves.has(op.instanceId) &&
          !same(next.transform, old.transform)
        )
          fail(
            "support",
            "patch.replace",
            "Replacement would change an explicit move transform",
          );
      }
      if (!fits(next))
        fail(
          "patch-scope",
          "patch." + op.kind,
          "Result footprint and spacing leave R",
        );
      current.set(next.instanceId, next);
      record(next, op.kind);
    }
  }
  if (deriving) {
    const totals = new Map(
      plan.groups.map((g) => [
        g.groupId,
        [...current.values()].filter((i) => i.groupId === g.groupId).length,
      ]),
    );
    const changedCounts = plan.groups.filter(
      (g) => totals.get(g.groupId) !== g.count,
    );
    plan = parseScenePlan({
      ...plan,
      groups: plan.groups.map((g) => ({ ...g, count: totals.get(g.groupId) })),
      review: {
        ...plan.review,
        fieldSources: [
          ...plan.review.fieldSources.filter(
            (a) =>
              !(
                a.key === "manual-group-count" &&
                a.value &&
                typeof a.value === "object" &&
                !Array.isArray(a.value) &&
                changedCounts.some(
                  (g) =>
                    g.groupId === (a.value as Record<string, unknown>).groupId,
                )
              ),
          ),
          ...changedCounts.map((g) => ({
            key: "manual-group-count",
            value: { groupId: g.groupId, count: totals.get(g.groupId) },
            source: "manual",
            strength: "hard",
            span: null,
            negated: false,
          })),
        ],
      },
    });
    counts = manualGroupCounts(plan);
    state = parseEditableState({
      ...state,
      groups: allocators,
      tombstones: [...removed].sort(),
      overrides: [...overrides.values()].sort((a, b) =>
        a.instanceId.localeCompare(b.instanceId),
      ),
    });
  }
  if (
    !same(allocators, state.groups) ||
    !setEqual([...removed], state.tombstones)
  )
    fail(
      "patch-scope",
      "state",
      "Ordered operation allocator/tombstones differ from supplied state",
    );
  for (const g of plan.groups) {
    const total = [...current.values()].filter(
      (i) => i.groupId === g.groupId,
    ).length;
    if (g.count !== total)
      fail(
        "patch-scope",
        "groups." + g.groupId,
        "Global count differs from frozen members plus ordered local target",
      );
    if (
      total !== base.plan.groups.find((b) => b.groupId === g.groupId)!.count
    ) {
      if (counts.get(g.groupId) !== total)
        fail(
          "manual-provenance",
          "review.fieldSources",
          "Changed count lacks bound cumulative provenance",
        );
    } else if (
      counts.has(g.groupId) &&
      manualGroupCounts(base.plan).get(g.groupId) !== total
    )
      fail(
        "manual-provenance",
        "review.fieldSources",
        "Unjustified cumulative count marker",
      );
  }
  for (const expected of overrides.values()) {
    const supplied = state.overrides.find(
        (o) => o.instanceId === expected.instanceId,
      ),
      prior = base.state.overrides.find(
        (o) => o.instanceId === expected.instanceId,
      );
    if (!supplied && expected.kind === "add") continue;
    if (
      !supplied ||
      (!same(supplied, expected) &&
        !(
          brushes.length &&
          !touched.has(expected.instanceId) &&
          same(supplied, prior)
        ))
    )
      fail(
        "patch-scope",
        "state.overrides",
        "Final coalesced override differs from the ordered operations",
      );
  }
  if (state.overrides.some((o) => !overrides.has(o.instanceId)))
    fail("patch-scope", "state.overrides", "Unreviewed override membership");
  const changed = [
    ...new Set([...base.instances.map((i) => i.instanceId), ...current.keys()]),
  ]
    .filter(
      (id) =>
        !same(
          instanceChangeProjection(
            base.instances.find((i) => i.instanceId === id) ?? null,
          ),
          instanceChangeProjection(current.get(id) ?? null),
        ),
    )
    .sort();
  if (deriving) {
    patch = parsePatch({ ...patch, affectedInstanceIds: changed });
    plan = parseScenePlan({
      ...plan,
      review: {
        ...plan.review,
        fieldSources: [
          ...plan.review.fieldSources.filter(
            (a) => a.key !== "manual-patch-scope",
          ),
          patchScopeAtom(patch),
        ],
      },
    });
    patch = parsePatch({
      ...patch,
      review: {
        scopeAccepted: false,
        planDigest: await documentDigest(plan),
        catalogDigest: plan.catalogDigest,
        assetBindings: bindings.map((b) => JSON.parse(b)),
      },
    });
  }
  return {
    ...(deriving
      ? {
          proposal: {
            patch,
            plan,
            state,
            instances: [...current.values()],
            requestedRegion: patch.requestedRegion,
            effectiveRegion: patch.effectiveRegion,
            changedInstanceIds: changed,
            changedTileIds: [...patch.affectedTileIds],
          },
        }
      : {}),
    frozen: [...current.values()],
    manualCounts: counts,
    region: undefined,
    placementState: parseEditableState({
      ...state,
      overrides: [...overrides.values()],
    }),
    placementStats: stats,
    attempts,
  };
}
/** Expand a proposal's R only for explicit object targets/moves. The displayed
 * proposal must be accepted again; compiler never expands an accepted scope. */
function proposalRequest(
  base: EditableSnapshot,
  patch: ScenePatch,
  assets: LoadedAsset[],
): Polygon {
  let requested = patch.requestedRegion;
  const bounds = {
    min: [
      Math.min(...requested.map((p) => p[0])),
      Math.min(...requested.map((p) => p[1])),
    ],
    max: [
      Math.max(...requested.map((p) => p[0])),
      Math.max(...requested.map((p) => p[1])),
    ],
  };
  let expanded = false;
  const transforms = new Map(
    base.instances.map((i) => [i.instanceId, i.transform]),
  );
  const refs = new Map(base.instances.map((i) => [i.instanceId, i.assetRef]));
  const groups = new Map(base.instances.map((i) => [i.instanceId, i.groupId]));
  const include = (
    id: string,
    assetRef: AssetRef,
    transform: SceneInstance["transform"],
  ) => {
    const m = assets.find(
      (a) => refKey(a.manifest) === refKey(assetRef),
    )?.manifest;
    const g = base.plan.groups.find((g) => g.groupId === groups.get(id));
    if (!m || m.kind !== "object" || !g) return;
    const e = instanceEnvelope(m, transform),
      margin = Math.max(
        0.1,
        g.placementPolicy.spacingMargin,
        ...base.plan.relations.flatMap((r) =>
          r.groupId === g.groupId && r.kind === "minSpacing"
            ? [r.distance]
            : [],
        ),
      ),
      radius = e.radius + margin;
    if (footprintInPolygon(requested, e.center, radius)) return;
    expanded = true;
    for (let k = 0; k < 2; k++) {
      bounds.min[k] = Math.min(bounds.min[k], e.center[k] - radius - 1e-9);
      bounds.max[k] = Math.max(bounds.max[k], e.center[k] + radius + 1e-9);
    }
  };
  for (const op of patch.operations)
    if ("instanceId" in op && op.instanceId !== undefined) {
      const old = transforms.get(op.instanceId),
        ref = refs.get(op.instanceId);
      if (old && ref) include(op.instanceId, ref, old);
      if (op.kind === "move" && ref) {
        include(op.instanceId, ref, op.transform);
        transforms.set(op.instanceId, op.transform);
      } else if (op.kind === "replace" && old) {
        include(op.instanceId, op.assetRef, old);
        refs.set(op.instanceId, op.assetRef);
      }
    }
  if (expanded)
    requested = [
      [bounds.min[0], bounds.min[1]],
      [bounds.max[0], bounds.min[1]],
      [bounds.max[0], bounds.max[1]],
      [bounds.min[0], bounds.max[1]],
    ];
  if (
    requested.some(
      (p) =>
        Math.abs(p[0]) > base.plan.domain.width / 2 ||
        Math.abs(p[1]) > base.plan.domain.depth / 2,
    )
  )
    fail(
      "patch-scope",
      "patch.requestedRegion",
      "Complete requested footprints leave the scene domain",
    );
  return requested;
}
/** Pure-data worker proposal. Shares the exact ordered derivation with accepted
 * compilation; does not sample Gaussian surfaces or create a SceneSnapshot. */
export async function proposePreparedPatch(
  inputBase: EditableSnapshot,
  inputPatch: ScenePatch,
  inputInputs: BuildInputs,
  context: RevisionContext & { resources: BuildResourceContext },
): Promise<Result<PatchProposal>> {
  try {
    const signal = context.signal,
      resources = { retainedBytes: context.resources.retainedBytes };
    signal.throwIfAborted();
    const supplied = buildOwnedBytes({ inputBase, inputInputs });
    // Include main caller capture, prepared DTO, transferred worker input and this owned copy.
    budget(
      4 * supplied + hashWorkspace({ inputBase, inputInputs }) + WORKSPACE,
      resources.retainedBytes,
    );
    const base = structuredClone(inputBase),
      inputs = structuredClone(inputInputs);
    let patch = parsePatch(inputPatch);
    const ctx = parseCompileContext({
      ...context,
      resources,
      intent: base.intent,
      modelEvidence: base.modelEvidence,
      camera: base.camera,
      patch,
      baseSnapshot: base,
    });
    if (
      !same(
        inputs.transientRefs,
        transientDependencies(base.plan, base.state, {
          patch,
          baseSnapshot: base,
        }),
      )
    )
      fail(
        "asset-binding",
        "proposal",
        "Proposal dependency set differs from actual base and operations",
      );
    const { manifests, assetBindings } = await verifyInputs(
      base.plan,
      base.state,
      inputs,
      signal,
    );
    const decode = manifests
      .map(assertAssetLayout)
      .reduce((n, l) => n + l.decodedBytes, 0);
    const peak =
      4 * supplied +
      decode * 2 +
      hashWorkspace({ base, inputs }) +
      WORKSPACE +
      8 * L.maxHeightNodes * 64;
    budget(peak, resources.retainedBytes);
    await verifyStoredResults(base, signal);
    const library = evidenceLibrary(inputs),
      assets: LoadedAsset[] = [];
    for (const m of manifests) {
      assets.push(await loadAsset(m, library, signal));
      signal.throwIfAborted();
    }
    const requested = proposalRequest(base, patch, assets);
    patch = parsePatch({
      ...patch,
      requestedRegion: requested,
      effectiveRegion: requested,
    });
    const state = parseEditableState({
      ...base.state,
      lockedInstanceIds: patch.lockedInstanceIds,
      brushes: [
        ...base.state.brushes,
        ...patch.operations
          .filter((o) => o.kind === "brush")
          .map((o, index) => ({
            sequence: (base.state.brushes.at(-1)?.sequence ?? 0) + index + 1,
            center: o.center,
            radius: o.radius,
            delta: o.delta,
            requestedRegion: requested,
            effectiveRegion: requested,
          })),
      ],
    });
    const terrainAsset =
      base.plan.terrain.source === "patch"
        ? assets.find((a) => a.manifest.kind === "patch")
        : null;
    const solution = take(
      solveWater(
        base.plan,
        take(buildTerrain(base.plan, state, terrainAsset?.patch ?? null)),
      ),
    );
    const local = await preparePatch(
      base.plan,
      state,
      assets,
      { ...ctx, patch },
      assetBindings,
      solution,
      true,
    );
    const proposal = local.proposal!;
    const placed = take(
      placeInstances(
        proposal.plan,
        solution,
        assets,
        proposal.state,
        local.frozen,
      ),
    );
    if (Object.values(placed.shortfall).some(Boolean))
      fail("quantity", "proposal", "Local proposal has a quantity shortfall");
    const issues = validateBuildSemantics(
      proposal.plan,
      { ...ctx, patch: proposal.patch },
      manifests,
      local.manualCounts,
      proposal.state,
    );
    if (issues.length) throw new BuildFailure(issues);
    await validateConfirmations(
      proposal.plan,
      { ...ctx, patch: proposal.patch },
      manifests,
      base.surfaceStyle?.descriptor ?? null,
    );
    signal.throwIfAborted();
    budget(peak + buildOwnedBytes(solution), resources.retainedBytes);
    return { ok: true, value: proposal };
  } catch (e) {
    return failure(e);
  }
}
function verifyFrozenOutputs(
  base: EditableSnapshot | null,
  patch: CompileContext["patch"],
  instances: SceneInstance[],
  terrain: HeightGridResult,
  surfaces: SurfaceResult[],
) {
  if (!base || !patch) return;
  const changed = [
    ...new Set([
      ...base.instances.map((i) => i.instanceId),
      ...instances.map((i) => i.instanceId),
    ]),
  ].filter(
    (id) =>
      !same(
        instanceChangeProjection(
          base.instances.find((i) => i.instanceId === id) ?? null,
        ),
        instanceChangeProjection(
          instances.find((i) => i.instanceId === id) ?? null,
        ),
      ),
  );
  if (!setEqual(changed, patch.affectedInstanceIds))
    fail(
      "patch-scope",
      "patch.affectedInstanceIds",
      "Actual changed instance set differs from reviewed set",
    );
  for (const tile of base.terrain.tiles)
    if (
      !patch.affectedTileIds.includes(tile.id) &&
      terrain.tiles.find((t) => t.id === tile.id)?.digest !== tile.digest
    )
      fail(
        "patch-scope",
        "terrain.tiles." + tile.id,
        "Unreviewed terrain tile changed",
      );
  for (const [before, after] of [
    [base.surfaces, surfaces],
    [surfaces, base.surfaces],
  ])
    for (const oldSurface of before)
      for (const tile of oldSurface.tiles)
        if (
          !patch.affectedTileIds.includes(tile.tileId) &&
          after
            .find((s) => s.role === oldSurface.role)
            ?.tiles.find((t) => t.tileId === tile.tileId)?.digest !==
            tile.digest
        )
          fail(
            "patch-scope",
            "surfaces." + tile.tileId,
            "Unreviewed surface tile payload changed",
          );
}

export async function compileScene(
  input: ResolvedPlan,
  inputState: EditableState,
  inputAssets: LoadedAsset[],
  inputContext: CompileContext,
): Promise<Result<CompiledScene>> {
  const start = performance.now();
  try {
    const ctx = parseCompileContext(inputContext);
    ctx.signal.throwIfAborted();
    const suppliedBytes = buildOwnedBytes({
      input,
      inputAssets,
      base: ctx.baseSnapshot,
    });
    budget(
      suppliedBytes * 2 +
        hashWorkspace({ input, inputAssets, base: ctx.baseSnapshot }),
      ctx.resources.retainedBytes,
    );
    // Own all caller data before the first hash await; caller/current buffers are never detached.
    const r = structuredClone(input),
      assets = structuredClone(inputAssets),
      state = parseEditableState(inputState);
    ctx.baseSnapshot = ctx.baseSnapshot
      ? structuredClone(ctx.baseSnapshot)
      : null;
    if (
      !same(
        r.transientRefs,
        transientDependencies(r.plan, state, {
          patch: ctx.patch,
          baseSnapshot: ctx.baseSnapshot,
        }),
      )
    )
      fail(
        "asset-binding",
        "resolved.transientRefs",
        "Transient dependency set differs from the actual ordered patch/base",
      );
    if (r.version !== 1)
      fail("build-version", "resolved", "Unknown preflight version");
    const plan = parseScenePlan(r.plan);
    const { manifests, style, assetBindings } = await verifyInputs(
      plan,
      state,
      r,
      ctx.signal,
    );
    if (
      !same(assetBindings, r.assetBindings) ||
      !same(style, r.style) ||
      r.stateDigest !== (await documentDigest(state)) ||
      r.inputKey !== (await geometryKey(plan, state, assetBindings)) ||
      r.geometryDigest !==
        (await geometryDigest(plan, state, r.geometry, assetBindings))
    )
      fail(
        "geometry-binding",
        "resolved",
        "Preflight input or authoritative geometry/cache changed",
      );
    if (!same(plan.water, r.geometry.resolvedWater))
      fail(
        "geometry-binding",
        "water",
        "Resolved water changed after preflight",
      );
    await verifyLoaded(manifests, assets, ctx.signal);
    if (plan.intentDigest !== (await documentDigest(ctx.intent)))
      fail(
        "semantic",
        "intentDigest",
        "Intent binding differs from supplied real/manual intent",
      );
    const patchWorkspace = ctx.patch?.operations.some((o) => o.kind === "brush")
      ? 4 * buildOwnedBytes(r.geometry) + WORKSPACE + 4 * L.maxHeightNodes * 64
      : 0;
    budget(
      buildOwnedBytes({ r, assets, base: ctx.baseSnapshot }) +
        hashWorkspace({ r, assets, base: ctx.baseSnapshot }) +
        patchWorkspace,
      ctx.resources.retainedBytes,
      suppliedBytes,
    );
    const local = await preparePatch(
      plan,
      state,
      assets,
      ctx,
      assetBindings,
      r.geometry,
    );
    const semanticIssues = validateBuildSemantics(
      plan,
      ctx,
      manifests,
      local.manualCounts,
      state,
    );
    if (
      plan.water.mode !== "none" &&
      requirementValue(
        effectiveBuildIntent(plan, ctx).water.constraints,
        "level",
      ) === undefined &&
      r.geometry.report.levelSource !== "program-suggestion" &&
      !(ctx.baseSnapshot && same(ctx.baseSnapshot.plan.water, plan.water))
    )
      semanticIssues.push({
        code: "semantic",
        path: "water.level",
        message:
          "An unspecified level requires actual preflight selection or the unchanged verified base level",
      });
    if (semanticIssues.length) throw new BuildFailure(semanticIssues);
    await validateConfirmations(plan, ctx, manifests, style);

    const placed = take(
      placeInstances(
        plan,
        r.geometry,
        assets,
        local.placementState ?? state,
        local.frozen,
        local.region,
      ),
    );
    for (const [group, reasons] of Object.entries(local.placementStats ?? {}))
      for (const [reason, n] of Object.entries(reasons)) {
        const dest = (placed.groupRejections[group] ??= {});
        dest[reason] = (dest[reason] ?? 0) + n;
        placed.rejections[reason] = (placed.rejections[reason] ?? 0) + n;
      }
    placed.attempts += local.attempts ?? 0;
    if (ctx.patch && ctx.baseSnapshot)
      placed.state = parseEditableState({
        ...placed.state,
        affectedRegions: [
          ...ctx.baseSnapshot.state.affectedRegions,
          {
            requestedRegion: ctx.patch.requestedRegion,
            effectiveRegion: ctx.patch.effectiveRegion,
            tileIds: [...ctx.patch.affectedTileIds].sort(),
            instanceIds: [...ctx.patch.affectedInstanceIds].sort(),
          },
        ],
      });
    const finalSemantic = validateBuildSemantics(
      plan,
      ctx,
      manifests,
      local.manualCounts,
      placed.state,
    );
    if (finalSemantic.length) throw new BuildFailure(finalSemantic);
    const rejections = Object.entries(placed.groupRejections).flatMap(
      ([groupId, reasons]) =>
        Object.entries(reasons).map(([code, count]) => ({
          groupId,
          instanceId: null,
          reason: {
            code,
            path: "groups." + groupId,
            message: `${count} rejected candidates: ${code}`,
          },
        })),
    );
    const hard = plan.groups.filter(
      (g) => g.countMode === "hard" && (placed.shortfall[g.groupId] ?? 0) > 0,
    );
    if (hard.length)
      throw new BuildFailure([
        ...hard.map((g) => ({
          code: "quantity",
          path: "groups." + g.groupId,
          message: `Missing ${placed.shortfall[g.groupId]} of ${g.count} required instances`,
        })),
        ...rejections.map((r) => r.reason),
      ]);
    const counts = placed.instances.map((i) => {
      const m = manifests.find((m) => refKey(m) === refKey(i.assetRef))!;
      return Math.max(m.gaussian.full.points, m.gaussian.coarse?.points ?? 0);
    });
    if (plan.terrain.source === "patch") {
      const terrain = plan.terrain,
        m = manifests.find((m) => refKey(m) === refKey(terrain.assetRef))!;
      counts.push(
        Math.max(m.gaussian.full.points, m.gaussian.coarse?.points ?? 0),
      );
    }
    const objectPoints = counts.reduce((n, x) => n + x, 0),
      available = L.maxWorstSplats - objectPoints;
    if (available < 0)
      fail("budget", "points", "Per-instance worst LOD exceeds 250000");
    const inputOwned = buildOwnedBytes({ r, assets, base: ctx.baseSnapshot }),
      surfaceReserve = style ? available * 60 : 0;
    const samplingReservation =
      inputOwned +
      surfaceReserve * 3 +
      Math.max(
        hashWorkspace({ r, assets, base: ctx.baseSnapshot }),
        WORKSPACE + 3 * (style ? available : 0) * 56,
      );
    budget(
      samplingReservation,
      ctx.resources.retainedBytes,
      suppliedBytes,
      objectPoints,
      placed.instances.length,
    );
    ctx.signal.throwIfAborted();
    const buffers: SurfaceBuffers = style
      ? take(sampleSurfaces(r.geometry, style, available))
      : { terrain: new Map(), water: null, pointCount: 0, ownedBytes: 0 };
    const terrain = await gridResult(r.geometry),
      water = await waterResult(r.geometry),
      surfaces = await surfaceResults(buffers, plan);
    ctx.signal.throwIfAborted();
    verifyFrozenOutputs(
      ctx.baseSnapshot,
      ctx.patch,
      placed.instances,
      terrain,
      surfaces,
    );
    const descriptors: EditableSnapshot["assets"] = [];
    for (const m of manifests.filter((m) =>
      dependencyRefs(plan, placed.state).some((r) => refKey(r) === refKey(m)),
    ))
      descriptors.push({
        assetRef: ref(m),
        digest: await jsonDigest(assetIdentityProjection(m)),
        manifest: m,
      });
    const surfaceStyle = style
      ? {
          assetRef: ref(style),
          digest: await jsonDigest(styleIdentityProjection(style)),
          descriptor: style,
        }
      : null;
    const geometry = {
      plan,
      state: placed.state,
      assets: descriptors,
      surfaceStyle,
      terrain,
      water,
      surfaces,
      instances: placed.instances,
    };
    const digest = await finalGeometryDigest(geometry),
      mode = semanticMode(plan, ctx, placed.state, digest),
      shortfall = Object.values(placed.shortfall).reduce((n, x) => n + x, 0);
    const check = (status: "pass" | "pending", evidence: string[] = []) => ({
      status,
      evidenceRefs: evidence,
      issues: [],
    });
    const report: QualityReport = {
      geometryDigest: digest,
      semanticMode: mode,
      semantic: check(mode === "unverified" ? "pending" : "pass", [
        "intent:" + plan.intentDigest,
      ]),
      assets: check("pass", ["catalog:" + plan.catalogDigest]),
      geometry: shortfall
        ? {
            status: "fail",
            evidenceRefs: [],
            issues: [
              {
                code: "quantity",
                path: "groups",
                message: `${shortfall} suggested instances could not be placed`,
              },
            ],
          }
        : check("pass", ["geometry:" + digest]),
      visual: check("pending"),
      performance: check("pending"),
    };
    const preliminary = {
      documentType: "general-scene-snapshot" as const,
      schemaVersion: 1 as const,
      capability: "editable" as const,
      sceneId: ctx.sceneId,
      revisionId: ctx.revisionId,
      parentRevisionId: ctx.baseRevisionId,
      operationId: ctx.operationId,
      intent: ctx.intent,
      modelEvidence: [...ctx.modelEvidence],
      patch: ctx.patch,
      ...geometry,
      geometryDigest: digest,
      camera: ctx.camera,
      reviewStatus: "draft" as const,
      quality: report,
    };
    const render = packetFromStored(
        preliminary as EditableSnapshot,
        assets.filter((a) =>
          descriptors.some((d) => refKey(d.assetRef) === refKey(a.manifest)),
        ),
      ),
      worstSplats = objectPoints + buffers.pointCount,
      actualSourceBytes = [...render.sources.values()].reduce(
        (n, s) => n + sourceBytes(s),
        0,
      );
    const finalCpuBytes =
      buildOwnedBytes({
        r,
        assets,
        buffers,
        preliminary,
        render,
        base: ctx.baseSnapshot,
      }) +
      hashWorkspace({
        r,
        assets,
        buffers,
        preliminary,
        render,
        base: ctx.baseSnapshot,
      }) +
      (buffers.sampling?.peakWorkspaceBytes ?? 0);
    const candidateCpuBytes = Math.max(
      finalCpuBytes,
      samplingReservation,
      inputOwned +
        hashWorkspace({ r, assets, base: ctx.baseSnapshot }) +
        patchWorkspace,
    );
    const renderCounts = render.instances.map((i) =>
      Math.max(
        render.sources.get(i.sourceKey)!.count,
        i.coarseSourceKey ? render.sources.get(i.coarseSourceKey)!.count : 0,
      ),
    );
    const renderer =
      sparkRendererBudget(sparkSceneCapacity(renderCounts)).reservedBytes +
      [...render.sources.values()].reduce((n, s) => n + sourceOwnedBytes(s), 0);
    const transitionBytes =
      ctx.resources.retainedBytes +
      suppliedBytes +
      candidateCpuBytes +
      renderer;
    budget(
      candidateCpuBytes,
      ctx.resources.retainedBytes,
      suppliedBytes + renderer,
      worstSplats,
      placed.instances.length,
    );
    const snapshot = parseSnapshot({
      ...preliminary,
      validation: {
        requested: plan.groups.reduce((n, g) => n + g.count, 0),
        accepted: placed.instances.length,
        shortfall,
        rejections,
        usage: {
          instances: placed.instances.length,
          worstSplats,
          candidateCpuBytes,
          transitionBytes,
        },
        actualSourceBytes,
        buildMs: performance.now() - start,
      },
    });
    if (snapshot.capability !== "editable") throw Error("Snapshot capability");
    const surfaceSupport = style
      ? take(
          analyzeSurfaceSupport(
            surfaces.map((s) => ({
              kind: "float14" as const,
              count: s.count,
              data: s.data,
            })),
            terrain,
            style,
          ),
        )
      : null;
    ctx.signal.throwIfAborted();
    return { ok: true, value: { snapshot, render, report, surfaceSupport } };
  } catch (e) {
    return failure(e);
  }
}
