import {
  importEnvironment,
  type Camera,
  type EnvironmentAsset,
  type EnvironmentRecord,
} from "./asset";
import { createEnvironmentController } from "./controller";
import { createEnvironmentStore } from "./store";
import { createEnvironmentView } from "./view";
import { encodeEnvironment, decodeEnvironment } from "./bundle";
import { downloadBlob } from "../io/download";
import type { Residency } from "../general-scene/controller";
import { friendlyMessage } from "../user-message";
export type EnvironmentPanelPorts = {
  enter(): void;
  leave(): void;
  runIO<T>(
    kind: "activate" | "background",
    work: (reserve: (additionalBytes: number) => void) => Promise<T>,
    reservationBytes?: number,
  ): Promise<T>;
};
const MiB = 1024 ** 2;
// Each record has four 8192-code-unit optional strings; other fields are short.
// Two MiB covers eight metadata copies and the current JSON/hash workspace.
const METADATA_BYTES = 2 * MiB;

export function mountEnvironmentPanel(
  host: HTMLElement,
  viewerHost: HTMLElement,
  ports: EnvironmentPanelPorts,
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
  type View = ReturnType<typeof createEnvironmentView>;
  type IOOwner = {
    buffers: Set<ArrayBuffer>;
    extraBytes: number;
    work?: Promise<unknown>;
  };
  let view: View | undefined, container: HTMLDivElement | undefined;
  let active = false,
    disposed = false,
    loadTicket = 0,
    listTicket = 0,
    reading = false,
    displayFailed = false,
    queued = 0;
  const retiring = new Set<View>(),
    owners = new Set<IOOwner>();
  const downloads = new Set<Blob>();
  let records: EnvironmentRecord[] = [];
  let refreshPending: Promise<void> | undefined;
  const listButtons = new Set<HTMLButtonElement>();
  const message = (text: string) => {
    $("status").textContent = friendlyMessage(text);
  };
  const clearList = () => {
    for (const b of listButtons) b.onclick = null;
    listButtons.clear();
    records = [];
    $("list").replaceChildren();
  };
  const closeDisplay = () => {
    if (view) {
      const previous = view;
      retiring.add(previous);
      previous.dispose();
      void previous
        .whenReleased()
        .then(() => {
          retiring.delete(previous);
        })
        .catch((error) => {
          // A failed release stays resident and propagates through whenQuiescent.
          if (!disposed)
            message(`环境资源释放失败：${String(error)}。已保存记录保留。`);
        });
      view = undefined;
    }
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
    const a = s.asset;
    $("info").textContent = a
      ? `${a.source.title} · ${a.splats.count.toLocaleString()}点 · SH${a.splats.shDegree} · 待画质验收。来源依文件声明；生成状态：${a.source.generationStatus === "unknown" ? "未知" : "已完成"}。比例 ${a.transform.scale}，地面偏移 ${a.transform.offset}，翻转 ${a.transform.flipY ? "是" : "否"}。`
      : "";
  }
  const own = (owner: IOOwner, bytes: Uint8Array) => {
    if (!(bytes.buffer instanceof ArrayBuffer))
      throw Error("环境缓冲类型不受支持。");
    owner.buffers.add(bytes.buffer);
    return bytes;
  };
  function io<T>(
    kind: "activate" | "background",
    work: (owner: IOOwner, reserve: (n: number) => void) => Promise<T>,
    initial: number,
    roots: readonly ArrayBuffer[] = [],
  ) {
    const owner: IOOwner = { buffers: new Set(roots), extraBytes: 0 };
    owners.add(owner);
    queued++;
    let started = false;
    const result = ports.runIO(
      kind,
      async (reserve) => {
        started = true;
        queued--;
        if (disposed) throw new DOMException("环境面板已关闭。", "AbortError");
        const promise = Promise.resolve().then(() => work(owner, reserve));
        owner.work = promise;
        try {
          return await promise;
        } finally {
          owner.work = undefined;
        }
      },
      initial,
    );
    return result.finally(() => {
      if (!started) queued--;
      owner.buffers.clear();
      owners.delete(owner);
    });
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
            if (disposed || !active) return;
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
    persist: (record) =>
      io(
        "background",
        async (owner, reserve) =>
          store.save(record, {
            reserve,
            retain: (b) => owner.buffers.add(b),
            release: (b) => owner.buffers.delete(b),
          }),
        record.asset.spz.buffer.byteLength + 32 * MiB + METADATA_BYTES,
        [record.asset.spz.buffer as ArrayBuffer],
      ),
    changed: (s) => {
      if (s.phase === "idle") closeDisplay();
      controls();
    },
  });
  function refresh(): Promise<void> {
    if (refreshPending) return refreshPending;
    const id = ++listTicket;
    $("library-status").textContent =
      "等待读取本机记录；其他场景忙碌时会暂缓。";
    const work = io(
      "background",
      async (owner, reserve) => {
        const next = await store.list({
          reserve,
          retain: (b) => owner.buffers.add(b),
          release: (b) => owner.buffers.delete(b),
        });
        if (disposed || id !== listTicket) return;
        clearList();
        records = next;
        for (const record of records) {
          const li = document.createElement("li"),
            b = document.createElement("button");
          b.textContent = `重新打开：${record.asset.source.title}`;
          b.onclick = () =>
            void load(
              async () => ({ asset: record.asset, camera: record.camera }),
              record.asset.spz.buffer.byteLength,
              [record.asset.spz.buffer as ArrayBuffer],
            );
          listButtons.add(b);
          li.append(b);
          $("list").append(li);
        }
        $("library-status").textContent =
          `本机已保存 ${records.length} 个环境（均待画质验收）。`;
      },
      64 * MiB + METADATA_BYTES,
    ).catch((e) => {
      if (!disposed && id === listTicket) {
        // Keep an already usable list when a refresh is resource-blocked.
        $("library-status").textContent =
          `本机记录不可读取：${String(e)}。仍可导入和下载备份。`;
      }
    });
    refreshPending = work.finally(() => {
      refreshPending = undefined;
    });
    return refreshPending;
  }
  async function bytes(
    file: File | undefined,
    limit: number,
    owner: IOOwner,
    reserve: (n: number) => void,
  ) {
    if (!file) throw Error("请选择所需文件。");
    if (file.size > limit) throw Error("所选文件超过大小限制。");
    reserve(file.size);
    const value = own(owner, new Uint8Array(await file.arrayBuffer()));
    if (value.byteLength !== file.size || value.byteLength > limit)
      throw Error("所选文件实际大小与声明不一致。");
    return value;
  }
  async function load(
    read: (
      owner: IOOwner,
      reserve: (n: number) => void,
    ) => Promise<{ asset: EnvironmentAsset; camera?: Camera }>,
    initial: number,
    roots: readonly ArrayBuffer[] = [],
  ) {
    const id = ++loadTicket;
    reading = true;
    message("等待读取并校验本地文件…");
    controls();
    try {
      await io(
        "activate",
        async (owner, reserve) => {
          if (disposed || id !== loadTicket) return;
          const value = await read(owner, reserve);
          own(owner, value.asset.spz);
          if (disposed || id !== loadTicket) return;
          const padded = Math.ceil(value.asset.splats.count / 2048) * 2048;
          reserve(
            value.asset.spz.buffer.byteLength +
              value.asset.spz.byteLength +
              padded * 96 * 2 +
              8 * MiB +
              128 * padded,
          );
          try {
            await controller.preview(value.asset, value.camera);
          } finally {
            await Promise.all([
              ...(view ? [view.whenQuiescent()] : []),
              ...[...retiring].map((v) => v.whenQuiescent()),
            ]);
          }
          if (id === loadTicket && !disposed)
            message("预览就绪 · 请检查画面；可以取消、保存到本机或下载备份。");
        },
        initial,
        roots,
      );
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
    if (reading) return;
    const world = $<HTMLInputElement>("world-file").files?.[0],
      spz = $<HTMLInputElement>("spz-file").files?.[0],
      request = $<HTMLInputElement>("request-file").files?.[0];
    void load(
      async (owner, reserve) => {
        const w = await bytes(world, MiB, owner, reserve),
          p = await bytes(spz, 64 * MiB, owner, reserve),
          r = request ? await bytes(request, MiB, owner, reserve) : undefined;
        reserve(p.byteLength + 32 * MiB + METADATA_BYTES);
        return { asset: await importEnvironment(w, p, r) };
      },
      Math.min(world?.size ?? 0, MiB),
    );
  };
  button("cancel").onclick = () => {
    loadTicket++;
    reading = false;
    controller.cancel();
    message("已取消预览，上一场景保留。");
    controls();
  };
  function close() {
    loadTicket++;
    reading = false;
    controller.close();
    message("已返回原场景；已发起的保存会在后台完成。");
    controls();
  }
  button("return").onclick = close;
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
  let exporting = false;
  button("export").onclick = () => {
    const s = controller.getState();
    if (!s.asset || !view || exporting) return;
    exporting = true;
    const record: EnvironmentRecord = {
      asset: s.asset,
      camera: view.camera(),
      savedAt: new Date().toISOString(),
    };
    void io(
      "background",
      async (owner, reserve) => {
        reserve(
          record.asset.spz.buffer.byteLength +
            record.asset.spz.byteLength * 3 +
            32 * MiB +
            4 * METADATA_BYTES,
        );
        const output = own(owner, await encodeEnvironment(record));
        reserve(output.byteLength * 2);
        const copy = own(owner, new Uint8Array(output));
        const blob = new Blob([copy.buffer as ArrayBuffer], {
          type: "application/octet-stream",
        });
        downloads.add(blob);
        try {
          downloadBlob(
            blob,
            `wetland-environment-${record.asset.id.slice(0, 12)}.wetenv`,
          );
        } catch (error) {
          downloads.delete(blob);
          throw error;
        }
        // downloadBlob schedules URL revocation first, at this same five-second deadline.
        setTimeout(() => {
          downloads.delete(blob);
        }, 5000);
      },
      record.asset.spz.buffer.byteLength +
        record.asset.spz.byteLength * 3 +
        32 * MiB +
        4 * METADATA_BYTES,
      [record.asset.spz.buffer as ArrayBuffer],
    )
      .catch((e) => {
        if (!disposed) message(`备份下载失败：${String(e)}`);
      })
      .finally(() => {
        exporting = false;
      });
  };
  $<HTMLInputElement>("backup-file").onchange = () => {
    const file = $<HTMLInputElement>("backup-file").files?.[0];
    void load(
      async (owner, reserve) => {
        const input = await bytes(file, 65 * MiB + 12, owner, reserve);
        reserve(
          Math.min(64 * MiB, input.byteLength) * 2 + 32 * MiB + METADATA_BYTES,
        );
        const record = await decodeEnvironment(input);
        return { asset: record.asset, camera: record.camera };
      },
      Math.min(file?.size ?? 0, 65 * MiB + 12),
    );
  };
  function residency(): Residency {
    const buffers = new Set<ArrayBuffer>();
    const add = (b: ArrayBufferLike) => {
      if (b instanceof ArrayBuffer && b.byteLength) buffers.add(b);
    };
    const asset = controller.getState().asset;
    if (asset) add(asset.spz.buffer);
    for (const r of records) add(r.asset.spz.buffer);
    let extraBytes = [...downloads].reduce((n, blob) => n + blob.size, 0),
      settled = true;
    for (const owner of owners) {
      for (const b of owner.buffers) add(b);
      extraBytes += owner.extraBytes;
      if (owner.work) settled = false;
    }
    for (const v of [...(view ? [view] : []), ...retiring]) {
      const held = v.residency();
      for (const b of held.buffers) add(b);
      extraBytes += held.extraBytes;
      settled &&= held.settled;
    }
    return { buffers: [...buffers], extraBytes, settled };
  }
  async function whenQuiescent() {
    do {
      await Promise.allSettled(
        [...owners].flatMap((o) => (o.work ? [o.work] : [])),
      );
      await Promise.all([
        ...(view ? [view.whenQuiescent()] : []),
        ...[...retiring].map((v) => v.whenQuiescent()),
      ]);
    } while (!residency().settled);
  }
  void refresh();
  controls();
  return {
    get active() {
      return active;
    },
    close,
    residency,
    whenQuiescent,
    ioState: () => ({
      running: [...owners].filter((o) => o.work).length,
      queued,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      loadTicket++;
      listTicket++;
      controller.close();
      closeDisplay();
      clearList();
    },
  };
}
