import { defineConfig } from "vitest/config";
import { plannerPlugin } from "./src/planner/server";
export default defineConfig({
  plugins: [plannerPlugin()],
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    rollupOptions: {
      input: ["index.html", "diagnostic.html", "tests/harness.html"],
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
