import {
  importEnvironment,
  validateRecord,
  type Camera,
  type EnvironmentAsset,
  type EnvironmentRecord,
} from "./asset";
import { createEnvironmentController } from "./controller";
import { createEnvironmentStore } from "./store";
import { createEnvironmentView } from "./view";
import { encodeEnvironment, decodeEnvironment } from "./bundle";
import { downloadBlob } from "../io/download";

export function mountEnvironmentPanel(
  host: HTMLElement,
  viewerHost: HTMLElement,
  ports: { enter(): void; leave(): void },
) {
  host.innerHTML = `<details id="environment-details" class="planner-details"><summary>导入环境 · 本机预览</summary>
  <p class="footnote">打开已下载的完整环境。文件留在本机，不会调用生成服务。背景中的物体暂不可单独编辑。</p>
  <label class="planner-label">环境说明（World JSON）<input id="environment-world-file" type="file" accept=".json"></label>
  <label class="planner-label">高斯场景（SPZ，建议100k档）<input id="environment-spz-file" type="file" accept=".spz"></label>
  <label class="planner-label">生成请求记录（可选JSON）<input id="environment-request-file" type="file" accept=".json"></label>
  <div class="file-actions"><button id="environment-import">导入并预览</button><button id="environment-cancel" disabled>取消预览</button></div>
  <p id="environment-status" role="status" aria-live="polite">选择本地文件开始，原场景将保留。</p><p id="environment-info" class="footnote"></p>
  <div class="file-actions"><button id="environment-save" disabled>保存到本机</button><button id="environment-export" disabled>下载环境备份</button><button id="environment-reset" disabled>恢复总览</button><button id="environment-return" disabled>返回原场景</button></div>
  <label class="planner-label">打开环境备份（.wetenv）<input id="environment-backup-file" type="file" accept=".wetenv"></label>
  <p class="footnote">保存只表示技术导入成功，画质仍待人工验收。浏览器清理数据会删除本机记录，请下载备份。已有同版记录保留最初保存视角。</p>
  <p id="environment-library-status" role="status"></p><ul id="environment-list"></ul></details>`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    host.querySelector<T>(`#environment-${id}`)!;
  const button = (id: string) => $<HTMLButtonElement>(id);
  const store = createEnvironmentStore();
  let view: ReturnType<typeof createEnvironmentView> | undefined,
    container: HTMLDivElement | undefined;
  let active = false,
    disposed = false,
    loadTicket = 0,
    listTicket = 0,
    reading = false,
    displayFailed = false;
  const message = (s: string) => {
    $("status").textContent = s;
  };
  const closeDisplay = () => {
    view?.dispose();
    view = undefined;
    container?.remove();
    container = undefined;
    if (active) {
      active = false;
      ports.leave();
    }
    displayFailed = false;
  };
  function controls() {
    const s = controller.getState();
    button("cancel").disabled =
      !reading && !["loading", "preview", "saving"].includes(s.phase);
    button("save").disabled = s.phase !== "preview" || reading || displayFailed;
    button("export").disabled =
      !["preview", "saved"].includes(s.phase) || reading || displayFailed;
    button("return").disabled = !active && !reading;
    button("reset").disabled = !active || displayFailed;
    if (s.asset) {
      const a = s.asset;
      $("info").textContent =
        `${a.source.title} · ${a.splats.count.toLocaleString()}点 · SH${a.splats.shDegree} · 待画质验收。来源依文件声明；生成状态：${a.source.generationStatus === "unknown" ? "未知" : "已完成"}。比例 ${a.transform.scale}，地面偏移 ${a.transform.offset}，翻转 ${a.transform.flipY ? "是" : "否"}。`;
    } else $("info").textContent = "";
  }
  const controller = createEnvironmentController({
    async stage(asset, signal, camera) {
      if (!active) {
        ports.enter();
        active = true;
        container = document.createElement("div");
        container.className = "environment-view";
        const canvas = document.createElement("canvas");
        canvas.id = "environment-canvas";
        canvas.setAttribute("aria-label", "导入环境预览");
        const label = document.createElement("span");
        label.className = "environment-view-label";
        label.textContent = "导入环境 · 待画质验收";
        container.append(canvas, label);
        viewerHost.append(container);
        try {
          view = createEnvironmentView(canvas, (e) => {
            if (disposed) return;
            displayFailed = true;
            message(`环境显示中断：${String(e)}。可返回原场景。`);
            controls();
          });
        } catch (e) {
          closeDisplay();
          throw e;
        }
      }
      if (displayFailed) throw Error("环境显示已中断，请返回原场景后重开。");
      return view!.stage(asset, signal, camera);
    },
    persist: (r) => store.save(r),
    changed: (s) => {
      if (s.phase === "idle") closeDisplay();
      controls();
    },
  });
  async function refresh() {
    const id = ++listTicket;
    try {
      const records = await store.list();
      if (disposed || id !== listTicket) return;
      $("list").replaceChildren();
      for (const record of records) {
        const li = document.createElement("li"),
          b = document.createElement("button");
        b.textContent = `重新打开：${record.asset.source.title}`;
        b.onclick = () =>
          void load(async () => ({
            asset: record.asset,
            camera: record.camera,
          }));
        li.append(b);
        $("list").append(li);
      }
      $("library-status").textContent =
        `本机已保存 ${records.length} 个环境（均待画质验收）。`;
    } catch (e) {
      if (!disposed && id === listTicket) {
        $("list").replaceChildren();
        $("library-status").textContent =
          `本机记录不可读取：${String(e)}。仍可导入和下载备份。`;
      }
    }
  }
  async function bytes(file: File | undefined, limit: number) {
    if (!file) throw Error("请选择所需文件。");
    if (file.size > limit) throw Error("所选文件超过大小限制。");
    return new Uint8Array(await file.arrayBuffer());
  }
  async function load(
    read: () => Promise<{ asset: EnvironmentAsset; camera?: Camera }>,
  ) {
    const id = ++loadTicket;
    reading = true;
    message("正在读取并校验本地文件…");
    controls();
    try {
      const a = await read();
      if (disposed || id !== loadTicket) return;
      await controller.preview(a.asset, a.camera);
      if (id === loadTicket && !disposed) {
        message("预览就绪 · 请检查画面；可以取消、保存到本机或下载备份。");
      }
    } catch (e) {
      if (id === loadTicket && !disposed)
        message(`导入失败：${String(e)}。上一场景保留。`);
    } finally {
      if (id === loadTicket && !disposed) {
        reading = false;
        controls();
      }
    }
  }
  button("import").onclick = () => {
    const world = $<HTMLInputElement>("world-file").files?.[0],
      spz = $<HTMLInputElement>("spz-file").files?.[0],
      request = $<HTMLInputElement>("request-file").files?.[0];
    void load(async () => ({
      asset: await importEnvironment(
        await bytes(world, 1048576),
        await bytes(spz, 64 * 1024 ** 2),
        request ? await bytes(request, 1048576) : undefined,
      ),
    }));
  };
  button("cancel").onclick = () => {
    loadTicket++;
    reading = false;
    controller.cancel();
    message("已取消预览，上一场景保留。");
    controls();
  };
  button("return").onclick = () => {
    loadTicket++;
    reading = false;
    controller.close();
    message("已返回原场景；已发起的保存会在后台完成。");
    controls();
  };
  button("reset").onclick = () => view?.reset();
  button("save").onclick = () => {
    const id = loadTicket;
    void controller
      .save()
      .then((r) => {
        if (disposed || id !== loadTicket || !r.applied) return;
        message(
          r.duplicate
            ? "同版环境已存在，原记录和最初视角保留。"
            : "已保存到本机 · 待画质验收。建议下载环境备份。",
        );
      })
      .catch((e) => {
        if (!disposed && id === loadTicket)
          message(`环境未保存：${String(e)}。预览保留，可重试或下载备份。`);
      })
      .finally(() => {
        if (!disposed) {
          controls();
          void refresh();
        }
      });
  };
  button("export").onclick = () => {
    const s = controller.getState();
    if (!s.asset || !view) return;
    const r: EnvironmentRecord = {
      asset: s.asset,
      camera: view.camera(),
      savedAt: new Date().toISOString(),
    };
    void encodeEnvironment(r)
      .then((b) =>
        downloadBlob(
          new Blob([new Uint8Array(b).buffer], {
            type: "application/octet-stream",
          }),
          `wetland-environment-${r.asset.id.slice(0, 12)}.wetenv`,
        ),
      )
      .catch((e) => message(`备份下载失败：${String(e)}`));
  };
  $<HTMLInputElement>("backup-file").onchange = () => {
    const file = $<HTMLInputElement>("backup-file").files?.[0];
    void load(async () => {
      const r = await decodeEnvironment(await bytes(file, 65 * 1024 ** 2 + 12));
      return { asset: r.asset, camera: r.camera };
    });
  };
  void refresh();
  controls();
  return {
    get active() {
      return active;
    },
    dispose() {
      disposed = true;
      loadTicket++;
      listTicket++;
      controller.close();
      closeDisplay();
    },
  };
}
