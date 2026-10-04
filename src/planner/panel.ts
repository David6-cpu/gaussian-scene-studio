import type { F0Recipe } from "../gaussian/types";
import { mountCatalogPanel } from "../assets/catalog/panel";
import { parseRecipe, isRiverside, sceneAssetLabel } from "../recipe";
import { terrainReview } from "./terrain-intent";
import {
  parseProposal,
  preflightRecipe,
  proposalFromRecipe,
  toRecipe,
} from "./contract";
import {
  demoPlan,
  errorText,
  parsePrompt,
  parseBackend,
  parseModel,
  MODEL,
  LLAMA_MODEL,
  LLAMA_SMALL_MODEL,
  type PlanDraft,
} from "./service";
import {
  confirmPlan,
  exportPlan,
  importPlan,
  loadHistory,
  parseDraft,
  saveHistory,
  type PlanRecord,
} from "./history";

type Binding = {
  getRecipe: () => F0Recipe;
  getSurface: () => F0Recipe["algorithmVersion"];
  beforeApply?: () => void;
  applyRecipe: (recipe: F0Recipe) => number | undefined;
};
type Staged = {
  draft: PlanDraft;
  recipe: F0Recipe;
  parentId: string | null;
  origin: "local" | "imported";
};
function sourceLabel(
  draft: PlanDraft,
  imported = false,
  manual = false,
): string {
  const source = {
    ollama: `本地模型 Ollama · ${draft.repaired ? "修复后通过" : "首次通过"} · 权重未核验`,
    "llama.cpp": `本地模型 llama.cpp · ${draft.repaired ? "修复后通过" : "首次通过"} · 权重未核验`,
    default: `默认回退 · 未解释输入 · 所选后端 ${draft.backend}`,
    demo: "离线示例 · 未调用模型",
  }[draft.source];
  return `${imported ? "历史导入（来源声明未核实） · " : ""}${manual ? "人工修改 · " : ""}${source}${draft.model ? ` · ${draft.model}` : ""}`;
}
export function mountPlanner(host: HTMLElement, binding: Binding) {
  host.innerHTML = `<details class="planner-details" open><summary>场景规划与版本</summary>
    <p class="footnote">描述想法后先审阅配方，再确认生成。离线示例使用固定参数。</p>
    <label class="planner-label">本地推理后端<select id="plan-backend"><option value="ollama">Ollama（默认）</option><option value="llama.cpp">llama.cpp（可选）</option></select></label>
    <label class="planner-label">模型<select id="plan-model"><option value="${MODEL}">Qwen2.5 7B · Q4_K_M</option></select></label>
    <p class="footnote">3B适用于本地研究与评估（Qwen Research许可）；7B配置保留。模型名由本地服务报告，页面不能核验权重文件。切换后端或模型会取消待审规划。</p>
    <label class="planner-label">中文场景描述<textarea id="plan-prompt" maxlength="1000" rows="3" placeholder="例如：6米见方的低起伏湿地，四块石头、六株植物"></textarea></label>
    <div class="planner-actions"><button id="plan-run">本地模型规划</button><button id="plan-demo">离线示例</button><button id="plan-cancel" disabled>取消规划</button></div>
    <button id="plan-check">检查本地模型</button><p id="plan-runtime" class="footnote">不会自动安装或下载模型。</p>
    <p id="plan-message" role="status" aria-live="polite">等待输入。</p><b id="plan-source">没有待审规划</b>
    <div id="plan-review" hidden><label class="planner-label">待审参数（可编辑 JSON）<textarea id="plan-proposal" rows="10" maxlength="8192" spellcheck="false"></textarea></label>
    <p class="footnote">rock / reed 为测试石头与植株数量；下方手工控件属于另一条编辑路径。</p>
    <button id="plan-preview">重新校验与预检</button><pre id="plan-summary"></pre>
    </div><button id="plan-confirm" class="primary" disabled>确认此版本并生成</button>
    <p id="plan-current">当前画面：无已关联规划（手工场景或场景包）。</p>
    <p id="plan-confirmed" class="footnote">尚无已确认记录。</p><div class="planner-actions"><button id="plan-save" disabled>下载最新确认记录</button><button id="plan-open">打开规划记录</button></div>
    <input id="plan-file" type="file" accept=".json,.wetland-plan.json" hidden>
    <label class="planner-label">本机已确认版本<select id="plan-history" aria-label="本机已确认版本"></select></label><button id="plan-reopen" disabled>重开所选版本</button>
    <p id="plan-storage" class="footnote"></p><p class="footnote">规划 JSON v3 保存描述、后端、目标模型、确认配方和来源，可导入旧版 v1/v2；场景 ZIP 保存高斯结果，不包含规划证据。本机历史最多20条且不超过1MiB；新记录优先，超限会移出较旧条目。请下载需要长期保留的记录。</p>
    <pre id="plan-evidence" hidden></pre><div id="catalog-host"></div></details>`;
  const node = <T extends HTMLElement = HTMLElement>(id: string) =>
    host.querySelector<T>(`#${id}`)!;
  const button = (id: string) => node<HTMLButtonElement>(id);
  const catalog = mountCatalogPanel(node("catalog-host"), binding.getSurface);
  const editor = node<HTMLTextAreaElement>("plan-proposal"),
    prompt = node<HTMLTextAreaElement>("plan-prompt"),
    backendSelect = node<HTMLSelectElement>("plan-backend"),
    modelSelect = node<HTMLSelectElement>("plan-model");
  const storage = {
    getItem: (k: string) => localStorage.getItem(k),
    setItem: (k: string, v: string) => localStorage.setItem(k, v),
  };
  let epoch = 0,
    runtimeEpoch = 0,
    controller: AbortController | null = null,
    staged: Staged | null = null,
    checked: F0Recipe | null = null,
    current: PlanRecord | null = null,
    latestConfirmed: PlanRecord | null = null,
    awaiting: { requestId: number; record: PlanRecord } | null = null,
    history: PlanRecord[] = [];
  const message = (s: string) => {
    node("plan-message").textContent = s;
  };
  function publish() {
    catalog.update();
    node("plan-evidence").textContent = JSON.stringify({
      current,
      latestConfirmed,
      pending: staged,
      checked,
    });
    node("plan-current").textContent = current
      ? `当前画面：${sourceLabel(current.draft, current.origin === "imported", current.kind === "manual")} · ${current.id.slice(0, 8)}`
      : "当前画面：无已关联规划（手工场景或场景包）。";
    node("plan-confirmed").textContent = latestConfirmed
      ? `可下载的最新确认版本：${latestConfirmed.id.slice(0, 8)}。确认记录不表示场景已成功显示。`
      : "尚无已确认记录。";
    button("plan-save").disabled = !latestConfirmed;
  }
  function invalidate(reason = "已取消待审规划。", clearScene = false) {
    epoch++;
    controller?.abort();
    controller = null;
    staged = null;
    checked = null;
    awaiting = null;
    node("plan-review").hidden = true;
    node("plan-source").textContent = "没有待审规划";
    button("plan-confirm").disabled = true;
    button("plan-cancel").disabled = true;
    if (clearScene) current = null;
    message(reason);
    publish();
  }
  function renderHistory() {
    const select = node<HTMLSelectElement>("plan-history");
    select.replaceChildren();
    for (const r of history) {
      const option = document.createElement("option");
      option.value = r.id;
      option.textContent = `${r.createdAt.slice(5, 16).replace("T", " ")} · ${r.id.slice(0, 8)} · ${r.kind === "manual" ? "人工修改" : r.draft.source}`;
      select.append(option);
    }
    button("plan-reopen").disabled = history.length === 0;
  }
  const historyReady = loadHistory(storage).then((loaded) => {
    history = loaded.records;
    node("plan-storage").textContent = loaded.error ?? "历史保存在本浏览器。";
    renderHistory();
    return loaded.error;
  });
  async function persist(record: PlanRecord) {
    const loadError = await historyReady;
    if (loadError) {
      node("plan-storage").textContent =
        `${loadError}。为保留原始历史，本次未写入浏览器；请下载当前确认记录。`;
      return false;
    }
    const saved = saveHistory(storage, [
      record,
      ...history.filter((r) => r.id !== record.id),
    ]);
    history = saved.records;
    renderHistory();
    node("plan-storage").textContent =
      saved.error ??
      [`已保存 ${history.length} 条确认记录。`, saved.notice]
        .filter(Boolean)
        .join(" ");
    return saved.error === null;
  }
  function preview() {
    checked = null;
    button("plan-confirm").disabled = true;
    if (!staged) return;
    try {
      if (editor.value.length > 8192) throw Error("配方编辑内容过大");
      const proposal = parseProposal(JSON.parse(editor.value));
      const recipe = parseRecipe({ ...staged.recipe, ...proposal });
      const flight = preflightRecipe(recipe);
      checked = recipe;
      node("plan-summary").textContent =
        `${terrainReview(staged.draft.prompt, proposal)}\n${flight.summary.ruleVersion}\n请求 石头${recipe.requested.rock} / 植株${recipe.requested.reed}\n可放置 石头${flight.summary.accepted.rock} / 植株${flight.summary.accepted.reed}\n缺口 石头${flight.summary.shortfall.rock} / 植株${flight.summary.shortfall.reed}\n活跃高斯 ${flight.summary.activeSplats}\n拒绝统计 ${JSON.stringify(flight.summary.rejections)}\n${flight.warnings.join("\n")}`;
      button("plan-confirm").disabled = false;
    } catch (error) {
      node("plan-summary").textContent = `校验失败：${errorText(error)}`;
    }
    publish();
  }
  function stage(draft: PlanDraft, record?: PlanRecord) {
    const base = toRecipe(draft.proposal);
    const scanned = !record && isRiverside(binding.getSurface());
    staged = {
      draft,
      recipe:
        record?.recipe ??
        (scanned
          ? parseRecipe({
              ...base,
              algorithmVersion: binding.getSurface(),
              width: 4,
              depth: 4,
              spacing: 0.1,
              amplitude: 0,
              octaves: 1,
            })
          : base),
      parentId: record?.id ?? null,
      origin: record ? "imported" : "local",
    };
    prompt.value = draft.prompt;
    editor.value = JSON.stringify(proposalFromRecipe(staged.recipe), null, 2);
    node("plan-source").textContent = sourceLabel(
      draft,
      !!record,
      record?.kind === "manual",
    );
    node("plan-review").hidden = false;
    message(
      (draft.reason ??
        `模型返回 ${draft.attempts.length} 次，耗时 ${(draft.elapsedMs / 1000).toFixed(1)} 秒。请审阅参数；合法并不代表符合意图。`) +
        (scanned
          ? " 当前选用Riverside试用：尺寸和地形参数已按固定4×4素材范围适配，请审阅后确认；原始规划提议仍保留在记录中。"
          : ""),
    );
    preview();
  }
  async function applyRecord(record: PlanRecord, expectedEpoch: number) {
    if (expectedEpoch !== epoch) return;
    latestConfirmed = record;
    publish();
    const persisted = await persist(record);
    if (expectedEpoch !== epoch) return;
    const confirmation = persisted
      ? "已确认并保存到浏览器历史"
      : "已确认；浏览器历史保存失败，请下载最新确认记录";
    const requestId = binding.applyRecipe(record.recipe);
    if (requestId === undefined) {
      awaiting = null;
      message(`${confirmation}。场景未能启动，详见构建状态。`);
      return;
    }
    awaiting = { requestId, record };
    message(`${confirmation}；正在构建，画面来源将在成功显示后更新。`);
  }
  button("plan-demo").onclick = () => {
    invalidate();
    stage(demoPlan());
  };
  button("plan-run").onclick = async () => {
    invalidate();
    const token = epoch;
    controller = new AbortController();
    const activeController = controller;
    button("plan-cancel").disabled = false;
    message("规划中… 每次最多60秒，最多一次格式或约束修复。");
    try {
      const description = parsePrompt(prompt.value);
      const backend = parseBackend(backendSelect.value);
      const model = parseModel(backend, modelSelect.value);
      const response = await fetch("/api/planner/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: description, backend, model }),
        signal: activeController.signal,
      });
      const value = await response.json();
      if (!response.ok)
        throw Error(
          typeof value.error === "string" ? value.error : "规划接口错误",
        );
      const draft = parseDraft(value);
      if (token === epoch) stage(draft);
    } catch (error) {
      if (token === epoch) message(`规划未完成：${errorText(error)}`);
    } finally {
      if (token === epoch) {
        controller = null;
        button("plan-cancel").disabled = true;
      }
    }
  };
  button("plan-cancel").onclick = () => invalidate();
  function modelChanged() {
    invalidate("后端或模型已切换，请重新规划。");
    runtimeEpoch++;
    button("plan-check").disabled = false;
    node("plan-runtime").textContent =
      "尚未检查所选后端；不会自动启动或下载模型。";
  }
  backendSelect.addEventListener("change", () => {
    const models = backendSelect.value === "ollama" ? [MODEL] : [LLAMA_SMALL_MODEL, LLAMA_MODEL];
    modelSelect.replaceChildren(...models.map(model => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = `Qwen2.5 ${model === LLAMA_SMALL_MODEL ? "3B" : "7B"} · Q4_K_M`;
      return option;
    }));
    modelChanged();
  });
  modelSelect.addEventListener("change", modelChanged);
  // The project launcher opts in via URL; existing manual entry and saved history stay unchanged.
  if (new URLSearchParams(location.search).get("planner") === "3b") {
    backendSelect.value = "llama.cpp";
    backendSelect.dispatchEvent(new Event("change"));
  }
  prompt.addEventListener("input", () =>
    invalidate("描述已修改，请重新规划。"),
  );
  editor.addEventListener("input", () => {
    epoch++;
    controller?.abort();
    controller = null;
    checked = null;
    button("plan-confirm").disabled = true;
    message("待审参数已修改，请重新校验。 ");
    publish();
  });
  button("plan-preview").onclick = preview;
  button("plan-confirm").onclick = async () => {
    if (!staged || !checked) return;
    binding.beforeApply?.();
    const selected = staged,
      recipe = checked,
      token = ++epoch;
    button("plan-confirm").disabled = true;
    try {
      const record = await confirmPlan(
        selected.draft,
        recipe,
        selected.parentId,
      );
      record.origin = selected.origin;
      await applyRecord(record, token);
    } catch (error) {
      if (token === epoch) message(`确认失败：${errorText(error)}`);
    }
  };
  button("plan-save").onclick = () => {
    if (!latestConfirmed) return;
    const url = URL.createObjectURL(
      new Blob([exportPlan(latestConfirmed)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${latestConfirmed.id}.wetland-plan.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const file = node<HTMLInputElement>("plan-file");
  button("plan-open").onclick = () => file.click();
  file.onchange = async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    invalidate();
    const token = epoch;
    try {
      if (selected.size > 1048576) throw Error("规划文件超过1MiB");
      const record = await importPlan(await selected.text());
      if (token === epoch) stage(record.draft, record);
    } catch (error) {
      if (token === epoch) message(`导入失败：${errorText(error)}`);
    } finally {
      file.value = "";
    }
  };
  button("plan-reopen").onclick = () => {
    const record = history.find(
      (r) => r.id === node<HTMLSelectElement>("plan-history").value,
    );
    if (record) {
      invalidate();
      stage(record.draft, record);
    }
  };
  button("plan-check").onclick = async () => {
    const token = ++runtimeEpoch;
    const backend = parseBackend(backendSelect.value);
    const model = parseModel(backend, modelSelect.value);
    button("plan-check").disabled = true;
    try {
      const response = await fetch(`/api/planner/status?backend=${backend}&model=${model}`, {
        signal: AbortSignal.timeout(6000),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      if (token === runtimeEpoch)
        node("plan-runtime").textContent =
          `${backend} / ${data.model}：${data.reason}`;
    } catch (error) {
      if (token === runtimeEpoch)
        node("plan-runtime").textContent = `检查失败：${errorText(error)}`;
    } finally {
      if (token === runtimeEpoch) button("plan-check").disabled = false;
    }
  };
  publish();
  return {
    invalidate,
    recipeEdited() {
      invalidate("手工参数已修改；待审规划失效。点击生成将应用手工参数。");
    },
    async generateManual() {
      binding.beforeApply?.();
      const parent = current;
      invalidate("正在应用手工参数。");
      const token = epoch;
      const recipe = binding.getRecipe();
      if (parent) {
        const record = await confirmPlan(parent.draft, recipe, parent.id);
        record.origin = parent.origin;
        await applyRecord(record, token);
      } else binding.applyRecipe(recipe);
    },
    sceneFailed(requestId: number, error: string, displayUnknown = false) {
      if (displayUnknown) current = null;
      if (awaiting?.requestId === requestId) {
        awaiting = null;
        message(
          `场景生成未成功：${error}。最新确认记录仍可下载；记录不代表显示成功。`,
        );
      }
      publish();
    },
    sceneReady(requestId: number, recipe: F0Recipe) {
      current =
        awaiting?.requestId === requestId &&
        JSON.stringify(awaiting.record.recipe) === JSON.stringify(recipe)
          ? awaiting.record
          : null;
      awaiting = null;
      if (current) {
        message("场景已显示。可下载确认记录；浏览器保存情况见下方提示。");
        const note = document.querySelector(".mode-note");
        if (note)
          note.textContent = `${sceneAssetLabel(recipe.algorithmVersion)} · 配方来源见当前规划记录`;
      }
      publish();
    },
  };
}
