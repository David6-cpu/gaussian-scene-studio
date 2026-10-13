import { TRIAL_REQUEST, identifier } from "./request.mjs";
import { assetUrl } from "./http.mjs";
function object(v) {
  if (v == null) throw Error("world-metadata-missing");
  if (typeof v !== "object" || Array.isArray(v))
    throw Error("world-metadata-invalid");
  return v;
}
export function worldIdentity(raw) {
  const w = object(raw?.world ?? raw);
  if (w.id !== undefined && w.world_id !== undefined && w.id !== w.world_id)
    throw Error("conflicting-world-identity");
  return identifier(w.world_id ?? w.id);
}
export function normalizeWorld(raw, expectedId) {
  const w = object(raw?.world ?? raw);
  let missing = false;
  const check = (value, test, error) => {
    if (value == null) missing = true;
    else if (!test(value)) throw Error(error);
  };
  const optionalObject = (value) =>
    value == null ? ((missing = true), undefined) : object(value);
  // Check every supplied field before classifying the snapshot as incomplete.
  // Missing model plus explicit public:true must still be a contradiction.
  if (w.id != null || w.world_id != null) {
    if (worldIdentity(w) !== expectedId)
      throw Error("world-identity-unverified");
  } else missing = true;
  check(w.model, (v) => v === TRIAL_REQUEST.model, "world-identity-unverified");
  check(
    w.display_name,
    (v) => v === TRIAL_REQUEST.display_name,
    "world-identity-unverified",
  );
  const permission = optionalObject(w.permission);
  if (permission) {
    for (const field of ["public", "allow_id_access"])
      check(permission[field], (v) => v === false, "world-privacy-unverified");
    for (const field of ["allowed_readers", "allowed_writers"])
      check(
        permission[field],
        (v) => Array.isArray(v) && v.length === 0,
        "world-privacy-unverified",
      );
  }
  const prompt = optionalObject(w.world_prompt);
  if (prompt) {
    check(prompt.type, (v) => v === "text", "world-prompt-mismatch");
    check(
      prompt.text_prompt,
      (v) => v === TRIAL_REQUEST.world_prompt.text_prompt,
      "world-prompt-mismatch",
    );
  }
  const assets = optionalObject(w.assets),
    splats = optionalObject(assets?.splats),
    semantics = optionalObject(splats?.semantics_metadata);
  const scale = semantics?.metric_scale_factor,
    offset = semantics?.ground_plane_offset,
    flip = semantics?.flip_y;
  check(
    scale,
    (v) => Number.isFinite(v) && v > 0 && v <= 1000,
    "world-transform-invalid",
  );
  check(
    offset,
    (v) => Number.isFinite(v) && Math.abs(v) <= 10000,
    "world-transform-invalid",
  );
  if (flip !== undefined && typeof flip !== "boolean")
    throw Error("world-transform-invalid");
  const urls = optionalObject(splats?.spz_urls);
  let url;
  if (urls?.["100k"] == null) missing = true;
  else url = assetUrl(urls["100k"]);
  if (missing) throw Error("world-metadata-missing");
  // Persist only fields used by the importer, never arbitrary response/error objects.
  return {
    world_id: expectedId,
    display_name: w.display_name,
    model: w.model,
    permission: structuredClone(TRIAL_REQUEST.permission),
    world_prompt: { type: "text", text_prompt: prompt.text_prompt },
    assets: {
      splats: {
        spz_urls: { "100k": url },
        semantics_metadata: {
          metric_scale_factor: scale,
          ground_plane_offset: offset,
          ...(flip === undefined ? {} : { flip_y: flip }),
        },
      },
    },
  };
}
