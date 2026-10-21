import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const moduleOptions = `{
          type: "module",
          name: options?.name
        }`;
// Pinned Vite 8.3.2 wrapper, excluding the first-line JSON source literal.
// A changed upstream wrapper must fail the build instead of losing URL ownership.
const knownWrapper = `
            const blob = typeof self !== "undefined" && self.Blob && new Blob(['URL.revokeObjectURL(import.meta.url);',jsContent], { type: "text/javascript;charset=utf-8" });
            export default function WorkerWrapper(options) {
              let objURL;
              try {
                objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);
                if (!objURL) throw ''
                const worker = new Worker(objURL, ${moduleOptions});
                worker.addEventListener("error", () => {
                  (self.URL || self.webkitURL).revokeObjectURL(objURL);
                });
                return worker;
              } catch(e) {
                return new Worker(
                  'data:text/javascript;charset=utf-8,' + encodeURIComponent(jsContent),
                  ${moduleOptions}
                );
              }
            }`;

export function ownInlineWorkerUrl(code: string): string {
  const end = code.indexOf("\n"),
    header = code.slice(0, end),
    prefix = "const jsContent = ";
  if (
    end < 0 ||
    !header.startsWith(prefix) ||
    !header.endsWith(";") ||
    code.slice(end) !== knownWrapper
  )
    throw Error(
      "Unsupported Vite inline worker wrapper; URL ownership not verified",
    );
  if (typeof JSON.parse(header.slice(prefix.length, -1)) !== "string")
    throw Error("Invalid Vite inline worker source literal");
  return (
    header +
    knownWrapper
      .replace(
        "              let objURL;",
        `              let objURL;
              const releaseUrl = () => {
                if (objURL) {
                  (self.URL || self.webkitURL).revokeObjectURL(objURL);
                  objURL = undefined;
                }
              };`,
      )
      .replace(
        `                worker.addEventListener("error", () => {
                  (self.URL || self.webkitURL).revokeObjectURL(objURL);
                });`,
        `                worker.addEventListener("error", releaseUrl);`,
      )
      .replace(
        "                return worker;",
        `                const terminate = worker.terminate.bind(worker);
                worker.terminate = () => {
                  try { return terminate(); }
                  finally { releaseUrl(); }
                };
                return worker;`,
      )
      .replace(
        "              } catch(e) {",
        "              } catch(e) {\n                releaseUrl();",
      )
  );
}

/** Only the general compiler's production inline wrapper owns this extra cleanup. */
export function inlineWorkerLifetimePlugin(): Plugin {
  const id =
    fileURLToPath(new URL("./build.worker.ts", import.meta.url)) +
    "?worker&inline";
  return {
    name: "general-scene-inline-worker-lifetime",
    apply: "build",
    enforce: "pre",
    transform(code, source) {
      if (source !== id) return null;
      return {
        code: ownInlineWorkerUrl(code),
        map: null,
        meta: { generalSceneInlineUrlOwned: true },
      };
    },
    generateBundle() {
      if (this.getModuleInfo(id)?.meta.generalSceneInlineUrlOwned !== true)
        throw Error("General inline worker URL ownership was not applied");
    },
  };
}
