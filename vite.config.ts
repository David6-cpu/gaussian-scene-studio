import { defineConfig } from "vitest/config";
import { plannerPlugin } from "./src/planner/server";
import { inlineWorkerLifetimePlugin } from "./src/general-scene/inline-worker-plugin";
export default defineConfig({
  plugins: [
    inlineWorkerLifetimePlugin(),
    plannerPlugin({
      localCatalogPath: process.env.WETLAND_LOCAL_CATALOG,
      generalCatalogPath: process.env.GENERAL_SCENE_CATALOG,
    }),
  ],
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: [
        "index.html",
        "diagnostic.html",
        "tests/harness.html",
        "tests/environment-harness.html",
        "tests/general-harness.html",
      ],
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
