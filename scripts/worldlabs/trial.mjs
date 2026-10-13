import { join } from "node:path";
import {
  TRIAL_REQUEST,
  REQUEST_BYTES,
  REQUEST_SHA,
  sha256,
  BUDGET_USD,
  ESTIMATED_CREDITS,
  CREDITS_PER_USD,
  PRICE_CHECKED_ON,
  identifier,
} from "./request.mjs";
import {
  directory,
  exists,
  readBytes,
  readJson,
  exclusive,
  atomic,
  saveJson,
  locked,
} from "./storage.mjs";
import { apiJson, assetUrl, fetchBytes, HttpResponseError } from "./http.mjs";
import { normalizeWorld, worldIdentity } from "./world.mjs";
import { inspectSpz, SOURCE_LIMIT } from "../../src/environment/spz.ts";
async function load(dir) {
  const request = await readBytes(join(dir, "request.json"));
  if (sha256(request) !== REQUEST_SHA) throw Error("frozen-request-mismatch");
  const state = await readJson(join(dir, "state.json"));
  if (state.schema !== 1 || state.requestSha !== REQUEST_SHA)
    throw Error("invalid-trial-state");
  return state;
}
export async function prepareTrial(dir) {
  await directory(dir);
  return locked(dir, async () => {
    if (await exists(join(dir, "request.json"))) return readTrial(dir);
    if (
      (await exists(join(dir, "submission.json"))) ||
      (await exists(join(dir, "state.json")))
    )
      throw Error("partial-trial: manual review required");
    await exclusive(dir, "request.json", REQUEST_BYTES);
    const state = {
      schema: 1,
      status: "prepared",
      requestSha: REQUEST_SHA,
      operationId: null,
      estimatedUsd: ESTIMATED_CREDITS / CREDITS_PER_USD,
      budgetUsd: BUDGET_USD,
      actualCredits: null,
      createdAt: new Date().toISOString(),
    };
    await saveJson(dir, "state.json", state);
    return state;
  });
}
export async function readTrial(dir) {
  const state = await load(dir);
  const spent = await exists(join(dir, "submission.json"));
  return {
    ...state,
    ...(spent && state.status === "prepared"
      ? { status: "submission-unknown" }
      : {}),
    attemptConsumed: spent,
  };
}
export async function submitTrial(dir, options) {
  const {
    approvePaidOnce,
    requestSha,
    priceDate,
    now = new Date(),
    key,
    fetchImpl,
  } = options;
  if (
    approvePaidOnce !== true ||
    requestSha !== REQUEST_SHA ||
    priceDate !== now.toISOString().slice(0, 10) ||
    priceDate !== PRICE_CHECKED_ON
  )
    throw Error("explicit-current-approval-required");
  if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key))
    throw Error("credential-unavailable");
  if (ESTIMATED_CREDITS / CREDITS_PER_USD > BUDGET_USD)
    throw Error("estimated-budget-exceeded");
  return locked(dir, async () => {
    const state = await load(dir);
    if (
      state.status !== "prepared" ||
      (await exists(join(dir, "submission.json")))
    )
      throw Error("attempt-already-consumed: GET recovery only");
    await exclusive(
      dir,
      "submission.json",
      JSON.stringify({
        requestSha: REQUEST_SHA,
        priceDate,
        budgetUsd: BUDGET_USD,
        startedAt: now.toISOString(),
      }) + "\n",
    );
    state.status = "submission-unknown";
    await saveJson(dir, "state.json", state);
    try {
      const operation = await apiJson("/worlds:generate", {
        key,
        fetchImpl,
        body: REQUEST_BYTES,
      });
      const id = identifier(operation?.operation_id);
      if (typeof operation.done !== "boolean") throw Error("invalid-operation");
      // Poll later even if a fast response is already complete; no automatic follow-up.
      state.operationId = id;
      state.status = "submitted";
      await saveJson(dir, "state.json", state);
      return readTrial(dir);
    } catch (error) {
      // Marker has been durably consumed regardless of what the server may have done.
      if (error instanceof HttpResponseError) {
        let saved = false;
        try {
          await exclusive(
            dir,
            "submit-error.json",
            JSON.stringify(
              {
                schema: 1,
                phase: "submit",
                requestSha: REQUEST_SHA,
                recordedAt: new Date().toISOString(),
                httpStatus: error.httpStatus,
                redirected: error.redirected,
                responseBodyStored: false,
              },
              null,
              2,
            ) + "\n",
          );
          saved = true;
        } catch {
          /* Preserve any existing evidence and the original HTTP diagnosis. */
        }
        throw Error(
          `submission-unknown: ${error.message}${saved ? "" : "; diagnostic-not-saved"}; do not submit again`,
        );
      }
      throw Error(
        `submission-unknown: ${["http-rejected", "invalid-provider-json", "invalid-operation", "invalid-identifier", "response-size-rejected"].includes(error.message) ? error.message : "request-or-recording-failed"}; do not submit again`,
      );
    }
  });
}
export async function pollTrial(dir, options) {
  return locked(dir, async () => {
    const state = await load(dir);
    if (!(await exists(join(dir, "submission.json"))))
      throw Error("no-submission-to-recover");
    let id = state.operationId ?? state.candidateOperationId;
    if (options.operationId !== undefined) {
      if (
        options.requestSha !== REQUEST_SHA ||
        (state.operationId !== null &&
          state.operationId !== options.operationId)
      )
        throw Error("recovery-confirmation-required");
      id = identifier(options.operationId);
    }
    if (!id)
      throw Error(
        "operation-id-required: inspect official account; never re-submit",
      );
    if (state.status === "downloaded") return readTrial(dir);
    const op = await apiJson("/operations/" + identifier(id), options);
    if (op?.operation_id !== id || typeof op.done !== "boolean")
      throw Error("operation-identity-mismatch");
    const recovering = state.operationId === null;
    if (recovering) {
      // User-supplied IDs are provisional until the matching private World is verified.
      state.candidateOperationId = id;
      state.candidateCredits = null;
    }
    if (!op.done) {
      if (op.error) throw Error("invalid-operation");
      state.status = "running";
      await saveJson(dir, "state.json", state);
      return readTrial(dir);
    }
    if (op.error) {
      state.status = "provider-failed";
      await saveJson(dir, "state.json", state);
      return readTrial(dir);
    }
    state.status = "completion-unverified";
    const credits = op.cost?.total_credits;
    if (
      credits !== undefined &&
      credits !== null &&
      (!Number.isSafeInteger(credits) || credits < 0)
    )
      throw Error("invalid-operation-cost");
    if (recovering) state.candidateCredits = credits ?? null;
    else {
      state.actualCredits = credits ?? state.actualCredits ?? null;
      state.budgetExceeded =
        state.actualCredits == null
          ? null
          : state.actualCredits / CREDITS_PER_USD > BUDGET_USD;
    }
    // Preserve completion/cost even when asset or identity validation subsequently rejects.
    await saveJson(dir, "state.json", state);
    const response = op.response?.world ?? op.response;
    let worldId;
    if (response?.world_id !== undefined || response?.id !== undefined)
      worldId = worldIdentity(response);
    else worldId = identifier(op.metadata?.world_id);
    if (op.metadata?.world_id !== undefined && op.metadata.world_id !== worldId)
      throw Error("conflicting-world-identity");
    state.worldId = worldId;
    await saveJson(dir, "state.json", state);
    let world;
    try {
      world = normalizeWorld(response, worldId);
    } catch (error) {
      if (error.message !== "world-metadata-missing") throw error;
      // Official completion snapshots may lack World fields; one free GET can resolve them.
      const full = await apiJson("/worlds/" + worldId, options);
      world = normalizeWorld(full, worldId);
    }
    const bytes = JSON.stringify(world, null, 2) + "\n";
    await atomic(dir, "world.json", bytes);
    state.worldSha = sha256(bytes);
    state.status = "completed";
    if (recovering) {
      state.operationId = id;
      state.actualCredits = credits ?? null;
      state.budgetExceeded =
        credits == null ? null : credits / CREDITS_PER_USD > BUDGET_USD;
      state.candidateOperationId = null;
      state.candidateCredits = null;
    }
    await saveJson(dir, "state.json", state);
    return readTrial(dir);
  });
}
export async function downloadTrial(dir, { fetchImpl } = {}) {
  return locked(dir, async () => {
    const state = await load(dir);
    if (
      !["completed", "download-rejected", "downloaded"].includes(
        state.status,
      ) ||
      !state.operationId ||
      !state.worldSha
    )
      throw Error("world-not-ready");
    const worldBytes = await readBytes(join(dir, "world.json"));
    if (sha256(worldBytes) !== state.worldSha)
      throw Error("world-file-mismatch");
    const world = normalizeWorld(JSON.parse(worldBytes), state.worldId);
    try {
      let bytes, receipt;
      if (await exists(join(dir, "environment-100k.spz"))) {
        bytes = await readBytes(
          join(dir, "environment-100k.spz"),
          SOURCE_LIMIT,
        );
        receipt = await readJson(join(dir, "download.json"));
        if (
          receipt.sha256 !== sha256(bytes) ||
          receipt.worldSha !== state.worldSha
        )
          throw Error("cached-asset-mismatch");
      } else {
        bytes = await fetchBytes(
          assetUrl(world.assets.splats.spz_urls["100k"]),
          { method: "GET", headers: {} },
          SOURCE_LIMIT,
          fetchImpl,
        );
      }
      const info = inspectSpz(bytes);
      receipt = {
        schema: 1,
        ...info,
        bytes: bytes.length,
        sha256: sha256(bytes),
        worldSha: state.worldSha,
        requestSha: REQUEST_SHA,
        operationId: state.operationId,
        sourceUrlSha: sha256(world.assets.splats.spz_urls["100k"]),
        quality: "visual-pending",
        validatedAt: new Date().toISOString(),
      };
      // Write receipt first: an interrupted write of asset bytes cannot look like a valid cached download.
      await saveJson(dir, "download.json", receipt);
      await atomic(dir, "environment-100k.spz", bytes);
      await saveJson(dir, "request-record.json", {
        status: "completed",
        request_id: state.operationId,
        request: TRIAL_REQUEST,
        request_sha256: REQUEST_SHA,
        actual_credits: state.actualCredits,
        quality: "visual-pending",
      });
      state.status = "downloaded";
      state.quality = "visual-pending";
      state.spzSha = receipt.sha256;
      await saveJson(dir, "state.json", state);
      return readTrial(dir);
    } catch (error) {
      state.status = "download-rejected";
      await saveJson(dir, "state.json", state);
      throw Error(
        `download-rejected: ${["cached-asset-mismatch", "http-rejected", "response-size-rejected", "response-length-mismatch"].includes(error.message) ? error.message : "asset-integrity-format-or-transfer"}; no generation retry`,
      );
    }
  });
}
