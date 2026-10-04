import { createGaussianView } from "../../src/gaussian/view";
import { makeSharedFixture, defaultTestRecipe } from "./fixtures";
import { makeHeightField } from "../../src/terrain/heightfield";
import { makeSyntheticAssets } from "../../src/assets/synthetic";
import { placeAssets } from "../../src/assets/placement";
import { sampleTerrain } from "../../src/terrain/sampling";
import type { GaussianView } from "../../src/gaussian/types";
import { sparkProbe } from "./spark-observer";
declare global {
  interface Window {
    currentScene: import("../../src/gaussian/types").BuiltScene;
    testView: GaussianView;
    fixture: typeof makeSharedFixture;
    ready: boolean;
    failure?: string;
    sparkProbe: typeof sparkProbe;
    createTestView: typeof createGaussianView;
  }
}
try {
  window.sparkProbe = sparkProbe;
  window.createTestView = createGaussianView;
  const view = await createGaussianView(document.querySelector("canvas")!);
  window.testView = view;
  window.fixture = makeSharedFixture;
  view.resize(1280, 720, 1);
  view.setCamera([0, 0, 8], [0, 0, 0]);
  const params = new URLSearchParams(location.search),
    assetMode = params.has("assets"),
    terrainMode = assetMode || params.has("terrain");
  const field = makeHeightField(defaultTestRecipe),
    assets = assetMode ? makeSyntheticAssets() : [],
    count = Number(params.get("count") ?? 20);
  const recipe = {
    ...defaultTestRecipe,
    requested: { rock: Math.ceil(count / 2), reed: Math.floor(count / 2) },
  };
  window.currentScene = terrainMode
    ? {
        ...sampleTerrain(field, recipe),
        assets,
        instances: assetMode
          ? placeAssets(field, recipe, assets).instances
          : [],
      }
    : makeSharedFixture();
  await view.setScene(window.currentScene);
  view.setLodEnabled(assetMode);
  function tick() {
    window.testView.render();
    requestAnimationFrame(tick);
  }
  tick();
  window.ready = true;
} catch (e) {
  window.failure = String(e);
  document.body.append(String(e));
}
