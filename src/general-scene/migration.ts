import type { SceneBuildResult } from "../gaussian/types";
import { integer } from "../data-validation";
import { preflightStoredZip, unpackBundle } from "../io/archive";
import { decodeSceneBundle } from "../io/prepared-scene-bundle";
import { sha256 } from "../io/hash";
import { parseRecipe } from "../recipe";
import { parsePreparedRecipe } from "../prepared-scene";
import type { IOContext } from "./archive";
import { documentDigest } from "./canonical";
import {
  inspectCpuBuffer,
  parseSnapshot,
  type SceneSnapshot,
} from "./contracts";
import { GENERAL_LIMITS as L, type Result } from "./core";

const failure = (error: unknown, path: string): Result<never> => ({
  ok: false,
  issues: [
    {
      code:
        error instanceof DOMException && error.name === "AbortError"
          ? "cancelled"
          : "migration",
      path,
      message: error instanceof Error ? error.message : "Migration failed",
    },
  ],
});
function checkBudget(context: IOContext, bytes: number): void {
  context.signal.throwIfAborted();
  if (
    !Number.isSafeInteger(bytes) ||
    (context.candidateBytes ?? 0) + bytes > L.maxCandidateCpuBytes ||
    context.resources.retainedBytes + bytes > L.maxTransitionBytes
  )
    throw Error(
      "Legacy copy memory budget exceeded before allocation; original package remains available",
    );
}
/** Array reservation for the unchanged legacy decoder's canonical comparison build.
 * parseRecipe bounds extents<=10, spacing>=.1 (or .4), hence <=101² nodes.
 * sampleTerrain/shoreline retain numeric staging arrays alongside float14 output;
 * reserve two numeric-capacity slots per element rather than only final f32 bytes.
 * riverbank-water has fixed 81² traversal/mask/height buffers. Synthetic/river
 * assets always have two sources of 4096+1024 points. This is managed array
 * accounting, not a claim about total JS heap or driver memory.
 */
function generatorWorkspace(header: {
  version: number;
  recipe: unknown;
}): number {
  const recipe =
    header.version === 3
      ? parsePreparedRecipe(header.recipe)
      : parseRecipe(header.recipe);
  const nodes =
    (recipe.width / recipe.spacing + 1) * (recipe.depth / recipe.spacing + 1);
  const refined =
    recipe.algorithmVersion === "f0-shore-v2"
      ? nodes * Math.round(recipe.spacing / 0.05) ** 2
      : 0;
  const baseline = 2 * nodes * 14 * (4 + 2 * 8);
  const shoreline = 2 * refined * 14 * (4 + 2 * 8);
  const river = 81 ** 2 * (8 + 3 + 4 * 8) + 81 * 2;
  const assets = 2 * (4096 + 1024) * 14 * 4;
  return baseline + shoreline + river + assets + nodes * (4 + 1);
}

/** One bounded path for explicit copies and validation of stored originals.
 * Storage callers must retain their already-owned immutable original throughout
 * this check; this private capture is used for decoding and never issues IDs. */
async function readLegacyOriginal(
  bytes: Uint8Array,
  context: IOContext,
  expected?: { digest: string; originVersion: string },
) {
  if (
    expected &&
    (!/^[0-9a-f]{64}$/.test(expected.digest) ||
      !/^wetland-f0-v[123]$/.test(expected.originVersion))
  )
    throw Error("Invalid original legacy digest or origin version");
  if (
    !context ||
    !(context.signal instanceof AbortSignal) ||
    !context.resources
  )
    throw Error("Required legacy IO signal/resources context");
  const ctx = {
    signal: context.signal,
    candidateBytes: integer(
      context.candidateBytes ?? 0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    resources: {
      retainedBytes: integer(
        context.resources.retainedBytes,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    },
  };
  if (ctx.candidateBytes > ctx.resources.retainedBytes)
    throw Error("Legacy candidate bytes must be included in retained bytes");
  const input = inspectCpuBuffer(bytes);
  if (
    input.format !== "u8" ||
    input.byteLength > L.maxCompressedPackageBytes ||
    ctx.resources.retainedBytes < input.byteLength
  )
    throw Error("Invalid legacy input or underreported caller bytes");
  // The original policy is stricter than general archives: stored only,
  // <=14 files, <=1 MiB manifest, <=64 MiB total. Do not replace or relax it.
  preflightStoredZip(input.value as Uint8Array);
  const metadataReservation = 8 * 1024 ** 2;
  checkBudget(ctx, 2 * input.byteLength + metadataReservation);
  const original = new Uint8Array(input.value);
  const digest = await sha256(original);
  ctx.signal.throwIfAborted();
  if (expected && digest !== expected.digest)
    throw Error("Original legacy digest mismatch");
  const unpacked = unpackBundle(original),
    header = JSON.parse(unpacked.manifest);
  if (header?.format !== "wetland-f0" || ![1, 2, 3].includes(header.version))
    throw Error("Unsupported legacy package; use its original import route");
  const originVersion = `wetland-f0-v${header.version}`;
  if (expected && originVersion !== expected.originVersion)
    throw Error("Original legacy origin version mismatch");
  // Stored ZIP gives each complete member set <= original.byteLength.
  // Peak: owned ZIP + extracted members + decoded arrays + canonical encoded
  // members + concurrent encodePrepared hash copies. validatePreparedArrays'
  // arrayBytes/hash pair fits the same reservation. Canonical procedural
  // buffers and numeric staging are reserved separately above.
  // Eight 1 MiB manifest units cover bounded text/UTF-8/hash intermediates;
  // the legacy decoder still enforces its own metadata and member contracts.
  const peak =
    5 * original.byteLength + generatorWorkspace(header) + metadataReservation;
  checkBudget(ctx, peak);
  const decoded = await decodeSceneBundle(unpacked.manifest, unpacked.files);
  ctx.signal.throwIfAborted();
  const worstSplats =
    decoded.scene.terrain.count +
    (decoded.scene.water?.count ?? 0) +
    (decoded.scene.ground?.count ?? 0) +
    decoded.scene.instances.reduce((n, instance) => {
      const asset = decoded.scene.assets.find(
        (a) => a.id === instance.assetId,
      )!;
      return n + Math.max(asset.lods.full.count, asset.lods.coarse.count);
    }, 0);
  return {
    decoded,
    original,
    digest,
    originVersion,
    worstSplats,
    peak,
    candidatePeak: ctx.candidateBytes + peak,
    retainedBytes: ctx.resources.retainedBytes,
    signal: ctx.signal,
  };
}

/** The exact original decoder output, with the same digest/origin/budget path. */
export async function readLegacySceneForDisplay(
  original: { bytes: Uint8Array; digest: string },
  originVersion: string,
  context: IOContext,
): Promise<SceneBuildResult> {
  const checked = await readLegacyOriginal(original.bytes, context, {
    digest: original.digest,
    originVersion,
  });
  checked.signal.throwIfAborted();
  return checked.decoded;
}

/** Explicit readonly copy. The original decoder remains the display authority;
 * its own historical canonical-build validation is preserved, with no new
 * generation/inference, downloads or fabricated general-scene asset metadata.
 */
export async function copyLegacyScene(
  bytes: Uint8Array,
  context: IOContext,
): Promise<Result<SceneSnapshot>> {
  try {
    const {
      original,
      digest,
      originVersion,
      worstSplats,
      peak,
      candidatePeak,
      retainedBytes,
      signal,
    } = await readLegacyOriginal(bytes, context);
    signal.throwIfAborted();
    const pending = () => ({ status: "pending", evidenceRefs: [], issues: [] });
    return {
      ok: true,
      value: parseSnapshot({
        documentType: "general-scene-snapshot",
        schemaVersion: 1,
        capability: "legacy-readonly",
        sceneId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        parentRevisionId: null,
        operationId: crypto.randomUUID(),
        intent: null,
        plan: null,
        state: null,
        modelEvidence: [],
        patch: null,
        assets: [],
        surfaceStyle: null,
        terrain: null,
        water: null,
        surfaces: [],
        instances: [],
        originVersion,
        original: { digest, bytes: original },
        // The original package binds this readonly envelope. It is not evidence
        // that new general-scene geometry/semantics or visual quality passed.
        geometryDigest: digest,
        camera: { position: [6, 5, 6], target: [0, 0, 0] },
        reviewStatus: "draft",
        quality: {
          geometryDigest: digest,
          semanticMode: "unverified",
          semantic: pending(),
          assets: pending(),
          geometry: pending(),
          visual: pending(),
          performance: pending(),
        },
        validation: {
          requested: 0,
          accepted: 0,
          shortfall: 0,
          rejections: [],
          actualSourceBytes: 0,
          buildMs: 0,
          usage: {
            instances: 0,
            worstSplats,
            candidateCpuBytes: candidatePeak,
            transitionBytes: retainedBytes + peak,
          },
        },
      }),
    };
  } catch (error) {
    return failure(error, "legacy");
  }
}

/** Shared validation entry for already-owned storage/archive originals. */
export async function validateLegacyOriginal(
  original: { bytes: Uint8Array; digest: string },
  originVersion: string,
  context: IOContext,
): Promise<void> {
  const digest = original.digest,
    bytes = original.bytes;
  const checked = await readLegacyOriginal(bytes, context, {
    digest,
    originVersion,
  });
  checked.signal.throwIfAborted();
}

type MigrationReservation = { binaryBytes: number; metadataBytes: number };
/** Inspect before native cloning, without invoking getters or allocating binary
 * copies. One reservation follows the largest document seen in this operation. */
function captureDocument<T>(input: T, reservation: MigrationReservation): T {
  const seen = new Set<object>();
  let bytes = 0,
    nodes = 0,
    metadataBytes = 0;
  const charge = (amount: number): void => {
    metadataBytes += amount;
    if (metadataBytes > L.maxJsonBytes)
      throw Error("Migration metadata exceeds 2 MiB");
  };
  const chargeJson = (value: unknown): void => {
    if (typeof value === "string" && value.length > L.maxJsonBytes)
      throw Error("Migration metadata exceeds 2 MiB");
    const text = JSON.stringify(value);
    if (text.length > L.maxJsonBytes)
      throw Error("Migration metadata exceeds 2 MiB");
    charge(new TextEncoder().encode(text).byteLength);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64 || ++nodes > L.maxJsonBytes)
      throw Error("Migration document nesting/size limit");
    if (value === null || typeof value === "boolean") {
      chargeJson(value);
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw Error("Non-finite migration number");
      chargeJson(value);
      return;
    }
    if (typeof value === "string") {
      if (value.length > L.maxJsonBytes)
        throw Error("Migration metadata exceeds 2 MiB");
      chargeJson(value);
      return;
    }
    if (ArrayBuffer.isView(value)) {
      const meta = inspectCpuBuffer(value);
      // Covers the type-tagged format/length/SHA descriptor, not expanded
      // numeric JSON. Each referenced leaf is charged even when aliases exist.
      charge(128);
      bytes += meta.byteLength;
      if (bytes > L.maxCandidateCpuBytes)
        throw Error("Migration memory budget exceeded before clone/hash");
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value))
      throw Error("Non-data/cyclic migration document");
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (
      proto !== (array ? Array.prototype : Object.prototype) &&
      proto !== null
    )
      throw Error("Non-plain migration document");
    const keys = Reflect.ownKeys(value).filter(
      (k) => !(array && k === "length"),
    );
    if (array && keys.length !== value.length)
      throw Error("Sparse migration array");
    charge(2 + Math.max(0, keys.length - 1));
    seen.add(value);
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        typeof key !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        !d.enumerable ||
        !("value" in d) ||
        (array && !/^(0|[1-9][0-9]*)$/.test(key))
      )
        throw Error("Unsafe migration accessor/key");
      if (!array) {
        chargeJson(key);
        charge(1);
      }
      visit(d.value, depth + 1);
    }
    seen.delete(value);
  };
  visit(input, 0);
  const largestBinary = Math.max(reservation.binaryBytes, bytes),
    largestMetadata = Math.max(reservation.metadataBytes, metadataBytes);
  // At most current, callback output, captured next/returned copy, and the two
  // cpuBufferBytes/sha256 copies of a leaf coexist. Reserve SIX complete binary
  // documents, covering an additional clone without relying on GC timing.
  // documentDigest type tags grow short JSON atoms/containers by <16x; UTF-16
  // stringify plus UTF-8 encoding and sha256's copy add 4 bytes per character.
  // 64x metadata therefore reserves these tagged text/hash intermediates.
  // The original caller document is additionally charged to the transition.
  const candidatePeak = 6 * largestBinary + 64 * largestMetadata;
  const transitionPeak = candidatePeak + largestBinary + 2 * largestMetadata;
  if (
    candidatePeak > L.maxCandidateCpuBytes ||
    transitionPeak > L.maxTransitionBytes
  )
    throw Error("Migration memory budget exceeded before clone/hash");
  reservation.binaryBytes = largestBinary;
  reservation.metadataBytes = largestMetadata;
  const copy = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (
      !value ||
      typeof value !== "object" ||
      ArrayBuffer.isView(value) ||
      Object.isFrozen(value)
    )
      return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
type MigrationStep = { from: number; to: number; apply: (value: any) => any };
/** Pure sequential fixture-ready mechanism; v1 has no registered product v2.
 * Persistence performs its own staged atomic publication after this succeeds. */
export async function migrateDocumentCopy<T extends { schemaVersion: number }>(
  input: T,
  expectedDigest: string,
  targetVersion: number,
  steps: readonly MigrationStep[],
  validate: (value: any) => void | Promise<void>,
): Promise<Result<T>> {
  try {
    const reservation: MigrationReservation = {
      binaryBytes: 0,
      metadataBytes: 0,
    };
    let current = captureDocument(input, reservation);
    const initialVersion = integer(
      current.schemaVersion,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    integer(targetVersion, initialVersion, Number.MAX_SAFE_INTEGER);
    if (
      !/^[0-9a-f]{64}$/.test(expectedDigest) ||
      typeof validate !== "function"
    )
      throw Error("Invalid migration digest/validator");
    // Capture the registry before digesting, so callers cannot replace a step
    // while an asynchronous digest or validator is pending.
    const registry = new Map<number, MigrationStep>();
    for (const step of steps) {
      const from = integer(step.from, 1, Number.MAX_SAFE_INTEGER),
        to = integer(step.to, 1, Number.MAX_SAFE_INTEGER);
      if (
        to !== from + 1 ||
        registry.has(from) ||
        typeof step.apply !== "function"
      )
        throw Error("Migrations must have unique consecutive version steps");
      registry.set(from, { from, to, apply: step.apply });
    }
    if ((await documentDigest(current)) !== expectedDigest)
      throw Error("Migration source digest mismatch");
    while (current.schemaVersion < targetVersion) {
      const step = registry.get(current.schemaVersion);
      if (!step) throw Error("Missing sequential migration step");
      const before = await documentDigest(current),
        candidate = captureDocument(step.apply(current), reservation);
      if ((await documentDigest(current)) !== before)
        throw Error("Migration mutated its input");
      if (candidate.schemaVersion !== step.to)
        throw Error("Migration output version mismatch");
      current = candidate;
    }
    const beforeValidation = await documentDigest(current);
    await validate(current);
    if ((await documentDigest(current)) !== beforeValidation)
      throw Error("Migration validation mutated its input");
    // Validator/callback may retain its argument: returned buffers never alias it.
    return { ok: true, value: captureDocument(current, reservation) };
  } catch (error) {
    return failure(error, "migration");
  }
}
