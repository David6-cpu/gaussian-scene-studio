import { createHash } from "node:crypto";
export const API_ROOT = "https://api.worldlabs.ai/marble/v1";
export const BUDGET_USD = 1.3;
export const ESTIMATED_CREDITS = 1580;
export const CREDITS_PER_USD = 1250;
export const PRICE_CHECKED_ON = "2026-10-09";
export const USER_INTENT = "河岸上放一些低矮草丛和石头";
// Proposed text for user review before any real execution, not a generated scene.
export const TRIAL_REQUEST = Object.freeze({
  display_name: "Wetland riverbank single trial v1",
  model: "marble-1.1",
  permission: Object.freeze({
    public: false,
    allow_id_access: false,
    allowed_readers: Object.freeze([]),
    allowed_writers: Object.freeze([]),
  }),
  world_prompt: Object.freeze({
    type: "text",
    text_prompt:
      "A realistic natural wetland riverbank in daylight. A clearly visible narrow river runs alongside a continuous muddy bank. Small separate clumps of low grass and a few natural stones sit on the bank above the water. Keep the water channel, shoreline, grass and stones distinguishable at human eye level. No buildings, people, text, giant rocks, tall reeds or floating objects.",
    disable_recaption: true,
  }),
});
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const REQUEST_BYTES = JSON.stringify(TRIAL_REQUEST, null, 2) + "\n";
export const REQUEST_SHA = sha256(REQUEST_BYTES);
export function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
    throw Error("invalid-identifier");
  return value;
}
