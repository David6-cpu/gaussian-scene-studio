import { test, expect } from "vitest";
import { makeCameraGuard, applyCameraPreset } from "./camera";
import type { GaussianView } from "./gaussian/types";
import { riversideRecipe } from "./recipe";
import { buildScene } from "./build";
import { defaultTestRecipe as r } from "../tests/support/fixtures";
test("camera stays above terrain and water and outside asset protection spheres", () => {
  const b = buildScene(r),
    guard = makeCameraGuard(b.heightfield, b.scene, b.recipe.waterLevel);
  expect(guard([0, -5, 0])[1]).toBeGreaterThanOrEqual(0.5);
  const i = b.scene.instances[0],
    out = guard(i.position);
  expect(
    Math.hypot(
      out[0] - i.position[0],
      out[1] - i.position[1],
      out[2] - i.position[2],
    ),
  ).toBeGreaterThan(0.5);
  expect(guard([20, 10, 20])).toEqual([20, 10, 20]);
});
test("an explicit display extent fits the continuous scan beyond the placement square", () => {
  const b = buildScene(riversideRecipe);
  let position: readonly number[] = [];
  const view: Pick<GaussianView, "setCamera"> = {
    setCamera(p) {
      position = p;
    },
  };
  applyCameraPreset(view, b.heightfield, "top", b.recipe.waterLevel, 6);
  // Vertical FOV50 must cover the5.2-unit source depth, including a margin.
  expect(2 * position[1] * Math.tan((25 * Math.PI) / 180)).toBeGreaterThan(5.7);
});
