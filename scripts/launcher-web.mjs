// Vite owns process-exit hooks. Keep them in this owned child, away from the model supervisor.
import { build, preview } from "vite";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { statusMiddleware } from "./launcher-status.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const state = {
  phase: "preparing",
  message: "正在准备本机网页…",
  model: "qwen2.5-3b-instruct-q4_k_m",
  verified: false,
};
let web,
  disconnected = false;
process.on("message", (message) => {
  if (message?.state) Object.assign(state, message.state);
});
process.on("disconnect", async () => {
  disconnected = true;
  await web?.close();
});
try {
  await build({ root, logLevel: "error" });
  if (!disconnected) {
    web = await preview({
      root,
      logLevel: "error",
      preview: { host: "127.0.0.1", port: 4173, strictPort: true },
      plugins: [
        {
          name: "local-launcher-status",
          enforce: "pre",
          configurePreviewServer(server) {
            server.middlewares.use(
              statusMiddleware(state, () => {
                if (process.connected) process.send({ stop: true });
              }),
            );
          },
        },
      ],
    });
    if (disconnected) await web.close();
    else process.send({ ready: true });
  }
} catch (error) {
  console.error(error.message);
  await web?.close();
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
