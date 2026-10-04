import type { F0Recipe } from "../gaussian/types";
import { assetCatalog } from "../assets/catalog/entries";
import { preflightRecipe } from "../planner/contract";
import { errorText } from "../planner/service";
import {
  defaultAssetRequest,
  parseAssetRequest,
  candidateSnapshot,
  assertAssetPrompt,
  proceduralIds,
  compileSelection,
} from "./contract";
import {
  equal,
  parseRequirementEvidence,
  parseChoiceEvidence,
  type RequirementEvidence,
  type ChoiceEvidence,
} from "./service";
import {
  confirmAssetPlan,
  importAssetPlan,
  exportAssetPlan,
  loadAssetHistory,
  saveAssetHistory,
  type AssetPlanRecord,
} from "./history";

export function mountAssetSelection(
  host: HTMLElement,
  binding: {
    beforeApply?: () => void;
    applyRecipe: (r: F0Recipe) => number | undefined;
  },
) {
  host.innerHTML = `<details id="asset-details" class="planner-details"><summary>湿地 · 两阶段选材（3B试用）</summary>
    <p class="footnote">先审阅需求，再让本机3B从真实目录返回资产ID。当前仅4项试用素材，每类通常只有1个候选，尚不能比较多种同类素材。固定4×4展示范围，非实测米制。</p>
    <label class="planner-label">场景想法<textarea id="asset-prompt" maxlength="1000" rows="3" placeholder="湿地，2组碎石和4丛低草，种子42"></textarea></label>
    <div class="planner-actions"><button id="asset-interpret">1 · 提取需求</button><button id="asset-cancel" disabled>取消模型请求</button></div>
    <p class="footnote">使用已配置的本机Qwen2.5 3B，适用于研究与评估。每阶段仅尝试一次，不自动下载或替换失败结果。页面不能核验权重。</p>
    <label class="planner-label">可编辑需求<textarea id="asset-request" rows="12" spellcheck="false"></textarea></label>
    <p class="footnote">初始内容是人工示例，尚未调用模型。数量按碎石组／植物丛计；captured=实拍，procedural=程序，either=均可；grass=低草，reed=芦苇，none=无植被；waterLevel=null关闭水面。请核对数量、来源及澄清说明。</p>
    <div class="planner-actions"><button id="asset-query">检查候选</button><button id="asset-choose" disabled>2 · 从候选选材</button></div>
    <p id="asset-candidates" class="footnote">等待检查候选。</p><p id="asset-message" role="status" aria-live="polite">人工示例，等待审阅。</p>
    <pre id="asset-selection">没有待确认选材</pre>
    <label class="asset-consent"><input id="asset-program-confirm" type="checkbox" disabled> 我接受以下程序素材（非实拍）</label><p id="asset-program-list" class="footnote">尚无选材。</p>
    <button id="asset-confirm" disabled>确认选材并生成场景</button>
    <p id="asset-current">无已关联选材</p>
    <div class="planner-actions"><button id="asset-save" disabled>保存选材记录</button><button id="asset-open">打开选材记录</button></div><input id="asset-file" type="file" accept=".wetland-assets.json,.json" hidden>
    <p class="footnote">选材JSON保存需求、候选、模型原文与版本；场景ZIP只保存场景。旧规划JSON仍从下方原入口打开。导入记录需重新确认，来源声明不代表重新推理或身份认证。</p>
    <label class="planner-label">本机选材版本<select id="asset-history"></select></label><button id="asset-reopen" disabled>重开选材版本</button><p id="asset-storage" class="footnote">正在读取本机选材历史…</p>
    <pre id="asset-evidence" hidden></pre></details>`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    host.querySelector<T>(`#asset-${id}`)!;
  const editor = $<HTMLTextAreaElement>("request"),
    prompt = $<HTMLTextAreaElement>("prompt"),
    consent = $<HTMLInputElement>("program-confirm");
  const button = (id: string) => $<HTMLButtonElement>(id);
  let first: RequirementEvidence | null = null,
    selection: ChoiceEvidence | null = null,
    current: AssetPlanRecord | null = null,
    latest: AssetPlanRecord | null = null;
  let parentId: string | null = null,
    origin: "local" | "imported" = "local",
    epoch = 0,
    controller: AbortController | null = null,
    busy = false,
    candidatesReady = false;
  let awaiting: { id: number; record: AssetPlanRecord } | null = null,
    history: AssetPlanRecord[] = [],
    historyError: string | null = null;
  editor.value = JSON.stringify(defaultAssetRequest, null, 2);
  function publish() {
    button("interpret").disabled = busy;
    button("choose").disabled = busy || !candidatesReady;
    button("query").disabled = busy;
    button("cancel").disabled = !controller;
    const ids = selection ? proceduralIds(selection.choices) : [];
    consent.disabled = !selection || ids.length === 0 || busy;
    button("confirm").disabled =
      busy || !selection || (ids.length > 0 && !consent.checked);
    button("save").disabled = !latest;
    $("current").textContent = current
      ? `场景已显示 · ${current.origin === "imported" ? "历史导入 · " : ""}${current.requirementsSource === "edited" ? "人工修改需求 · " : current.requirementsSource === "manual" ? "人工需求 · " : ""}${current.selection.model} · 种子${current.recipe.seed}`
      : "无已关联选材";
    $("evidence").textContent = JSON.stringify({
      current,
      latestConfirmed: latest,
      requirements: first,
      selection,
    });
  }
  function invalidate(reason = "待审选材已失效。", clearScene = false) {
    epoch++;
    controller?.abort();
    controller = null;
    busy = false;
    awaiting = null;
    selection = null;
    candidatesReady = false;
    consent.checked = false;
    // Invalidating a choice must not relabel retained first-stage evidence.
    // A new description or successful fresh extraction starts a new lineage.
    if (clearScene) current = null;
    $("selection").textContent = "没有待确认选材";
    $("program-list").textContent = "尚无选材。";
    $("candidates").textContent = "需求需重新检查候选。";
    $("message").textContent = reason;
    publish();
  }
  function requestValue() {
    if (new TextEncoder().encode(editor.value).byteLength > 8192)
      throw Error("需求超过8KiB");
    return parseAssetRequest(JSON.parse(editor.value));
  }
  function query() {
    candidatesReady = false;
    const req = requestValue(),
      rows = candidateSnapshot(req);
    $("candidates").textContent = rows
      .map(
        (row) =>
          `${row.key} × ${row.count}：${row.assetIds.length}个候选 — ${row.assetIds.map((id) => `${assetCatalog.find((a) => a.id === id)!.title} (${id})`).join("、")}`,
      )
      .join("\n");
    candidatesReady = true;
    publish();
    return req;
  }
  function review(s: ChoiceEvidence) {
    const ids = proceduralIds(s.choices),
      recipe = compileSelection(s.request, { choices: s.choices }, ids);
    const p = preflightRecipe(recipe);
    // This is read-only preflight. Actual apply compiles again with explicit human consent.
    $("selection").textContent =
      `${s.choices.map((c) => `${c.key}: ${c.assetId}`).join("\n")}\n实际可放置：${p.summary.accepted.rock}组碎石、${p.summary.accepted.reed}丛植物；${p.summary.activeSplats.toLocaleString()}活跃高斯\n${p.warnings.join("\n")}`;
    $("program-list").textContent = ids.length
      ? ids.join("、")
      : "所选素材无需程序素材确认。";
    selection = s;
    consent.checked = false;
    publish();
  }
  async function post(stage: string, payload: unknown, signal: AbortSignal) {
    const response = await fetch(`/api/planner/assets/${stage}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
      redirect: "error",
    });
    const value = await response.json();
    if (!response.ok)
      throw Error(
        typeof value.error === "string"
          ? value.error
          : `本机服务返回${response.status}`,
      );
    return value;
  }
  async function run(stage: "requirements" | "choose") {
    const savedFirst = first;
    invalidate("正在请求本机3B…");
    first = savedFirst;
    const token = epoch;
    try {
      const payload =
        stage === "requirements"
          ? { prompt: prompt.value }
          : { request: query() };
      if (stage === "requirements") assertAssetPrompt(prompt.value);
      const c = new AbortController();
      controller = c;
      busy = true;
      publish();
      const data = await post(stage, payload, c.signal);
      if (token !== epoch) return;
      if (stage === "requirements") {
        const parsed = parseRequirementEvidence(data);
        if (parsed.prompt !== prompt.value.trim())
          throw Error("返回的输入与当前描述不一致");
        first = parsed;
        parentId = null;
        origin = "local";
        editor.value = JSON.stringify(parsed.request, null, 2);
        query();
        $("message").textContent = "需求已提取，请核对并编辑后再选材。";
      } else {
        const parsed = parseChoiceEvidence(data);
        if (!equal(parsed.request, requestValue()))
          throw Error("返回的需求与当前编辑内容不一致");
        review(parsed);
        $("message").textContent =
          "选材已通过独立校验；请审阅来源与预检后确认。";
      }
    } catch (e) {
      if (token === epoch)
        $("message").textContent =
          `${stage === "requirements" ? "需求提取" : "选材"}失败：${errorText(e)}`;
    } finally {
      if (token === epoch) {
        controller = null;
        busy = false;
        publish();
      }
    }
  }
  function drawHistory() {
    const select = $<HTMLSelectElement>("history");
    select.replaceChildren();
    for (const r of history) {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `${r.confirmedAt} · 种子${r.recipe.seed} · ${r.selection.request.plantKind}`;
      select.append(o);
    }
    button("reopen").disabled = history.length === 0;
  }
  const loaded = loadAssetHistory(localStorage).then((result) => {
    history = result.records;
    historyError = result.error;
    $("storage").textContent = result.error ?? "独立选材历史，最多20条／1MiB。";
    drawHistory();
  });
  async function confirm() {
    if (button("confirm").disabled || !selection) return;
    binding.beforeApply?.();
    const token = epoch,
      s = selection;
    busy = true;
    publish();
    try {
      if (!equal(requestValue(), s.request))
        throw Error("需求已变化，请重新选材");
      const ids = proceduralIds(s.choices);
      const record = await confirmAssetPlan(
        first,
        s,
        consent.checked ? ids : [],
        parentId,
        origin,
      );
      if (token !== epoch) return;
      await loaded;
      if (token !== epoch) return;
      latest = record;
      if (historyError)
        $("storage").textContent =
          `${historyError}；原数据保留，请下载本次记录。`;
      else {
        const saved = saveAssetHistory(localStorage, [record, ...history]);
        history = saved.records;
        drawHistory();
        $("storage").textContent =
          saved.error ?? saved.notice ?? "选材记录已保存到独立本机历史。";
      }
      const id = binding.applyRecipe(record.recipe);
      awaiting = id === undefined ? null : { id, record };
      $("message").textContent =
        id === undefined
          ? "记录已确认，但场景未启动；可下载记录。"
          : "记录已确认，等待场景实际显示…";
      // A confirmed draft cannot be applied twice without a new explicit review.
      selection = null;
      consent.checked = false;
    } catch (e) {
      if (token === epoch)
        $("message").textContent = `确认失败：${errorText(e)}`;
    } finally {
      if (token === epoch) {
        busy = false;
        publish();
      }
    }
  }
  function reopen(record: AssetPlanRecord) {
    first = record.requirements;
    prompt.value = first?.prompt ?? "";
    editor.value = JSON.stringify(record.selection.request, null, 2);
    parentId = record.id;
    origin = "imported";
    query();
    review(record.selection);
    $("message").textContent =
      "历史导入：已校验内容，请重新确认程序素材；未调用模型。";
  }
  prompt.oninput = () => {
    invalidate("描述已修改，请重新提取需求。");
    first = null;
    parentId = null;
    origin = "local";
    publish();
  };
  editor.oninput = () => invalidate("需求已修改，请检查候选并重新选材。");
  consent.onchange = publish;
  button("interpret").onclick = () => void run("requirements");
  button("choose").onclick = () => void run("choose");
  button("query").onclick = () => {
    invalidate("正在检查候选…");
    try {
      query();
      $("message").textContent = "候选已检查；可执行第2步。";
    } catch (e) {
      $("message").textContent = `候选检查失败：${errorText(e)}`;
      publish();
    }
  };
  button("cancel").onclick = () => invalidate("模型请求已取消。");
  button("confirm").onclick = () => void confirm();
  button("open").onclick = () => $<HTMLInputElement>("file").click();
  $<HTMLInputElement>("file").onchange = async () => {
    const input = $<HTMLInputElement>("file"),
      file = input.files?.[0];
    if (!file) return;
    invalidate("正在校验选材记录…");
    const token = epoch;
    try {
      if (file.size > 1048576) throw Error("选材文件超过1MiB");
      const record = await importAssetPlan(await file.text());
      if (token === epoch) reopen(record);
    } catch (e) {
      if (token === epoch)
        $("message").textContent = `导入失败：${errorText(e)}`;
    } finally {
      input.value = "";
    }
  };
  button("reopen").onclick = () => {
    const r = history.find(
      (r) => r.id === $<HTMLSelectElement>("history").value,
    );
    if (r) {
      invalidate();
      reopen(r);
    }
  };
  button("save").onclick = () => {
    if (!latest) return;
    const url = URL.createObjectURL(
        new Blob([exportAssetPlan(latest)], { type: "application/json" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = `wetland-${latest.id}.wetland-assets.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  publish();
  return {
    invalidate,
    sceneReady(id: number, recipe: F0Recipe) {
      current =
        awaiting?.id === id && equal(awaiting.record.recipe, recipe)
          ? awaiting.record
          : null;
      if (current) $("message").textContent = "已确认选材对应的场景已显示。";
      awaiting = null;
      publish();
    },
    sceneFailed(id: number, error: string, displayUnknown = false) {
      if (displayUnknown) current = null;
      if (awaiting?.id === id) {
        awaiting = null;
        $("message").textContent =
          `场景生成或显示失败：${error}；已确认记录仍可下载。`;
      }
      publish();
    },
  };
}
