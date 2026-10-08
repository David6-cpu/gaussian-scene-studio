import { defineConfig } from "vitest/config";
import { plannerPlugin } from "./src/planner/server";
export default defineConfig({
  plugins: [plannerPlugin({localCatalogPath:process.env.WETLAND_LOCAL_CATALOG})],
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    rollupOptions: {
      input: ["index.html", "diagnostic.html", "tests/harness.html", "tests/environment-harness.html"],
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
