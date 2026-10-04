import { buildScene } from "./build";
import { sourceBuffers } from "./gaussian/validate";
self.onmessage = ({ data }) => {
  const requestId = data.requestId;
  try {
    const result = buildScene(data.recipe),
      buffers = [
        ...new Set([
          ...sourceBuffers(result.scene).map((b) => b.data.buffer),
          result.heightfield.heights.buffer,
        ]),
      ];
    self.postMessage({ requestId, ok: true, result }, { transfer: buffers });
  } catch (e) {
    self.postMessage({
      requestId,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
