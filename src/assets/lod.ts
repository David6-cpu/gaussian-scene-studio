import type { Instance } from "../gaussian/types";
export function chooseLod(
  px: number,
  previous: Instance["lod"],
): Instance["lod"] {
  return px < 24 ? "coarse" : px > 32 ? "full" : previous;
}
