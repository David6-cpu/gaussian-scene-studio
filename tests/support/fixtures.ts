import type { BuiltScene, GaussianBuffer } from "../../src/gaussian/types";
export function single(): GaussianBuffer {
  return {
    count: 1,
    data: new Float32Array([0, 0, 0, 0.3, 0.3, 0.1, 0, 0, 0, 1, 1, 0, 0, 0.95]),
  };
}
export function makeSharedFixture(): BuiltScene {
  const source: GaussianBuffer = {
    count: 2,
    data: new Float32Array([
      0, 0, 0, 0.55, 0.55, 0.1, 0, 0, 0, 1, 1, 0, 0, 0.95, 0, 0, -2, 0.55, 0.55,
      0.1, 0, 0, 0, 1, 0, 1, 0, 0.95,
    ]),
  };
  return {
    terrain: { count: 0, data: new Float32Array() },
    water: null,
    assets: [
      {
        id: "rock",
        synthetic: true,
        radius: 0.6,
        anchor: [0, 0, 0],
        supportPoints: [[0, 0, 0]],
        lods: { full: source, coarse: source },
      },
    ],
    instances: [
      {
        id: "a",
        assetId: "rock",
        position: [-0.3, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: 1,
        lod: "full",
      },
      {
        id: "b",
        assetId: "rock",
        position: [0.3, 0, 1],
        rotation: [0, 1, 0, 0],
        scale: 1,
        lod: "full",
      },
    ],
  };
}
export const defaultTestRecipe: import("../../src/gaussian/types").F0Recipe = {
  schemaVersion: 1,
  algorithmVersion: "f0-v1",
  recipeSource: "manual",
  seed: 20261002,
  width: 10,
  depth: 10,
  spacing: 0.2,
  amplitude: 0.6,
  octaves: 3,
  tangentFactor: 0.75,
  normalFactor: 0.1,
  opacity: 0.95,
  waterLevel: 0,
  requested: { rock: 10, reed: 10 },
  lodEnabled: true,
};
