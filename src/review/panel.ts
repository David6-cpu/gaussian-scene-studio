import type { SceneBuildResult, BuildResult } from "../gaussian/types";
import type { CatalogContext } from "../assets/catalog/context";
import { candidateSnapshot, proceduralIds } from "../selection/contract";
import { parseChoiceEvidence } from "../selection/service";
import { LLAMA_SMALL_MODEL, errorText } from "../planner/service";
import { waterRequirement } from "../review-v2/water";
import { defaultReviewRequestV2 } from "../review-v2/requirements";
import { draftWaterResolution } from "../review-v2/draft";
import { parseRequirementEvidenceV2 } from "../review-v2/service";
import { downloadBlob } from "../io/download";
import {
  createReviewDraft,
  editReviewDraft,
  resolveReviewRequest,
  confirmReviewProcedural,
  setReviewSelection,
  compileReview,
  type ReviewDraft,
  type ReviewEdits,
  type ResolvedReview,
  isV2,
} from "./versions";
import { reviewSummary } from "./versions";
import {
  loadReviewHistory,
  importReviewRecord,
  type SceneReviewRecord,
} from "./versions";
import type { PreviewController } from "./preview-controller";

export interface ReviewBinding {
  preview: PreviewController<ResolvedReview, SceneReviewRecord>["preview"];
  use: PreviewController<ResolvedReview, SceneReviewRecord>["use"];
  cancel: () => void;
  getCommitted: () => SceneBuildResult | null;
}
export function mountSceneReview(
  host: HTMLElement,
  binding: ReviewBinding,
  context: CatalogContext,
): { invalidate: (reason: string) => void; dispose: () => void } {
  host.innerHTML = `<p id="review-model" class="footnote">正在检查本机模型…</p>
    <label class="review-label" for="review-prompt">你想探索怎样的河岸？</label>
    <textarea id="review-prompt" maxlength="1000" rows="3" placeholder="河岸上放一些低矮草丛和石头"></textarea>
    <div class="review-actions"><button id="review-interpret" class="primary">理解描述</button><button id="review-manual">手动设置</button></div>
    <section id="review-persistence" class="review-summary" aria-live="polite" hidden></section>
    <p id="review-source" class="footnote">试用示例，水面观感仍待改进；尚未解释你的描述。</p>
    <section id="review-summary" class="review-summary" aria-label="场景摘要"><p>写下想法，再核对水体、植物与石头的处理方式。</p></section>
    <fieldset id="review-adjust" disabled><legend>调整这次场景</legend>
      <label>水体<select id="review-water"><option value="keep">保留描述中的要求</option><option value="on">有水</option><option value="off">无水</option></select></label>
      <label>植物<select id="review-plant"><option value="keep">保留描述中的植物</option><option value="grass">低矮草丛</option><option value="reed">芦苇</option><option value="none">不添加植物</option></select></label>
      <label>疏密<select id="review-density"><option value="keep">保留原数量</option><option value="sparse">稀疏 · 4丛</option><option value="medium">适中 · 6丛</option><option value="dense">较密 · 10丛</option></select></label>
      <div id="review-rock-options" hidden><p>缺少可单独添加的真实石头，请选择：</p>
        <label class="review-choice"><input id="review-rock-placeholder" name="review-rock" type="radio"> 用简化石头试摆（非实拍）</label>
        <label class="review-choice"><input id="review-rock-omit" name="review-rock" type="radio"> 这次暂不添加，保留需求记录</label></div>
      <label class="review-choice"><input id="review-procedural" type="checkbox"> 允许预览标出的示意草丛／石头（非实拍）</label>
    </fieldset>
    <div class="review-actions"><button id="review-preview" class="primary" disabled>生成预览</button><button id="review-cancel" disabled>取消预览</button></div>
    <p id="review-status" role="status" aria-live="polite" data-phase="draft">先核对摘要，再试看；预览不会写入历史。</p>
    <button id="review-use" class="review-use primary" disabled>使用此场景</button>
    <p class="footnote">点击使用后才保存审阅记录。固定小范围河岸，尚不支持任意环境或指定物体位置。</p>
    <details class="review-records"><summary>已使用的场景与记录</summary>
      <div class="review-actions"><button id="review-save" disabled>下载审阅记录</button><button id="review-open">打开审阅记录</button></div>
      <input id="review-file" type="file" accept=".wetland-review.json,.json" hidden>
      <label>本机记录<select id="review-history"></select></label><button id="review-reopen" disabled>重新审阅</button><p id="review-storage" class="footnote"></p>
    </details>
    <details id="review-debug"><summary>审阅技术记录</summary><pre id="review-evidence"></pre></details>`;
  const node = <T extends HTMLElement = HTMLElement>(name: string) =>
    host.querySelector<T>(`#review-${name}`)!;
  const button = (name: string) => node<HTMLButtonElement>(name);
  const prompt = node<HTMLTextAreaElement>("prompt"),
    consent = node<HTMLInputElement>("procedural");
  const debug = node("debug"),
    evidence = node("evidence");
  document.querySelector("#advanced-compat")?.append(debug);
  let revision = 0,
    request: AbortController | null = null,
    busy = false,
    disposed = false;
  let draft: ReviewDraft | null = null,
    candidate: BuildResult | undefined,
    ticket: number | null = null;
  let mode: "model" | "manual" | "archive" = "manual",
    latest: SceneReviewRecord | null = null,
    history: SceneReviewRecord[] = [];
  let lastError: string | null = null;
  let historyRevision = 0;
  const unsaved = new Map<
    string,
    { record: SceneReviewRecord; error: string | null }
  >();
  const unavailable = context.prepared !== null;
  function downloadRecord(record: SceneReviewRecord) {
    downloadBlob(
      new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }),
      `scene-${record.id}.wetland-review.json`,
    );
  }
  function renderPersistence() {
    const content: HTMLElement[] = [];
    for (const item of unsaved.values()) {
      const line = document.createElement("p");
      line.textContent = `${item.record.draft.prompt.slice(0, 60)}：${item.error ?? "场景已使用，记录正在保存；此时不能撤销已使用的场景。"}`;
      content.push(line);
      if (item.error) {
        const download = document.createElement("button");
        download.textContent = "下载这条未保存记录";
        download.onclick = () => downloadRecord(item.record);
        content.push(download);
      }
    }
    node("persistence").replaceChildren(...content);
    node("persistence").hidden = content.length === 0;
  }
  function message(phase: string, text: string) {
    node("status").dataset.phase = phase;
    node("status").textContent = text;
  }
  function diagnostic(error?: unknown) {
    if (error !== undefined) lastError = errorText(error);
    evidence.textContent = JSON.stringify(
      { draft, lastError, latest },
      null,
      2,
    );
  }
  function candidates() {
    if (!draft) throw Error("请先理解描述或主动选择手动设置。");
    const effective = resolveReviewRequest(draft, context);
    return {
      effective,
      choices: candidateSnapshot(effective, context).map((s) => ({
        key: s.key,
        assetId: s.assetIds[0],
      })),
    };
  }
  function render() {
    button("interpret").disabled = busy || unavailable;
    button("manual").disabled = unavailable;
    node<HTMLFieldSetElement>("adjust").disabled =
      !draft || busy || unavailable;
    button("cancel").disabled = !busy && ticket === null;
    button("use").disabled = busy || ticket === null;
    button("save").disabled = latest === null;
    button("reopen").disabled = history.length === 0;
    node("rock-options").hidden = !draft?.originalRequest.rockCount;
    node<HTMLInputElement>("rock-placeholder").checked =
      draft?.edits.rock === "placeholder";
    node<HTMLInputElement>("rock-omit").checked = draft?.edits.rock === "omit";
    consent.checked = Boolean(draft?.confirmedProceduralIds.length);
    consent.disabled = true;
    let ready = false;
    if (draft) {
      const summary = reviewSummary(draft, candidate, context);
      const content = [
        ...summary.lines,
        ...summary.blockers,
        ...summary.warnings,
      ].map((text) => {
        const p = document.createElement("p");
        p.textContent = text;
        return p;
      });
      node("summary").replaceChildren(...content);
      for (const [name, key] of [
        ["water", "water"],
        ["plant", "plantKind"],
        ["density", "density"],
      ] as const)
        node<HTMLSelectElement>(name).value = draft.edits[key];
      try {
        const { choices } = candidates(),
          ids = proceduralIds(choices, context);
        consent.disabled = !ids.length || busy;
        ready = ids.every((id) => draft!.confirmedProceduralIds.includes(id));
      } catch (error) {
        // A disabled button must retain the actionable reason in the ordinary flow.
        if (
          draft.edits.rock !== "unresolved" &&
          (!isV2(draft) ||
            draftWaterResolution(draft, context).status === "ready")
        ) {
          const blocker = document.createElement("p");
          blocker.textContent = `暂不能预览：${errorText(error)} 请修改描述后重新理解，或主动选择手动设置；不会自动替换需求。`;
          node("summary").append(blocker);
        }
      }
    } else
      node("summary").textContent =
        "写下想法，再核对水体、植物与石头的处理方式。";
    button("preview").disabled = unavailable || busy || !ready;
    renderPersistence();
    diagnostic();
  }
  function invalidate(reason: string) {
    lastError = null;
    revision++;
    request?.abort();
    request = null;
    busy = false;
    binding.cancel();
    candidate = undefined;
    ticket = null;
    message("draft", reason);
    render();
  }
  async function post(
    stage: "requirements" | "choose",
    payload: unknown,
    signal: AbortSignal,
  ) {
    const response = await fetch(
      stage === "requirements"
        ? "/api/planner/review/requirements-v2"
        : "/api/planner/assets/choose",
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      },
    );
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 262144)
      throw Error("本机响应过大");
    const value = JSON.parse(text);
    if (!response.ok)
      throw Error(
        typeof value.error === "string"
          ? value.error
          : `本机服务返回${response.status}`,
      );
    return value;
  }
  prompt.addEventListener("input", () => {
    draft = null;
    invalidate("描述已修改，请重新理解或选择手动设置；上一版场景保留。");
    node("source").textContent = "新描述尚未解释。";
  });
  button("interpret").onclick = async () => {
    draft = null;
    invalidate("正在理解描述…");
    const own = revision,
      c = new AbortController();
    request = c;
    busy = true;
    render();
    try {
      const first = parseRequirementEvidenceV2(
        await post("requirements", { prompt: prompt.value }, c.signal),
      );
      if (own !== revision || disposed) return;
      draft = createReviewDraft(prompt.value, first.request, first);
      mode = "model";
      node("source").textContent =
        "已读取描述。请核对摘要，并选择石头的处理方式。";
      message("draft", "摘要待核对；尚未生成或使用新场景。");
    } catch (e) {
      if (own !== revision || disposed) return;
      const reason = errorText(e);
      message(
        "error",
        /水体要求不一致|水位要求不一致|请澄清|需要澄清/.test(reason)
          ? `${reason} 本次结果未使用，输入和上一版场景保留；请修改描述或主动选择手动设置。`
          : "模型未完成，本次没有新理解结果。输入和上一版场景保留，可主动选择手动设置。",
      );
      diagnostic(e);
    } finally {
      if (own === revision && !disposed) {
        busy = false;
        request = null;
        render();
      }
    }
  };
  button("manual").onclick = () => {
    invalidate("手动设置起点，请逐项核对后预览。");
    try {
      const value = prompt.value.trim() || "手动河岸场景",
        water = waterRequirement(value);
      draft = createReviewDraft(
        value,
        {
          ...defaultReviewRequestV2,
          water,
        },
        null,
      );
      mode = "manual";
      node("source").textContent =
        "手动设置：下列数量是可调整的起点，未调用模型理解描述。石头仍须明确选择。";
      render();
    } catch (e) {
      message("error", errorText(e));
      diagnostic(e);
    }
  };
  function edit(patch: Partial<ReviewEdits>) {
    if (!draft) return;
    invalidate("调整已更新，请重新预览；尚未使用。");
    try {
      draft = editReviewDraft(draft, patch);
      render();
    } catch (e) {
      message("error", errorText(e));
      render();
      diagnostic(e);
    }
  }
  node<HTMLSelectElement>("water").onchange = (e) =>
    edit({
      water: (e.target as HTMLSelectElement).value as ReviewEdits["water"],
    });
  node<HTMLSelectElement>("plant").onchange = (e) =>
    edit({
      plantKind: (e.target as HTMLSelectElement)
        .value as ReviewEdits["plantKind"],
    });
  node<HTMLSelectElement>("density").onchange = (e) =>
    edit({
      density: (e.target as HTMLSelectElement).value as ReviewEdits["density"],
    });
  node<HTMLInputElement>("rock-omit").onchange = () => edit({ rock: "omit" });
  node<HTMLInputElement>("rock-placeholder").onchange = () =>
    edit({ rock: "placeholder" });
  consent.onchange = () => {
    const allowed = consent.checked;
    invalidate("素材允许状态已更新，请重新预览。");
    try {
      if (draft)
        draft = confirmReviewProcedural(
          draft,
          allowed ? proceduralIds(candidates().choices, context) : [],
        );
      render();
    } catch (e) {
      message("error", errorText(e));
      diagnostic(e);
    }
  };
  button("preview").onclick = async () => {
    if (!draft) return;
    invalidate("正在准备预览…");
    const own = revision,
      c = new AbortController();
    request = c;
    busy = true;
    render();
    try {
      const { effective, choices } = candidates();
      const proof =
        mode === "model"
          ? {
              kind: "model" as const,
              evidence: parseChoiceEvidence(
                await post(
                  "choose",
                  {
                    request: effective,
                    catalogVersion: context.catalogVersion,
                  },
                  c.signal,
                ),
                context,
              ),
            }
          : {
              kind: "manual" as const,
              request: effective,
              catalogVersion: context.catalogVersion,
              choices,
            };
      if (own !== revision || disposed) return;
      draft = setReviewSelection(draft, proof, context);
      const preview = await binding.preview(compileReview(draft, context));
      if (own !== revision || disposed) return;
      ticket = preview.ticket;
      candidate = preview.result;
      message(
        "preview",
        "预览，尚未使用。查看水面、岸线和植物；满意后再点击使用。",
      );
    } catch (e) {
      if (own !== revision || disposed) return;
      message(
        "error",
        `预览未完成，上一版场景保留。${/水|石头|确认|素材|目录|20/.test(errorText(e)) ? errorText(e) : "请重试或查看高级记录。"}`,
      );
      diagnostic(e);
    } finally {
      if (own === revision && !disposed) {
        busy = false;
        request = null;
        render();
      }
    }
  };
  button("cancel").onclick = () => {
    if (busy || ticket !== null)
      invalidate("已取消本次预览，恢复已使用场景；本次预览未写入历史。");
  };
  button("use").onclick = async () => {
    if (ticket === null || busy) return;
    const own = revision,
      selected = ticket;
    busy = true;
    message("committing", "正在确认当前预览…");
    render();
    try {
      const saved = await binding.use(selected);
      if (disposed) return;
      // Persistence belongs to the committed record, not the current editable draft.
      if (saved.saveError)
        unsaved.set(saved.record.id, {
          record: saved.record,
          error: saved.saveError,
        });
      else unsaved.delete(saved.record.id);
      renderPersistence();
      if (own === revision && latest?.id === saved.record.id) {
        message(
          "used",
          saved.saveError
            ? `已使用此场景，但记录未保存。${saved.saveError}`
            : "已使用此场景，审阅记录已保存在本机。",
        );
        node("storage").textContent =
          saved.saveError ??
          saved.notice ??
          "记录保存在当前浏览器；可以下载备份。";
      }
      await refreshHistory(false);
    } catch (e) {
      if (own === revision && !disposed) {
        ticket = null;
        message("error", errorText(e));
        diagnostic(e);
      }
    } finally {
      if (own === revision && !disposed) {
        busy = false;
        render();
      }
    }
  };
  async function refreshHistory(showError = true) {
    const own = ++historyRevision;
    const loaded = await loadReviewHistory(localStorage, context);
    if (disposed || own !== historyRevision) return;
    history = loaded.records;
    const choices = history.map((r) => {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `${new Date(r.confirmedAt).toLocaleString()} · ${r.effectiveRequest.plantCount}丛植物`;
      return o;
    });
    node("history").replaceChildren(...choices);
    if (showError && loaded.error) node("storage").textContent = loaded.error;
    render();
  }
  function reopen(record: SceneReviewRecord) {
    invalidate("已打开历史需求，尚未重新推理或使用；请确认素材后预览。");
    prompt.value = record.draft.prompt;
    draft = { ...record.draft, selection: null, confirmedProceduralIds: [] };
    mode = "archive";
    node("source").textContent =
      "历史需求，未重新推理；本次从当前目录手动选材。";
    render();
  }
  button("reopen").onclick = () => {
    const record = history.find(
      (r) => r.id === node<HTMLSelectElement>("history").value,
    );
    if (record) reopen(record);
  };
  button("save").onclick = () => {
    if (latest) downloadRecord(latest);
  };
  button("open").onclick = () => node<HTMLInputElement>("file").click();
  node<HTMLInputElement>("file").onchange = async () => {
    const file = node<HTMLInputElement>("file").files?.[0];
    if (!file) return;
    invalidate("正在核对审阅记录…");
    const own = revision;
    try {
      if (file.size > 1048576) throw Error("审阅记录超过1MiB");
      const record = await importReviewRecord(await file.text(), context);
      if (own === revision && !disposed) reopen(record);
    } catch (e) {
      if (own === revision && !disposed)
        message(
          "error",
          `${errorText(e)}；旧规划或选材文件请从高级兼容入口打开。`,
        );
    } finally {
      node<HTMLInputElement>("file").value = "";
    }
  };
  const onUsed = (event: Event) => {
    latest = (event as CustomEvent<SceneReviewRecord>).detail;
    unsaved.set(latest.id, { record: latest, error: null });
    // CPU/GPU publication has happened synchronously; only persistence is pending.
    ticket = null;
    candidate = undefined;
    busy = false;
    message(
      "saving",
      "已使用此场景，正在保存审阅记录；场景已确定，不能再取消预览。",
    );
    render();
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === "wetland.sceneReviews.v1" ||
      event.key === "wetland.sceneReviews.v2"
    )
      void refreshHistory();
  };
  document.addEventListener("review-used", onUsed);
  window.addEventListener("storage", onStorage);
  void refreshHistory();
  void fetch(
    `/api/planner/status?backend=llama.cpp&model=${LLAMA_SMALL_MODEL}`,
    { redirect: "error", signal: AbortSignal.timeout(6000) },
  )
    .then((r) => r.json())
    .then((value) => {
      if (!disposed)
        node("model").textContent = value.available
          ? "本机模型可用 · 点击理解才发送描述"
          : "本机模型未运行 · 可主动选择手动设置";
    })
    .catch(() => {
      if (!disposed)
        node("model").textContent =
          "本机模型状态未确认 · 输入与当前场景不受影响";
    });
  if (unavailable) {
    message(
      "error",
      "当前目录包含外加地表，请使用高级与旧版本兼容入口；不会替换为默认河岸。",
    );
    node("source").textContent = "此目录暂不支持新的河岸审阅流程。";
  }
  render();
  return {
    invalidate,
    dispose() {
      disposed = true;
      invalidate("页面已关闭");
      document.removeEventListener("review-used", onUsed);
      window.removeEventListener("storage", onStorage);
      debug.remove();
    },
  };
}
