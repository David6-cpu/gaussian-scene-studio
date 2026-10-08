import { createEnvironmentStore } from "../src/environment/store";
import { importEnvironment } from "../src/environment/asset";
import { createEnvironmentView } from "../src/environment/view";
import {
  environmentWorld,
  environmentSpz,
  jsonBytes,
} from "./support/environment-fixture";
const store = createEnvironmentStore();
let view: ReturnType<typeof createEnvironmentView> | undefined;
(window as any).environmentTest = {
  store,
  async record(title: string) {
    const world = environmentWorld();
    world.display_name = title;
    return {
      asset: await importEnvironment(jsonBytes(world), environmentSpz()),
      camera: { position: [5, 4, 8], target: [0, 0, 0] },
      savedAt: "2026-10-07T00:00:00.000Z",
    };
  },
  async corrupt(id: string) {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open("wetland-environments-v1", 1);
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction("records", "readwrite"),
          s = tx.objectStore("records"),
          q = s.get(id);
        q.onsuccess = () => {
          const v = q.result;
          v.asset.transform.scale = 9;
          s.put(v);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
  },
  async render(flip: boolean, version = 2) {
    view ??= createEnvironmentView(document.querySelector("canvas")!, (e) => {
      throw e;
    });
    const a = await importEnvironment(
      jsonBytes(environmentWorld(flip)),
      environmentSpz(version, 3),
    );
    const stage = await view.stage(a, new AbortController().signal);
    stage.commit();
    return view.diagnostics();
  },
  async release() {
    view?.dispose();
    return view?.diagnostics();
  },
};
