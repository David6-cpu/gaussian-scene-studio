import { TRIAL_REQUEST } from "./request.mjs";
export function simulatedWorld() {
  return {
    world_id: "offline-world-1",
    display_name: TRIAL_REQUEST.display_name,
    model: TRIAL_REQUEST.model,
    permission: structuredClone(TRIAL_REQUEST.permission),
    world_prompt: {
      type: "text",
      text_prompt: TRIAL_REQUEST.world_prompt.text_prompt,
    },
    assets: {
      splats: {
        spz_urls: {
          "100k": "https://cdn.marble.worldlabs.ai/offline-test-fixture.spz",
          "500k": "https://example.invalid/never-use.spz",
        },
        semantics_metadata: {
          metric_scale_factor: 2,
          ground_plane_offset: 0.5,
        },
      },
    },
  };
}
export const simulatedOperation = () => ({
  operation_id: "op-1",
  done: true,
  response: simulatedWorld(),
  cost: { total_credits: 1580 },
});
