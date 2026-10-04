import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "functional", testIgnore: /benchmark\.spec\.ts/ },
    {
      name: "benchmark",
      testMatch: /benchmark\.spec\.ts/,
      use: { headless: false },
    },
  ],
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
