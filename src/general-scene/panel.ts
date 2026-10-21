import type {
  GeneralPanelPorts,
  GeneralSceneMetadata,
} from "./integration-types";
import type { ControllerState } from "./controller";
import type { CatalogView } from "./asset-library";
import {
  parsePlanDraft,
  parsePatch,
  type PlanDraft,
  type SceneIntent,
  type SceneSnapshot,
  type ScenePatch,
  type AtomicConstraint,
  type JsonValue,
  type Polygon,
} from "./contracts";
import type { PlanningRequest, PlanningOutcome } from "./planner";
import type { ResolvedPlan, PatchProposal } from "./compile";
import type { CandidateQuery } from "./query";
import type { AssetRef, Issue, Result } from "./core";
import {
  makeManualDraft,
  placementForCandidate,
  manualAtom,
  proceduralChoices,
  confirmProceduralChoices,
  refKey,
} from "./manual-plan";
import { friendlyMessage } from "../user-message";

const category = (name: string) =>
  ({
    rock: "石头",
    grass: "低草",
    reed: "芦苇",
    tree: "树",
    ground: "场地",
    surface: "地形与水面",
  })[name] ?? name;
const origin = (name: string) =>
  ({
    captured: "实拍",
    procedural: "程序生成",
    generated: "生成素材",
    either: "来源不限",
  })[name] ?? name;
const source = (name: string) =>
  ({
    user: "原文要求",
    model: "模型建议",
    default: "程序建议",
    manual: "手工设置",
  })[name] ?? name;
const phaseText: Record<ControllerState["phase"], string> = {
  idle: "就绪",
  requesting: "正在请求规划",
  parsing: "正在解析原句",
  querying: "正在查询素材",
  planning: "正在整理规划",
  "awaiting-review": "等待审阅",
  building: "正在准备场景",
  previewing: "预览已显示，尚未保存",
  saving: "正在保存",
  committed: "已保存",
  failed: "操作未完成",
};
const qualityText = {
  pass: "通过",
  fail: "失败",
  pending: "待验收",
  "not-applicable": "不适用",
};
const take = <T>(result: Result<T>) => {
  if (!result.ok) throw Error(result.issues.map((i) => i.message).join("；"));
  return result.value;
};
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function paragraph(host: HTMLElement, text: string) {
  host.append(node("p", text));
}
function issues(host: HTMLElement, list: readonly Issue[]) {
  if (!list.length) return;
  const ul = node("ul");
  list.forEach((i) => ul.append(node("li", friendlyMessage(i.message))));
  host.append(ul);
}
function projection(
  s: SceneSnapshot,
  access: "editable" | "readonly",
  problems: readonly Issue[] = [],
): GeneralSceneMetadata {
  const {
    sceneId,
    revisionId,
    parentRevisionId,
    capability,
    intent,
    plan,
    state,
    instances,
    assets,
    surfaceStyle,
    quality,
    reviewStatus,
    camera,
    patch,
    geometryDigest,
    validation,
  } = s;
  return {
    sceneId,
    revisionId,
    parentRevisionId,
    capability,
    intent,
    plan,
    state,
    instances,
    assets,
    surfaceStyle,
    quality,
    reviewStatus,
    camera,
    patch,
    geometryDigest,
    validation,
    access,
    issues: problems,
  };
}
function points(value: string): Polygon {
  const result = value
    .trim()
    .split(/\n|;/)
    .filter(Boolean)
    .map((line) =>
      line
        .trim()
        .split(/[ ,，]+/)
        .map(Number),
    );
  if (result.some((p) => p.length !== 2 || p.some((v) => !Number.isFinite(v))))
    throw Error("每行填写两个有限坐标，用空格或逗号分隔。");
  return result as [number, number][];
}
function polygonText(p: Polygon) {
  return p.map((v) => v.map((x) => String(x)).join(", ")).join("\n");
}
function boundsText(p: Polygon) {
  return `X ${Math.min(...p.map((v) => v[0])).toFixed(3)} 至 ${Math.max(...p.map((v) => v[0])).toFixed(3)}；Z ${Math.min(...p.map((v) => v[1])).toFixed(3)} 至 ${Math.max(...p.map((v) => v[1])).toFixed(3)}`;
}
// Water constraints reuse generic keys (width, depth, level); label them in water terms.
const waterLabels: Record<string, string> = {
  width: "河宽",
  depth: "水深",
  level: "水位",
};
function friendlyKey(key: string): string {
  if (key.startsWith("water.")) {
    const rest = key.slice("water.".length);
    return waterLabels[rest] ?? friendlyKey(rest);
  }
  return (
    {
      bankWidth: "岸带宽度",
      controlPoints: "河流控制点",
      polygon: "水面边界",
      reshapePolicy: "塑形策略",
      mode: "水体",
      width: "场地宽度",
      depth: "场地深度",
      source: "地形来源",
      elevation: "基准高程",
      slopeDegrees: "坡度",
      slopeAzimuthDegrees: "坡向",
      noiseAmplitude: "起伏幅度",
      noiseScale: "起伏尺度",
      spacing: "采样间距",
      level: "水位",
      count: "数量",
      seed: "种子",
    }[key.replace(/^terrain\./, "")] ?? key
  );
}
function showAtom(a: AtomicConstraint, scope?: "water") {
  const labels: Record<string, string> = {
    ...(scope === "water" ? waterLabels : {}),
    mode: "水体",
    source: "地形来源",
    origin: "素材来源",
    category: "类别",
    count: "数量",
    within: "位于区域内",
    outside: "避开区域",
    nearWater: "距水边范围",
    minSpacing: "最小间距",
    keepDry: "保持干燥",
    bankWidth: "岸带宽度",
    controlPoints: "河流控制点",
    polygon: "水面边界",
    reshapePolicy: "塑形策略",
    required: "是否必要",
    sourceRestriction: "素材来源",
    maxSlopeDegrees: "允许坡度",
    noiseOctaves: "起伏层数",
  };
  const describe = (value: JsonValue): string => {
    if (value === null) return "未指定";
    if (typeof value === "string")
      return (
        {
          none: "无水",
          unspecified: "未说明",
          river: "河流",
          surface: "静态水面",
          procedural: "程序生成",
          captured: "实拍",
          either: "不限",
          "cut-and-fill": "削土并填土",
          "cut-only": "仅削土",
          preserve: "保持地形",
          patch: "刚性扫描地块",
          sparse: "稀疏",
          dense: "密集",
          some: "一些",
        }[value] ?? category(value)
      );
    if (typeof value !== "object") return String(value);
    if (Array.isArray(value)) return value.map(describe).join("、");
    return Object.entries(value)
      .map(([key, v]) => `${labels[key] ?? friendlyKey(key)} ${describe(v)}`)
      .join("；");
  };
  // Manual values are already announced once at the top of the summary, so
  // tagging every line "手工设置，明确要求" only adds noise. Keep tags that
  // tell the reader something: where a value came from and whether it is a
  // suggestion or a negation.
  const suggestedBySource = a.source === "model" || a.source === "default";
  const explicitBySource = a.source === "user" || a.source === "manual";
  const tags = [
    ...(a.source === "manual" ? [] : [source(a.source)]),
    ...(a.strength === "suggestion" && !suggestedBySource ? ["建议"] : []),
    ...(a.strength === "hard" && !explicitBySource ? ["明确要求"] : []),
    ...(a.negated ? ["否定"] : []),
  ];
  return `${labels[a.key] ?? friendlyKey(a.key)}：${describe(a.value)}${tags.length ? `（${tags.join("，")}）` : ""}`;
}

/** Ordinary UI only. Every allocating action goes through the integration facade. */
const EXAMPLE_PROMPT = "一片平地，三块石头和五丛低草，不放水";
const EXAMPLE_GROUPS: readonly (readonly [string, number])[] = [
  ["rock", 3],
  ["grass", 5],
];
export function mountGeneralScenePanel(
  host: HTMLElement,
  _viewerHost: HTMLElement,
  ports: GeneralPanelPorts,
): { dispose(): Promise<void> } {
  const controller = ports.controller;
  host.classList.add("general-panel");
  host.innerHTML = `<h2>生成自然场景</h2>
    <ol id="general-steps" class="general-steps" aria-label="使用步骤"><li><b>描述</b>写下想要的地形、水体、石头和植物。</li><li><b>审阅</b>点“解析场景要求”（需要本地模型）或“手工设置”，核对设置并确认素材来源。</li><li><b>预览</b>点“生成预览”查看；满意后点“使用并保存草稿”。</li></ol>
    <button id="general-example" class="general-example">试试示例（不需要本地模型）</button>
    <p class="general-note">用一句话描述地形、水体与素材。场景使用展示单位，不能直接换算成米；首版支持一处静态水体和最多 20 个单体。</p>
    <label for="general-prompt">场景描述</label><textarea id="general-prompt" aria-describedby="general-prompt-help" rows="4" maxlength="2000" placeholder="描述你需要的场地、对象数量、位置和水体要求"></textarea>
    <p id="general-prompt-help" class="general-note">解析和手工设置都需要填写场景描述，作为本次场景记录。</p>
    <div class="general-actions"><button id="general-plan">解析场景要求</button><button id="general-manual">手工设置</button><button id="general-cancel">取消</button><button id="general-leave">返回旧场景</button></div>
    <p id="general-status" role="status" aria-live="polite"></p><p id="general-saved" aria-live="polite"></p><p id="general-message" role="alert"></p>
    <section id="general-summary" aria-label="要求、建议与缺失"></section>
    <section id="general-form" aria-label="结构化场景设置" hidden></section>
    <section id="general-global" hidden><p>这是全局重规划：种子、尺寸、地形或水系设置可能改变整个场景。原修订保留为父版本。若只改少量对象或刷地，请使用下方局部编辑。</p><label class="general-check"><input id="general-global-accept" type="checkbox"><span>我确认重新规划整个场景，并将它作为新修订预览。</span></label></section>
    <section id="general-confirmations" aria-label="程序素材确认"></section>
    <div class="general-actions"><button id="general-review" hidden>检查并审阅设置</button><button id="general-preview" hidden>生成预览</button><button id="general-use" disabled>使用并保存草稿</button></div>
    <section id="general-quality" aria-label="质量与草稿状态"></section>
    <section id="general-current" aria-label="当前场景"></section>
    <section id="general-edit" aria-label="局部编辑" hidden></section>
    <section id="general-scope" aria-label="修改影响范围" hidden></section>
    <details><summary>保存、重开与导入导出</summary><p>保存只记录当前草稿，不代表视觉或性能验收通过。重开已保存结果不需要重新调用模型。</p>
      <div class="general-actions"><button id="general-list">查看已保存场景</button><button id="general-undo" disabled>撤销到父修订</button></div><div id="general-scenes"></div>
      <label for="general-import">导入自然场景归档</label><input id="general-import" type="file" accept=".zip,application/zip"><div id="general-original"></div>
      <div id="general-dependencies"></div><div class="general-actions"><button id="general-export-reference" disabled>导出引用包</button><button id="general-export-embedded" disabled>导出含素材包</button></div>
    </details><details><summary>高级证据</summary><pre id="general-evidence"></pre></details>`;
  const get = <T extends HTMLElement = HTMLElement>(id: string) =>
    host.querySelector<T>(`#${id}`)!;
  const button = (id: string) => get<HTMLButtonElement>(id);
  const prompt = get<HTMLTextAreaElement>("general-prompt");
  let dead = false,
    epoch = 0,
    pending = false,
    inGeneral = false,
    request: PlanningRequest | null = null,
    intent: SceneIntent | null = null,
    draft: PlanDraft | null = null,
    query: CandidateQuery | null = null,
    catalog: CatalogView | null = null,
    resolved: ResolvedPlan | null = null,
    proposal: PatchProposal | null = null,
    metadata: GeneralSceneMetadata | null = null,
    currentMetadata: GeneralSceneMetadata | null = null,
    currentSyncRevision: string | null = null,
    currentSyncEpoch = -1,
    showingImport = false,
    manual = false,
    manualSetup = false,
    original: File | null = null;
  let catalogAbort: AbortController | null = null;
  const say = (message: string) => {
    get("general-message").textContent = friendlyMessage(message);
  };
  const entering = () => {
    if (!ports.enterMode()) throw Error("旧场景正在初始化或测量，请稍后再试。");
  };
  const state = () => controller.getState();
  async function refreshCurrent(ticket: number) {
    const revision = state().current?.revisionId;
    if (!revision) {
      currentMetadata = null;
      return;
    }
    const next = await controller.metadata();
    if (
      !live(ticket) ||
      state().current?.revisionId !== revision ||
      next?.revisionId !== revision
    )
      return;
    currentMetadata = next;
    showingImport = false;
    currentSyncRevision = revision;
    currentSyncEpoch = epoch;
    if (state().phase !== "previewing") {
      metadata = next;
      renderMetadata();
    }
  }
  function syncCurrent(s: ControllerState) {
    const revision = s.current?.revisionId;
    if (
      !inGeneral ||
      pending ||
      !revision ||
      currentMetadata?.revisionId === revision ||
      (revision === currentSyncRevision && currentSyncEpoch === epoch) ||
      !["idle", "committed"].includes(s.phase) ||
      s.finalization.kind !== "none"
    )
      return;
    currentSyncRevision = revision;
    currentSyncEpoch = epoch;
    const ticket = epoch;
    void controller
      .whenSettled()
      .then(() => {
        if (live(ticket)) return refreshCurrent(ticket);
      })
      .catch(() => {
        if (live(ticket) && state().current?.revisionId === revision) {
          metadata = null;
          renderMetadata();
          paragraph(
            get("general-current"),
            "当前修订已保存，暂未能读取对象信息；请重开场景。",
          );
        }
      });
  }
  function update(s: ControllerState) {
    if (["idle", "failed", "committed"].includes(s.phase)) resolved = null;
    const status = get("general-status");
    status.dataset.phase = s.phase;
    status.dataset.finalization = s.finalization.kind;
    // A failed parse leaves the controller awaiting review with nothing to
    // review; say so instead of "等待审阅".
    const parseFailed =
      s.phase === "awaiting-review" && !intent && !manualSetup && !pending;
    status.textContent =
      (parseFailed ? "解析未完成" : phaseText[s.phase]) +
      (s.finalization.kind === "cleanup-pending"
        ? "；取消已响应，资源仍在清理"
        : s.finalization.kind === "commit-pending"
          ? "；正在等待本地保存事务的最终结果"
          : "");
    if (s.lastSave)
      get("general-saved").textContent =
        s.lastSave.displayStatus === "recovering"
          ? "已保存，显示恢复中。可以重开已保存修订。"
          : "已保存到本机。";
    const busy =
      pending ||
      [
        "requesting",
        "parsing",
        "querying",
        "planning",
        "building",
        "saving",
      ].includes(s.phase) ||
      s.finalization.kind !== "none";
    host.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      if (!["general-cancel", "general-leave"].includes(b.id))
        b.disabled = busy;
    });
    // Cancel and leave stay available as escape hatches whenever they can do
    // something, but are disabled when idle so they don't look like no-ops.
    const hasWorkToCancel =
      busy ||
      !["idle", "committed"].includes(s.phase) ||
      !!intent ||
      !!draft ||
      manualSetup ||
      !!resolved ||
      !!proposal;
    button("general-cancel").disabled = !hasWorkToCancel;
    button("general-leave").disabled = !inGeneral;
    get<HTMLInputElement>("general-import").disabled = busy;
    button("general-preview").disabled = busy || !resolved;
    button("general-review").disabled = busy || !draft || !intent;
    button("general-use").disabled = busy || s.phase !== "previewing";
    const displaysCurrent =
      !showingImport && metadata?.revisionId === s.current?.revisionId;
    button("general-undo").disabled =
      !displaysCurrent ||
      busy ||
      !s.current ||
      !currentMetadata?.parentRevisionId ||
      s.phase === "previewing";
    for (const id of ["general-export-reference", "general-export-embedded"])
      button(id).disabled =
        !displaysCurrent || busy || !s.current || s.phase === "previewing";
    if (
      metadata?.assets.some(
        (a) => !a.manifest.provenance.license.redistributable,
      )
    )
      button("general-export-embedded").disabled = true;
    host
      .querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >(
        "#general-form input,#general-form select,#general-form textarea,#general-edit input,#general-edit select,#general-edit textarea,#general-confirmations input,#general-global input",
      )
      .forEach((e) => (e.disabled = busy));
    const accept = host.querySelector<HTMLInputElement>(
        "#general-scope-accept",
      ),
      preview = host.querySelector<HTMLButtonElement>("#general-patch-preview");
    if (preview) preview.disabled = busy || !proposal || !accept?.checked;
    if (s.phase === "failed" && s.issues.length)
      say(s.issues.map((i) => i.message).join("；"));
    syncCurrent(s);
  }
  const unsubscribe = controller.subscribe(update);
  async function run(work: (ticket: number) => Promise<void>) {
    if (dead || pending) return;
    const ticket = epoch;
    pending = true;
    say("");
    update(state());
    try {
      entering();
      await work(ticket);
    } catch (e) {
      if (!dead && ticket === epoch)
        say(e instanceof Error ? e.message : String(e));
    } finally {
      if (!dead && ticket === epoch) {
        pending = false;
        update(state());
      }
    }
  }
  const live = (ticket: number) => !dead && ticket === epoch;
  function clearReview() {
    resolved = null;
    proposal = null;
    get("general-scope").replaceChildren();
    get("general-scope").hidden = true;
    button("general-preview").hidden = true;
  }
  function cancel(message = "预览已取消，已提交的保存记录保留。") {
    epoch++;
    pending = false;
    catalogAbort?.abort();
    catalogAbort = null;
    controller.cancel();
    clearReview();
    request = null;
    intent = null;
    draft = null;
    query = null;
    manualSetup = false;
    showingImport = false;
    metadata =
      currentMetadata?.revisionId === state().current?.revisionId
        ? currentMetadata
        : null;
    renderMetadata();
    get("general-form").hidden = true;
    get("general-global").hidden = true;
    get<HTMLInputElement>("general-global-accept").checked = false;
    get("general-confirmations").replaceChildren();
    button("general-review").hidden = true;
    get("general-summary").replaceChildren();
    say(message);
    update(state());
  }
  prompt.addEventListener("input", () =>
    cancel("描述已修改，旧候选与确认已失效。请重新解析或手工设置。"),
  );
  button("general-cancel").onclick = () => cancel();
  button("general-leave").onclick = () => {
    cancel("已返回旧场景。");
    ports.leaveMode();
  };
  const newRequest = (): PlanningRequest => ({
    operationId: crypto.randomUUID(),
    prompt: prompt.value,
    baseRevisionId: state().current?.revisionId ?? null,
    manualOverrides: [],
  });
  async function loadCatalog(ticket: number) {
    catalogAbort?.abort();
    const abort = new AbortController();
    catalogAbort = abort;
    catalog = null;
    const value = await controller.catalog(abort.signal);
    if (!live(ticket)) return null;
    catalog = value;
    return value;
  }
  function summaryAtom(a: AtomicConstraint, scope?: "water") {
    const humanValue = (value: JsonValue): JsonValue => {
      if (Array.isArray(value)) return value.map(humanValue);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, v]) => {
            if (key === "groupId" && typeof v === "string") {
              const index =
                intent?.features.findIndex((f) => f.featureId === v) ?? -1;
              return [
                "对象组",
                index >= 0
                  ? `${category(intent!.features[index].category)}组 ${index + 1}`
                  : "指定对象组",
              ];
            }
            if (key === "regionId" && typeof v === "string") {
              const index =
                  draft?.regions.findIndex((r) => r.regionId === v) ?? -1,
                region = draft?.regions[index];
              return [
                "区域",
                region
                  ? `区域 ${index + 1}（${boundsText(region.shape.kind === "rectangle" ? [region.shape.min, region.shape.max] : region.shape.polygon)}）`
                  : "指定区域",
              ];
            }
            return [key, humanValue(v)];
          }),
        );
      return value;
    };
    if (
      a.key.startsWith("slots.") &&
      a.key.endsWith(".count") &&
      a.value &&
      typeof a.value === "object" &&
      !Array.isArray(a.value)
    ) {
      const groupId = a.value.groupId,
        index =
          intent?.features.findIndex((f) => f.featureId === groupId) ?? -1;
      return `${index >= 0 ? category(intent!.features[index].category) : "对象"}建议数量：${a.value.value}（${source(a.source)}）`;
    }
    return showAtom({ ...a, value: humanValue(a.value) }, scope);
  }
  function showOutcome(out: PlanningOutcome) {
    const payload = out.ok ? out.value : out.partial;
    intent = payload.intent;
    draft = payload.draft;
    query = out.query;
    const summary = get("general-summary");
    summary.replaceChildren(node("h3", "要求、建议与缺失"));
    paragraph(
      summary,
      manual
        ? "手工设置，未验证原句完整覆盖。"
        : payload.intent
          ? "下列内容来自本次实际解析；未通过的要求仍需处理。"
          : "解析未完成，原句已保留。可以选择手工设置；不会将手工设置计作模型理解成功。",
    );
    if (intent) {
      paragraph(
        summary,
        intent.water.mode === "none"
          ? "水体要求：明确无水。"
          : intent.water.mode === "unspecified"
            ? "水体要求：原文未说明，必须明确选择。"
            : intent.water.mode === "conflict"
              ? "水体要求存在冲突，请澄清。"
              : `水体要求：${intent.water.mode === "river" ? "河流" : "静态水面"}。`,
      );
      intent.terrain.forEach((a) => paragraph(summary, summaryAtom(a)));
      intent.features.forEach((f) =>
        paragraph(
          summary,
          `${category(f.category)}：${f.quantity ? summaryAtom(f.quantity) : "数量未说明，待审阅建议"}；${origin(f.sourceRestriction)}；${f.required ? "必要" : "可选"}`,
        ),
      );
      intent.features.forEach((f, index) =>
        f.constraints.forEach((a) =>
          paragraph(
            summary,
            `${category(f.category)}组 ${index + 1}：${summaryAtom(a)}`,
          ),
        ),
      );
      intent.sourceConstraints.forEach((a) =>
        paragraph(summary, `来源约束：${summaryAtom(a)}`),
      );
      intent.relations.forEach((a) =>
        paragraph(summary, `空间关系：${summaryAtom(a)}`),
      );
      intent.prohibitions.forEach((a) =>
        paragraph(summary, `禁止项：${summaryAtom(a)}`),
      );
      intent.water.constraints.forEach((a) =>
        paragraph(summary, `水体要求：${summaryAtom(a, "water")}`),
      );
      if (intent.seed) paragraph(summary, summaryAtom(intent.seed));
      if (intent.unspecified.length)
        paragraph(
          summary,
          `未说明项：${intent.unspecified.map(friendlyKey).join("、")}`,
        );
      issues(summary, [...intent.conflicts, ...intent.unsupported]);
    }
    // The query and the draft review report the same missing slots; show each
    // reason once so the list reads as one set of problems, not two.
    const shownMissing = new Set<string>();
    const showMissing = (m: { required: boolean; reason: string }) => {
      if (shownMissing.has(m.reason)) return;
      shownMissing.add(m.reason);
      paragraph(
        summary,
        `${m.required ? "必要素材缺失" : "可选素材缺失"}：${m.reason}`,
      );
    };
    if (query) {
      query.missing.forEach(showMissing);
      query.alternatives.forEach((a) =>
        paragraph(
          summary,
          `替代建议：${a.requested} → ${category(a.candidate.category)}（${a.difference}；${a.impact}）。必须明确修改来源与选择。`,
        ),
      );
      issues(summary, query.issues);
    }
    if (draft) {
      draft.review.assumptions.forEach((a) =>
        paragraph(summary, `建议：${summaryAtom(a)}`),
      );
      draft.review.missing.forEach(showMissing);
    }
    if (
      query?.missing.some((m) => m.required) ||
      draft?.review.missing.some((m) => m.required)
    )
      paragraph(
        summary,
        "下一步：本机素材库里还没有可用的对应素材，暂时无法生成预览。可以减少或更换上面缺失的对象；或按《使用说明》配置并准入素材库后重试；也可以在“高级与旧版本兼容”中查看已有的湿地示例。",
      );
    if (!out.ok) issues(summary, out.issues);
    if (payload.evidence.some((e) => e.provenance === "constructed"))
      paragraph(summary, "本次响应含构造测试证据，不能作为真实模型验收。");
    get("general-evidence").textContent = JSON.stringify(
      { request: out.request, intent, query, modelEvidence: payload.evidence },
      null,
      2,
    );
  }
  // Validate before entering the general mode, so an empty description does
  // not replace the scene the user is looking at with an empty preview.
  const requirePrompt = (message: string) => {
    if (prompt.value.trim()) return true;
    say(message);
    prompt.focus();
    return false;
  };
  button("general-plan").onclick = () => {
    if (!requirePrompt("请先填写场景描述，再点“解析场景要求”。")) return;
    void run(async (ticket) => {
      controller.cancel();
      clearReview();
      manual = false;
      manualSetup = false;
      request = newRequest();
      const out = await controller.plan(request);
      if (!live(ticket)) return;
      if (
        !out.ok &&
        !out.partial.intent &&
        !out.partial.draft &&
        !state().current
      ) {
        // Nothing to review or display: go back to the scene the user was
        // looking at instead of leaving an empty draft preview. Leaving the
        // mode clears the summary, so render the outcome afterwards.
        ports.leaveMode();
        showOutcome(out);
        say("解析未完成，旧场景保持不变。可以修改描述后重试，或改用手工设置。");
        return;
      }
      showOutcome(out);
      if (draft && intent) {
        try {
          await loadCatalog(ticket);
        } catch (e) {
          say(`素材目录不可用：${String(e)}`);
          return;
        }
        if (live(ticket)) renderForm();
      }
    });
  };
  const startManual = async (): Promise<number | null> => {
    if (!requirePrompt("请先填写场景描述，再设置手工参数。")) return null;
    let completed: number | null = null;
    await run(async (ticket) => {
      controller.cancel();
      clearReview();
      manual = true;
      manualSetup = true;
      request = newRequest();
      const out = await controller.planManual(request);
      if (!live(ticket)) return;
      showOutcome(out);
      await loadCatalog(ticket);
      if (!live(ticket)) return;
      renderManualSetup();
      completed = ticket;
    });
    return completed;
  };
  button("general-manual").onclick = () => void startManual();
  // First-use example: fills the manual form with a scene the bundled starter
  // library can build, then stops before review so the user still confirms
  // each procedural source.
  button("general-example").onclick = async () => {
    if (pending) return;
    prompt.value = EXAMPLE_PROMPT;
    const ticket = await startManual();
    if (ticket === null || !live(ticket)) return;
    const water = host.querySelector<HTMLSelectElement>("#general-water-mode"),
      style = host.querySelector<HTMLSelectElement>("#general-style"),
      add = host.querySelector<HTMLButtonElement>("#general-add-role");
    if (dead || !manualSetup || !water || !style || !add) return;
    const choose = (select: HTMLSelectElement, value: string) => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    choose(water, "none");
    const surface = [...style.options].find((o) => o.value);
    if (surface) choose(style, surface.value);
    for (const [category, count] of EXAMPLE_GROUPS) {
      add.click();
      const row = get("general-manual-roles").lastElementChild!;
      choose(row.querySelector("[data-manual-category]")!, category);
      row.querySelector<HTMLInputElement>("[data-manual-count]")!.value =
        String(count);
      choose(row.querySelector("[data-manual-source]")!, "procedural");
    }
    say(
      surface
        ? "已填好示例：平地、3 块石头、5 丛低草、不放水。核对下面的设置后，点“审阅手工设置”继续。"
        : "已填好示例对象，但本机还没有可用的地形/水面样式，暂时无法生成预览。",
    );
  };
  const number = (id: string) => {
    const el = get<HTMLInputElement>(id),
      value = el.valueAsNumber;
    if (!el.value.trim() || !Number.isFinite(value) || !el.checkValidity())
      throw Error(`请检查${el.labels?.[0]?.textContent ?? id}。`);
    return value;
  };
  function baseForm() {
    const form = get("general-form");
    form.hidden = false;
    form.innerHTML = `<h3>场景设置</h3><p class="general-note">宽深为 4–10 展示单位；X 向东、Z 向北。“左/右”不按当前相机自动解释。</p>
    <div class="general-grid"><label>宽度<input id="general-width" type="number" min="4" max="10" step="0.5" value="4"></label><label>深度<input id="general-depth" type="number" min="4" max="10" step="0.5" value="4"></label>
    <label>地形来源<select id="general-terrain-source"><option value="procedural">程序地形</option><option value="patch">刚性扫描地块</option></select></label><label>扫描地块<select id="general-patch-source"></select></label>
    <label>坡度（度）<input id="general-slope" type="number" min="0" max="12" step="any" value="0"></label><label>坡向（0 北 / 90 东）<input id="general-azimuth" type="number" min="0" max="360" step="any" value="0"></label>
    <label>水体<select id="general-water-mode"><option value="unspecified">未说明，待选择</option><option value="none">无水</option><option value="river">一条静态河流</option><option value="surface">一处静态水面</option></select></label><label>表面素材<select id="general-style"></select></label></div>
    <details><summary>地形与水体参数</summary><p id="general-water-edit-note" class="general-note"></p><div class="general-grid">
    <label>基准高程<input id="general-elevation" type="number" min="-2" max="2" step="any" value="0"></label><label>起伏幅度<input id="general-noise" type="number" min="0" max="0.4" step="any" value="0"></label><label>起伏尺度<input id="general-noise-scale" type="number" min="0.5" max="5" step="any" value="2"></label><label>起伏层数<input id="general-noise-octaves" type="number" min="1" max="4" step="1" value="1"></label>
    <label>采样间距<select id="general-spacing"><option value="0.2">0.2</option><option value="0.1">0.1</option></select></label><label>种子<input id="general-seed" type="number" min="0" max="4294967295" step="1" value="42"></label>
    <label>河宽<input id="general-water-width" type="number" min="0.4" max="2" step="any" value="0.6"></label><label>水深<input id="general-water-depth" type="number" min="0.05" max="0.5" step="any" value="0.1"></label><label>岸带宽度<input id="general-bank-width" type="number" min="0.2" max="1" step="any" value="0.4"></label><label>水位（留空由程序建议）<input id="general-water-level" type="number" min="-2" max="2" step="any"></label>
    <label>地形塑形<select id="general-reshape"><option value="cut-and-fill">削土并填土</option><option value="cut-only">仅削土</option><option value="preserve">保持地形</option></select></label></div>
    <label>河流控制点（每行 u v，均为 0–1）<textarea id="general-water-points" rows="3">0.5 0\n0.5 1</textarea></label><label>水面边界（每行 X Z）<textarea id="general-surface-points" rows="3">-0.5 -0.5\n0.5 -0.5\n0.5 0.5\n-0.5 0.5</textarea></label></details>
    <div id="general-groups"></div><div id="general-form-extra"></div>`;
    const style = get<HTMLSelectElement>("general-style");
    style.append(new Option("未选择 / 无已验收表面", ""));
    catalog?.styles
      .filter((s) => s.quality.status === "accepted" && s.quality.humanReview)
      .forEach((s, i) =>
        style.append(
          new Option(`程序表面 ${i + 1}（${s.provenance.author}）`, refKey(s)),
        ),
      );
    const patches = get<HTMLSelectElement>("general-patch-source");
    patches.append(new Option("选择已验收场地", ""));
    catalog?.manifests
      .filter(
        (m) =>
          m.kind === "patch" &&
          m.quality.status === "accepted" &&
          m.quality.humanReview,
      )
      .forEach((m, i) =>
        patches.append(
          new Option(
            `场地 ${i + 1}（${origin(m.origin)}，${m.provenance.author}）`,
            refKey(m),
          ),
        ),
      );
    form.oninput = () => {
      get<HTMLInputElement>("general-global-accept").checked = false;
      clearReview();
      get("general-confirmations")
        .querySelectorAll<HTMLInputElement>("input")
        .forEach((c) => (c.checked = false));
      if (state().phase === "previewing") {
        cancel("设置已修改，旧预览失效。请重新解析或手工设置。");
      }
      update(state());
    };
    form.onchange = () => {
      if (!manualSetup && draft && intent) renderConfirmations();
    };
  }
  function set(id: string, value: unknown) {
    get<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id).value =
      String(value ?? "");
  }
  function renderManualSetup() {
    baseForm();
    get("general-summary").replaceChildren(
      node("h3", "手工设置"),
      node(
        "p",
        "手工设置，未验证原句完整覆盖。请逐项填写，不会把此过程计作模型理解成功。",
      ),
    );
    const extra = get("general-form-extra"),
      roles = node("div");
    roles.id = "general-manual-roles";
    extra.append(node("h3", "需要哪些对象"), roles);
    const add = node("button", "添加一组对象");
    add.id = "general-add-role";
    extra.append(add);
    add.onclick = () => {
      if (roles.children.length >= 8) {
        say("首版最多 8 个要素组。");
        return;
      }
      const row = node("fieldset"),
        typeLabel = node("label", "对象类别"),
        type = node("select"),
        countLabel = node("label", "数量"),
        count = node("input"),
        fromLabel = node("label", "素材来源"),
        from = node("select"),
        remove = node("button", "移除此组");
      type.dataset.manualCategory = "";
      [
        ["rock", "石头"],
        ["grass", "低草"],
        ["reed", "芦苇"],
        ["tree", "树"],
      ].forEach(([value, label]) => type.append(new Option(label, value)));
      count.type = "number";
      count.min = "0";
      count.max = "20";
      count.step = "1";
      count.value = "1";
      count.dataset.manualCount = "";
      from.dataset.manualSource = "";
      [
        ["either", "不限，程序素材需确认"],
        ["captured", "只要实拍"],
        ["procedural", "程序素材"],
      ].forEach(([value, label]) => from.append(new Option(label, value)));
      typeLabel.append(type);
      countLabel.append(count);
      fromLabel.append(from);
      row.append(typeLabel, countLabel, fromLabel, remove);
      roles.append(row);
      remove.onclick = () => row.remove();
    };
    const advanced = node("details");
    advanced.append(node("summary", "高级：批量填写其他对象类别"));
    const label = node("label", "手工要素（每行：类别 数量 来源）"),
      input = node("textarea");
    input.id = "general-manual-groups";
    input.rows = 4;
    input.placeholder = "石头 2 实拍";
    label.append(input);
    advanced.append(
      label,
      node(
        "p",
        "填写后使用这些行替代上方对象组。可用中文类别与来源；缺素材会明确阻断。",
      ),
    );
    extra.append(advanced);
    const prepare = node("button", "审阅手工设置");
    prepare.id = "general-manual-prepare";
    extra.append(prepare);
    button("general-review").hidden = true;
    prepare.onclick = () => {
      void run(async (ticket) => {
        if (!catalog || !request) throw Error("先打开手工设置并读取素材目录。");
        if (!request.prompt.trim()) {
          prompt.focus();
          throw Error("请先填写场景描述，再设置手工参数。");
        }
        const rows = input.value.trim()
          ? input.value.trim().split("\n")
          : Array.from(roles.children).map((row) => {
              const category = row.querySelector<HTMLSelectElement>(
                  "[data-manual-category]",
                )!.value,
                count = row.querySelector<HTMLInputElement>(
                  "[data-manual-count]",
                )!,
                from = row.querySelector<HTMLSelectElement>(
                  "[data-manual-source]",
                )!.value;
              if (!count.checkValidity()) throw Error("请检查对象数量。");
              return `${category} ${count.value} ${from}`;
            });
        const groups = rows.map((line) => {
          const [name, countText, from, ...rest] = line.trim().split(/\s+/);
          const nameMap: Record<string, string> = {
              石头: "rock",
              低草: "grass",
              草: "grass",
              芦苇: "reed",
              树: "tree",
            },
            sourceMap: Record<string, string> = {
              不限: "either",
              实拍: "captured",
              程序: "procedural",
              生成: "generated",
            };
          const restriction = sourceMap[from] ?? from;
          if (
            rest.length ||
            !name ||
            !countText ||
            !["either", "captured", "procedural", "generated"].includes(
              restriction,
            )
          )
            throw Error("每行填写：类别 数量 来源；来源可选不限、实拍、程序。");
          return {
            category: nameMap[name] ?? name,
            count: Number(countText),
            sourceRestriction:
              restriction as SceneIntent["features"][number]["sourceRestriction"],
            required: true,
          };
        });
        const built = await makeManualDraft(
          request,
          {
            width: number("general-width"),
            depth: number("general-depth"),
            seed: number("general-seed"),
            terrain: readTerrain(),
            water: readWater(),
            groups,
          },
          catalog,
        );
        if (!live(ticket)) return;
        intent = built.intent;
        draft = built.draft;
        query = built.query;
        manualSetup = false;
        // The form's explicit surface choice is retained; no hidden fallback selection.
        const chosenStyle = get<HTMLSelectElement>("general-style").value;
        if (chosenStyle) {
          const s = catalog.styles.find((s) => refKey(s) === chosenStyle)!;
          draft = parsePlanDraft({
            ...draft,
            surfaceStyleRef: { id: s.id, contentVersion: s.contentVersion },
          });
        }
        showOutcome({
          ok: false,
          mode: "manual",
          request,
          query,
          inputs: [],
          issues: [],
          partial: { intent, draft, evidence: [] },
        });
        renderForm();
      });
    };
  }
  function readTerrain(): PlanDraft["terrain"] {
    if (get<HTMLSelectElement>("general-terrain-source").value === "patch") {
      const m = catalog?.manifests.find(
        (m) =>
          m.kind === "patch" &&
          refKey(m) === get<HTMLSelectElement>("general-patch-source").value,
      );
      if (!m || m.kind !== "patch") throw Error("请选择真实可用的扫描地块。");
      return {
        source: "patch",
        assetRef: { id: m.id, contentVersion: m.contentVersion },
        transform: m.patch.displayTransform,
      };
    }
    return {
      source: "procedural",
      elevation: number("general-elevation"),
      slopeDegrees: number("general-slope"),
      slopeAzimuthDegrees: number("general-azimuth"),
      noiseAmplitude: number("general-noise"),
      noiseScale: number("general-noise-scale"),
      noiseOctaves: number("general-noise-octaves"),
      spacing: Number(get<HTMLSelectElement>("general-spacing").value) as
        0.1 | 0.2,
    };
  }
  function readWater(): PlanDraft["water"] {
    const mode = get<HTMLSelectElement>("general-water-mode")
      .value as PlanDraft["water"]["mode"];
    if (mode === "none" || mode === "unspecified") return { mode };
    const input = get<HTMLInputElement>("general-water-level"),
      level = input.value.trim() ? number("general-water-level") : null;
    const old = draft?.water,
      unchanged = old && "level" in old && old.level === level;
    const common = {
      waterId: old && "waterId" in old ? old.waterId : "water-1",
      depth: number("general-water-depth"),
      bankWidth: number("general-bank-width"),
      level,
      levelStatus:
        level === null ? ("pending" as const) : ("resolved" as const),
      levelSource:
        level === null
          ? null
          : unchanged
            ? old.levelSource
            : ("manual" as const),
      reshapePolicy: get<HTMLSelectElement>("general-reshape").value as
        "preserve" | "cut-only" | "cut-and-fill",
    };
    return mode === "river"
      ? {
          mode,
          ...common,
          controlPoints: [
            ...points(get<HTMLTextAreaElement>("general-water-points").value),
          ],
          width: number("general-water-width"),
        }
      : {
          mode: "surface",
          ...common,
          polygon: points(
            get<HTMLTextAreaElement>("general-surface-points").value,
          ),
        };
  }
  function renderForm() {
    if (!draft || !intent) return;
    get("general-global").hidden = !state().current;
    get<HTMLInputElement>("general-global-accept").checked = false;
    baseForm();
    const d = draft;
    set("general-width", d.domain.width);
    set("general-depth", d.domain.depth);
    set("general-seed", d.seed);
    set("general-terrain-source", d.terrain.source);
    set("general-style", d.surfaceStyleRef ? refKey(d.surfaceStyleRef) : "");
    if (d.terrain.source === "patch")
      set("general-patch-source", refKey(d.terrain.assetRef));
    else
      for (const [id, key] of [
        ["general-elevation", "elevation"],
        ["general-slope", "slopeDegrees"],
        ["general-azimuth", "slopeAzimuthDegrees"],
        ["general-noise", "noiseAmplitude"],
        ["general-noise-scale", "noiseScale"],
        ["general-noise-octaves", "noiseOctaves"],
        ["general-spacing", "spacing"],
      ] as const)
        set(id, d.terrain[key]);
    set("general-water-mode", d.water.mode);
    get("general-water-edit-note").textContent = intent.water.constraints.some(
      (a) => a.strength === "hard" && a.key !== "level",
    )
      ? "已明确的河宽、水深、岸带、控制点、水面边界或塑形要求不能在这里静默覆盖。更改这些要求，请重新点击“手工设置”或修改描述后解析，再审阅完整规划。水位可按明确手工修改记录。"
      : "控制点、水面边界与塑形会影响整个场景。水位留空时由程序建议；建议值须通过真实几何预检。";
    if ("level" in d.water) {
      set("general-water-level", d.water.level);
      set("general-water-depth", d.water.depth);
      set("general-bank-width", d.water.bankWidth);
      set("general-reshape", d.water.reshapePolicy);
      if (d.water.mode === "river") {
        set("general-water-width", d.water.width);
        set("general-water-points", polygonText(d.water.controlPoints));
      } else set("general-surface-points", polygonText(d.water.polygon));
    }
    const groupHost = get("general-groups");
    groupHost.append(node("h3", "对象与数量"));
    for (const [index, g] of d.groups.entries()) {
      const f = intent.features.find((f) => f.featureId === g.groupId),
        row = node("fieldset"),
        legend = node(
          "legend",
          `${category(f?.category ?? "对象")} ${index + 1}`,
        );
      row.append(legend);
      const label = node(
          "label",
          `数量（${g.countMode === "hard" ? "明确要求" : "建议"}）`,
        ),
        count = node("input");
      count.type = "number";
      count.min = "0";
      count.max = "20";
      count.step = "1";
      count.value = String(g.count);
      count.dataset.groupCount = g.groupId;
      label.append(count);
      row.append(label);
      const assetLabel = node("label", "素材"),
        select = node("select");
      select.dataset.groupAsset = g.groupId;
      select.append(new Option("未找到可用素材", ""));
      const slot = query?.slots.find((s) => s.groupId === g.groupId);
      slot?.candidates.forEach((c, i) =>
        select.append(
          new Option(
            `${category(c.category)} ${i + 1}（${origin(c.origin)}）`,
            refKey(c.assetRef),
          ),
        ),
      );
      if (
        g.assetRef &&
        !Array.from(select.options).some((o) => o.value === refKey(g.assetRef!))
      )
        select.append(new Option("原规划素材", refKey(g.assetRef)));
      select.value = g.assetRef ? refKey(g.assetRef) : "";
      assetLabel.append(select);
      row.append(assetLabel);
      const region = d.regions.find((r) => r.regionId === g.regionId);
      paragraph(
        row,
        region
          ? `所在区域：${region.shape.kind === "rectangle" ? boundsText([region.shape.min, region.shape.max]) : boundsText(region.shape.polygon)}`
          : "所在区域：整个场地",
      );
      groupHost.append(row);
    }
    button("general-review").hidden = false;
    renderConfirmations();
  }
  function readDraft(): PlanDraft {
    if (!draft || !intent || !catalog) throw Error("尚无可审阅规划。");
    const d = structuredClone(draft),
      overrides = new Map(
        d.review.manualOverrides
          .filter((a) => !a.key.startsWith("accept."))
          .map((a) => [a.key, a]),
      );
    const assign = (key: string, value: JsonValue, old: unknown) => {
      if (JSON.stringify(value) !== JSON.stringify(old))
        overrides.set(key, manualAtom(key, value));
    };
    const width = number("general-width"),
      depth = number("general-depth"),
      seed = number("general-seed"),
      terrain = readTerrain(),
      water = readWater();
    assign("terrain.width", width, d.domain.width);
    assign("terrain.depth", depth, d.domain.depth);
    assign("seed", seed, d.seed);
    assign("terrain.source", terrain.source, d.terrain.source);
    if (terrain.source === "procedural")
      Object.entries(terrain).forEach(([key, value]) => {
        if (key !== "source")
          assign(
            `terrain.${key}`,
            value,
            (d.terrain as unknown as Record<string, unknown>)[key],
          );
      });
    for (const constraint of intent.water.constraints) {
      if (constraint.strength !== "hard" || constraint.key === "level")
        continue;
      const before = (d.water as unknown as Record<string, unknown>)[
          constraint.key
        ],
        after = (water as unknown as Record<string, unknown>)[constraint.key];
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw Error(
          `当前明确水体要求“${friendlyKey(`water.${constraint.key}`)}”已改变。请重新进入手工设置后审阅完整要求；不会静默覆盖原要求。`,
        );
    }
    assign("water.mode", water.mode, d.water.mode);
    if ("level" in water && water.level !== null)
      assign(
        "water.level",
        water.level,
        "level" in d.water ? d.water.level : null,
      );
    d.domain = { ...d.domain, width, depth };
    d.seed = seed;
    d.terrain = terrain;
    d.water = water;
    const style = catalog.styles.find(
      (s) => refKey(s) === get<HTMLSelectElement>("general-style").value,
    );
    d.surfaceStyleRef = style
      ? { id: style.id, contentVersion: style.contentVersion }
      : null;
    d.groups = d.groups.map((g) => {
      const row = Array.from(
          host.querySelectorAll<HTMLInputElement>("[data-group-count]"),
        ).find((e) => e.dataset.groupCount === g.groupId)!,
        asset = Array.from(
          host.querySelectorAll<HTMLSelectElement>("[data-group-asset]"),
        ).find((e) => e.dataset.groupAsset === g.groupId)!;
      if (!row.checkValidity() || !Number.isFinite(row.valueAsNumber))
        throw Error("对象数量应为 0–20 的整数。");
      const count = row.valueAsNumber,
        m = catalog!.manifests.find((m) => refKey(m) === asset.value);
      assign(`features.${g.groupId}.count`, count, g.count);
      const changed = m && (!g.assetRef || refKey(m) !== refKey(g.assetRef));
      const selected = changed
        ? query?.slots
            .find((s) => s.groupId === g.groupId)
            ?.candidates.find((c) => refKey(c.assetRef) === refKey(m))
        : undefined;
      const placement = selected ? placementForCandidate(selected) : null;
      return {
        ...g,
        ...(placement
          ? {
              ...placement,
              placementPolicy: {
                ...placement.placementPolicy,
                spacingMargin: g.placementPolicy.spacingMargin,
                maxSlopeDegrees: Math.min(
                  g.placementPolicy.maxSlopeDegrees,
                  placement.placementPolicy.maxSlopeDegrees,
                ),
              },
            }
          : {}),
        count,
        countMode: count === g.count ? g.countMode : "hard",
        assetRef: m ? { id: m.id, contentVersion: m.contentVersion } : null,
      };
    });
    d.review.manualOverrides = [...overrides.values()];
    d.review.acceptedSubstitutions = [];
    d.review.substitutions = d.review.substitutions.filter(
      (s) => !s.substitutionId.startsWith("procedural:"),
    );
    d.budgetEstimate = null;
    return parsePlanDraft(d);
  }
  function renderConfirmations() {
    const target = get("general-confirmations");
    target.replaceChildren();
    if (!draft || !intent || !catalog) return;
    try {
      const d = readDraft(),
        choices = proceduralChoices(intent, d, catalog);
      if (choices.length) target.append(node("h3", "确认素材来源"));
      choices.forEach((c) => {
        const label = node("label"),
          input = node("input");
        label.className = "general-check";
        input.type = "checkbox";
        input.dataset.slot = c.slotId;
        label.append(
          input,
          node(
            "span",
            `我确认${category(c.label)}使用程序生成素材（当前内容版本），并了解它不是实拍。`,
          ),
        );
        target.append(label);
      });
      renderRights(target, d);
    } catch (e) {
      paragraph(target, e instanceof Error ? e.message : String(e));
    }
  }
  function renderRights(target: HTMLElement, d: PlanDraft) {
    if (!catalog) return;
    const refs = [
      ...d.groups.flatMap((g) => (g.assetRef ? [g.assetRef] : [])),
      ...(d.terrain.source === "patch" ? [d.terrain.assetRef] : []),
    ];
    const values = refs
      .map((r) => catalog!.manifests.find((m) => refKey(m) === refKey(r)))
      .filter((m) => m !== undefined);
    const style = d.surfaceStyleRef
      ? catalog.styles.find((s) => refKey(s) === refKey(d.surfaceStyleRef!))
      : undefined;
    const details = node("details");
    details.append(node("summary", "许可、来源与使用限制"));
    [...values, ...(style ? [style] : [])].forEach((m, i) => {
      paragraph(
        details,
        `素材 ${i + 1}：作者 ${m.provenance.author}；来源 ${m.provenance.source}；许可 ${m.provenance.license.id}。${m.provenance.license.attribution} ${m.provenance.license.redistributable ? "有再分发依据" : "不能随包再分发"}。`,
      );
      m.quality.limitations.forEach((l) => paragraph(details, l));
    });
    target.append(details);
  }
  function confirmationChanged() {
    if (state().phase === "previewing") {
      cancel("确认已撤回，旧预览已取消。请重新审阅。");
      return;
    }
    clearReview();
    update(state());
  }
  get<HTMLInputElement>("general-global-accept").onchange = confirmationChanged;
  get("general-confirmations").onchange = confirmationChanged;
  button("general-review").onclick = () => {
    void run(async (ticket) => {
      if (!intent || !request || !catalog)
        throw Error("请重新解析或打开手工设置。");
      if (
        state().current &&
        !get<HTMLInputElement>("general-global-accept").checked
      )
        throw Error(
          "请先确认全局重规划将影响整个场景；少量修改请使用局部编辑。",
        );
      const selected = new Set(
        Array.from(
          host.querySelectorAll<HTMLInputElement>(
            "#general-confirmations input:checked",
          ),
        ).map((i) => i.dataset.slot!),
      );
      const reviewed = await confirmProceduralChoices(
        request,
        intent,
        readDraft(),
        catalog,
        selected,
      );
      if (!live(ticket)) return;
      const value = take(
        await controller.review(
          reviewed,
          reviewed.review.manualOverrides,
          manual ? { kind: "manual-intent", intent } : undefined,
        ),
      );
      if (!live(ticket)) return;
      resolved = value;
      button("general-preview").hidden = false;
      const summary = get("general-summary");
      paragraph(summary, "设置检查通过。下一步生成预览，尚未保存。");
      if ("level" in value.plan.water)
        paragraph(
          summary,
          `解析后的水位：${value.plan.water.level}（${source(value.plan.water.levelSource)}）；塑形策略：${value.plan.water.reshapePolicy}。`,
        );
      get("general-evidence").textContent = JSON.stringify(
        { intent, plan: value.plan, geometryDigest: value.geometryDigest },
        null,
        2,
      );
    });
  };
  button("general-preview").onclick = () => {
    void run(async (ticket) => {
      if (!resolved) throw Error("请先审阅设置。");
      if (
        !request ||
        !intent ||
        !catalog ||
        request.baseRevisionId !== (state().current?.revisionId ?? null)
      )
        throw Error("当前修订已变化，请重新审阅。");
      if (
        state().current &&
        !get<HTMLInputElement>("general-global-accept").checked
      )
        throw Error("全局重规划确认已撤回，请重新审阅。");
      const accepted = new Set(
        Array.from(
          host.querySelectorAll<HTMLInputElement>(
            "#general-confirmations input:checked",
          ),
        ).map((i) => i.dataset.slot),
      );
      if (
        proceduralChoices(intent, readDraft(), catalog).some(
          (c) => !accepted.has(c.slotId),
        )
      )
        throw Error("素材来源确认已撤回，请重新审阅。");
      const value = take(await controller.preview(resolved));
      resolved = null;
      if (!live(ticket)) return;
      metadata = projection(value.snapshot, "editable");
      renderMetadata();
    });
  };
  button("general-use").onclick = () => {
    void run(async (ticket) => {
      const current = state();
      if (current.phase !== "previewing")
        throw Error("需要先成功显示候选场景。");
      take(await controller.use(current.operation.operationId));
      if (!live(ticket)) return;
      clearReview();
      await refreshCurrent(ticket);
      if (live(ticket)) {
        renderMetadata();
        await listScenes(ticket);
      }
    });
  };
  function renderMetadata() {
    const q = get("general-quality"),
      c = get("general-current"),
      deps = get("general-dependencies");
    q.replaceChildren();
    c.replaceChildren();
    deps.replaceChildren();
    if (!metadata) {
      renderEdit();
      return;
    }
    const m = metadata;
    q.append(
      node(
        "h3",
        m.reviewStatus === "draft"
          ? "草稿 · 尚未完成场景验收"
          : "已有对应场景验收记录",
      ),
    );
    paragraph(
      q,
      m.quality.semanticMode === "manual-corrected"
        ? "语义来源：手工修订；不计为模型首次理解正确。"
        : m.quality.semanticMode === "unverified"
          ? "语义来源：未验证。"
          : "语义来源：模型提出并核对。",
    );
    const list = node("ul");
    (
      ["semantic", "assets", "geometry", "visual", "performance"] as const
    ).forEach((k, i) => {
      const li = node(
        "li",
        `${["语义", "素材", "几何", "视觉", "性能"][i]}：${qualityText[m.quality[k].status]}`,
      );
      li.dataset.quality = k;
      li.dataset.status = m.quality[k].status;
      list.append(li);
      issues(q, m.quality[k].issues);
    });
    q.append(list);
    paragraph(
      q,
      `对象请求 ${m.validation.requested}，实际 ${m.validation.accepted}，缺口 ${m.validation.shortfall}；最坏展开 ${m.validation.usage.worstSplats.toLocaleString()} 点。`,
    );
    c.append(node("h3", m.access === "readonly" ? "只读场景" : "场景对象"));
    if (m.intent) paragraph(c, `场景原始描述：${m.intent.raw}`);
    if (m.access === "readonly")
      paragraph(c, "当前副本不可编辑或使用。请查看缺失依赖，原件仍可下载。");
    issues(c, m.issues);
    m.instances.forEach((instance, index) => {
      const asset = m.assets.find(
        (a) => refKey(a.assetRef) === refKey(instance.assetRef),
      );
      paragraph(
        c,
        `${index + 1}. ${category(asset?.manifest.category ?? "对象")} · X ${instance.transform.position[0].toFixed(2)} / Z ${instance.transform.position[2].toFixed(2)}${instance.locked ? " · 已锁定" : ""}`,
      );
    });
    deps.append(node("h3", "导出与重开依赖"));
    paragraph(
      deps,
      "引用包不含素材文件，重开需要相同内容版本的素材；含素材包仅在全部许可允许时提供。",
    );
    m.assets.forEach((a, i) =>
      paragraph(
        deps,
        `${category(a.manifest.category)} ${i + 1}：${a.manifest.provenance.author}；${a.manifest.provenance.license.id}；${a.manifest.provenance.source}；${a.manifest.provenance.license.redistributable ? "允许按记录再分发" : "不可随包分发"}。${a.manifest.provenance.license.attribution}`,
      ),
    );
    if (m.surfaceStyle) {
      const s = m.surfaceStyle.descriptor;
      paragraph(
        deps,
        `地形与水面素材：${s.provenance.author}；${s.provenance.source}；许可 ${s.provenance.license.id}。${s.provenance.license.attribution}`,
      );
    }
    const evidence = {
      sceneId: m.sceneId,
      revisionId: m.revisionId,
      geometryDigest: m.geometryDigest,
      assets: m.assets.map((a) => ({ assetRef: a.assetRef, digest: a.digest })),
      plan: m.plan,
      patch: m.patch,
    };
    get("general-evidence").textContent = JSON.stringify(evidence, null, 2);
    renderEdit();
    update(state());
  }
  async function listScenes(ticket: number) {
    const list = await controller.listScenes();
    if (!live(ticket)) return;
    const target = get("general-scenes");
    target.replaceChildren();
    if (!list.length) paragraph(target, "还没有已提交的本机场景。");
    list.forEach((scene, index) => {
      const b = node(
        "button",
        `重开场景 ${index + 1}（${scene.reviewStatus === "draft" ? "草稿" : "已验收"}）`,
      );
      b.dataset.sceneId = scene.sceneId;
      b.onclick = () => {
        void run(async (token) => {
          clearReview();
          take(await controller.reopen(scene.sceneId));
          if (!live(token)) return;
          await refreshCurrent(token);
          if (live(token)) {
            renderMetadata();
            say("已从本机重开保存结果，未重新调用模型。");
          }
        });
      };
      target.append(b);
    });
  }
  button("general-list").onclick = () => {
    void run(listScenes);
  };
  button("general-undo").onclick = () => {
    void run(async (ticket) => {
      if (showingImport || metadata?.revisionId !== state().current?.revisionId)
        throw Error("当前显示的是导入内容，请先取消导入或保存后再撤销。");
      take(await controller.undo());
      if (!live(ticket)) return;
      clearReview();
      await refreshCurrent(ticket);
      if (live(ticket)) renderMetadata();
    });
  };
  get<HTMLInputElement>("general-import").onchange = () => {
    const file = get<HTMLInputElement>("general-import").files?.[0];
    if (!file || pending || get<HTMLInputElement>("general-import").disabled)
      return;
    original = file;
    const downloadOriginal = node("button", "下载导入原件");
    downloadOriginal.onclick = () => {
      void run(async () => {
        take(await controller.downloadOriginal(file));
        say("原件下载已发起。");
      });
    };
    get("general-original").replaceChildren(downloadOriginal);
    void run(async (ticket) => {
      clearReview();
      const result = await controller.importFile(file);
      if (!live(ticket)) return;
      if (!result.ok) {
        showingImport = false;
        metadata =
          currentMetadata?.revisionId === state().current?.revisionId
            ? currentMetadata
            : null;
        renderMetadata();
        paragraph(
          get("general-current"),
          "未能编辑此归档；原件保留，可下载。未知版本不会按当前版本重建。",
        );
        if (metadata)
          paragraph(
            get("general-current"),
            "当前仍为先前已保存的场景；下方局部编辑只针对该已保存场景，不针对导入原件。",
          );
        throw Error(result.issues.map((i) => i.message).join("；"));
      }
      const imported = result.value;
      showingImport = true;
      metadata = projection(
        imported.snapshot,
        imported.editable ? "editable" : "readonly",
        imported.missingRefs.map((m) => ({
          code: "missing-assets",
          path: m.id,
          message: m.reason,
        })),
      );
      renderMetadata();
      paragraph(get("general-current"), imported.historyNotice);
      if (imported.editable)
        paragraph(
          get("general-current"),
          "导入结果为未保存候选；请先使用并保存草稿，再局部编辑。",
        );
    });
  };
  for (const mode of ["reference", "embedded"] as const)
    button(`general-export-${mode}`).onclick = () => {
      void run(async (ticket) => {
        if (
          showingImport ||
          metadata?.revisionId !== state().current?.revisionId
        )
          throw Error(
            "当前显示内容尚未保存到本机；可下载原件，或先取消导入后导出原场景。",
          );
        take(await controller.downloadArchive(mode));
        if (!live(ticket)) return;
        say(
          mode === "reference"
            ? "引用包已生成。重开仍需要上述原版本素材。"
            : "含素材包已生成，许可与署名保留。",
        );
      });
    };
  function renderEdit() {
    const target = get("general-edit");
    target.replaceChildren();
    target.hidden =
      !metadata ||
      metadata.access !== "editable" ||
      metadata.capability !== "editable" ||
      state().phase === "previewing";
    if (target.hidden || !metadata?.plan) return;
    const m = metadata;
    target.innerHTML = `<h3>局部编辑</h3><p>先查看请求区域 R、实际影响区域 H 与变化对象，再确认生成预览。锁定对象不可被自动移动或删除。</p>
    <label>修改说明<input id="general-edit-description" maxlength="2000" placeholder="描述本次局部修改"></label>
    <label>修改操作<select id="general-edit-kind"><option value="move">移动对象</option><option value="remove">删除对象</option><option value="replace">替换素材</option><option value="add">添加对象</option><option value="set-count">调整组数量</option><option value="brush">刷地：抬高或降低</option></select></label>
    <div class="general-grid"><label>对象<select id="general-edit-instance"></select></label><label>对象组<select id="general-edit-group"></select></label><label>素材<select id="general-edit-asset"></select></label><label>数量<input id="general-edit-count" type="number" min="0" max="20" step="1" value="1"></label><label>目标 X<input id="general-edit-x" type="number" step="any" value="0"></label><label>目标 Z<input id="general-edit-z" type="number" step="any" value="0"></label><label>刷地半径<input id="general-brush-radius" type="number" min="0.2" max="1" step="any" value="0.4"></label><label>高度增量（负值降低）<input id="general-brush-delta" type="number" min="-0.2" max="0.2" step="any" value="0.05"></label></div>
    <div id="general-edit-asset-details"></div><label>请求区域 R（每行 X Z，至少三个顶点）<textarea id="general-edit-region" rows="4"></textarea></label><div id="general-locks"></div><button id="general-propose">查看修改影响</button>`;
    const width = m.plan!.domain.width / 2,
      depth = m.plan!.domain.depth / 2;
    set(
      "general-edit-region",
      polygonText([
        [-width, -depth],
        [0, -depth],
        [0, depth],
        [-width, depth],
      ]),
    );
    const instance = get<HTMLSelectElement>("general-edit-instance"),
      group = get<HTMLSelectElement>("general-edit-group"),
      assets = get<HTMLSelectElement>("general-edit-asset");
    m.instances.forEach((item, i) => {
      const a = m.assets.find(
        (a) => refKey(a.assetRef) === refKey(item.assetRef),
      );
      instance.append(
        new Option(
          `${category(a?.manifest.category ?? "对象")} ${i + 1}`,
          item.instanceId,
        ),
      );
    });
    m.plan!.groups.forEach((g, i) => {
      const a = m.assets.find((a) => refKey(a.assetRef) === refKey(g.assetRef));
      group.append(
        new Option(
          `${category(a?.manifest.category ?? "对象组")}组 ${i + 1}`,
          g.groupId,
        ),
      );
    });
    const boundCatalog = controller.getCurrentCatalog();
    function selectedAsset() {
      return boundCatalog?.manifests.find(
        (a) => a.kind === "object" && refKey(a) === assets.value,
      );
    }
    function showEditAsset() {
      const target = get("general-edit-asset-details");
      target.replaceChildren();
      const a = selectedAsset();
      if (!a) {
        paragraph(target, "此修订的原目录中没有符合本组要求的可用对象素材。");
        return;
      }
      paragraph(
        target,
        `所选素材：${category(a.category)}，${origin(a.origin)}。作者 ${a.provenance.author}；来源 ${a.provenance.source}；许可 ${a.provenance.license.id}。${a.provenance.license.attribution}`,
      );
      a.quality.limitations.forEach((limit) => paragraph(target, limit));
      if (a.origin === "procedural") {
        const label = node("label"),
          check = node("input");
        label.className = "general-check";
        check.id = "general-edit-procedural";
        check.type = "checkbox";
        label.append(
          check,
          node(
            "span",
            "添加或替换时，我确认此组使用所选程序素材的当前内容版本。",
          ),
        );
        target.append(label);
      }
    }
    function refreshEditAssets() {
      const g = m.plan!.groups.find((g) => g.groupId === group.value),
        f = m.intent?.features.find((f) => f.featureId === g?.groupId),
        base = m.assets.find(
          (a) => g && refKey(a.assetRef) === refKey(g.assetRef),
        );
      const restriction =
        m.plan!.review.manualOverrides.find(
          (a) => a.key === `features.${group.value}.sourceRestriction`,
        )?.value ??
        f?.sourceRestriction ??
        "either";
      const previous = assets.value;
      assets.replaceChildren();
      boundCatalog?.manifests
        .filter(
          (a) =>
            a.kind === "object" &&
            a.category === base?.manifest.category &&
            a.quality.status === "accepted" &&
            a.quality.humanReview &&
            a.quality.operations.includes("place") &&
            a.provenance.license.id !== "unknown" &&
            a.provenance.license.evidence &&
            (restriction === "either" || a.origin === restriction),
        )
        .forEach((a, index) =>
          assets.append(
            new Option(
              `${category(a.category)}素材 ${index + 1}（${origin(a.origin)}）`,
              refKey(a),
            ),
          ),
        );
      const preferred =
        Array.from(assets.options).find((o) => o.value === previous)?.value ??
        (g &&
          Array.from(assets.options).find((o) => o.value === refKey(g.assetRef))
            ?.value);
      if (preferred) assets.value = preferred;
      showEditAsset();
    }
    group.onchange = refreshEditAssets;
    assets.onchange = showEditAsset;
    refreshEditAssets();
    const locks = get("general-locks");
    locks.append(node("h4", "本次保护的对象"));
    m.instances.forEach((item, i) => {
      const label = node("label"),
        checkbox = node("input");
      label.className = "general-check";
      checkbox.type = "checkbox";
      checkbox.dataset.lockInstance = item.instanceId;
      checkbox.checked =
        item.locked ||
        m.state?.lockedInstanceIds.includes(item.instanceId) === true;
      label.append(checkbox, node("span", `锁定对象 ${i + 1}`));
      locks.append(label);
    });
    instance.onchange = () => {
      const i = m.instances.find((i) => i.instanceId === instance.value);
      if (i) {
        set("general-edit-x", i.transform.position[0]);
        set("general-edit-z", i.transform.position[2]);
        group.value = i.groupId;
        refreshEditAssets();
        assets.value = refKey(i.assetRef);
        showEditAsset();
      }
    };
    instance.onchange(new Event("change"));
    target.oninput = () => {
      proposal = null;
      get("general-scope").hidden = true;
      if (state().phase === "previewing")
        cancel("编辑参数已修改，旧预览失效。");
      update(state());
    };
    button("general-propose").onclick = () => {
      void run(async (ticket) => {
        const current = state().current;
        if (!current || current.revisionId !== m.revisionId)
          throw Error("当前修订已变化，请重新打开编辑。");
        const kind = get<HTMLSelectElement>("general-edit-kind")
            .value as ScenePatch["operations"][number]["kind"],
          item = m.instances.find((i) => i.instanceId === instance.value),
          chosenAsset = selectedAsset(),
          asset = chosenAsset
            ? { id: chosenAsset.id, contentVersion: chosenAsset.contentVersion }
            : undefined,
          requestedRegion = points(
            get<HTMLTextAreaElement>("general-edit-region").value,
          );
        if (
          ["add", "replace"].includes(kind) &&
          chosenAsset?.origin === "procedural" &&
          !get<HTMLInputElement>("general-edit-procedural").checked
        )
          throw Error("请明确确认所选程序素材。");
        let operation: ScenePatch["operations"][number];
        if (kind === "brush")
          operation = {
            kind,
            center: [number("general-edit-x"), number("general-edit-z")],
            radius: number("general-brush-radius"),
            delta: number("general-brush-delta"),
          };
        else if (kind === "set-count")
          operation = {
            kind,
            groupId: group.value,
            count: number("general-edit-count"),
          };
        else if (kind === "add") {
          if (!asset) throw Error("请选择此修订原目录中的可用素材。");
          operation = {
            kind,
            groupId: group.value,
            assetRef: asset,
            count: number("general-edit-count"),
          };
        } else {
          if (!item) throw Error("请选择对象。");
          if (kind === "remove")
            operation = { kind, instanceId: item.instanceId };
          else if (kind === "replace") {
            if (!asset) throw Error("请选择替换素材。");
            operation = { kind, instanceId: item.instanceId, assetRef: asset };
          } else
            operation = {
              kind: "move",
              instanceId: item.instanceId,
              transform: {
                ...item.transform,
                position: [
                  number("general-edit-x"),
                  item.transform.position[1],
                  number("general-edit-z"),
                ],
              },
            };
        }
        const targets = "instanceId" in operation ? [operation.instanceId] : [],
          locked = Array.from(
            host.querySelectorAll<HTMLInputElement>(
              "[data-lock-instance]:checked",
            ),
          ).map((i) => i.dataset.lockInstance!);
        const patch = parsePatch({
          documentType: "general-scene-patch",
          schemaVersion: 1,
          patchId: crypto.randomUUID(),
          baseRevisionId: m.revisionId,
          raw:
            get<HTMLInputElement>("general-edit-description").value ||
            `手工${get<HTMLSelectElement>("general-edit-kind").selectedOptions[0].textContent}`,
          requestedRegion,
          effectiveRegion: requestedRegion,
          targetInstanceIds: targets,
          lockedInstanceIds: locked,
          affectedInstanceIds: targets,
          affectedTileIds: [],
          operations: [operation],
          review: {
            scopeAccepted: false,
            planDigest: "0".repeat(64),
            catalogDigest: m.plan!.catalogDigest,
            assetBindings: [],
          },
        });
        const p = take(await controller.proposePatch(patch));
        if (!live(ticket)) return;
        proposal = p;
        renderScope(p, m);
      });
    };
  }
  function renderScope(p: PatchProposal, m: GeneralSceneMetadata) {
    const target = get("general-scope");
    target.hidden = false;
    target.replaceChildren(node("h3", "确认本次修改范围"));
    paragraph(target, `请求区域 R：${boundsText(p.requestedRegion)}`);
    paragraph(target, `实际影响区域 H：${boundsText(p.effectiveRegion)}`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "-6 -6 12 12");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      "请求区域 R 与影响区域 H 的俯视图，向上为北",
    );
    svg.classList.add("general-scope-map");
    for (const [polygon, kind] of [
      [p.effectiveRegion, "H"],
      [p.requestedRegion, "R"],
    ] as const) {
      const shape = document.createElementNS(svg.namespaceURI, "polygon");
      shape.setAttribute(
        "points",
        polygon.map((v) => `${v[0]},${-v[1]}`).join(" "),
      );
      shape.setAttribute("class", `general-scope-${kind}`);
      svg.append(shape);
    }
    target.append(
      svg,
      node("p", "实线绿色为请求区域 R；浅色外框为实际影响区域 H。"),
    );
    if (!p.changedInstanceIds.length)
      paragraph(target, "变化对象：无；地形范围见 H。");
    p.changedInstanceIds.forEach((id) => {
      const index = m.instances.findIndex((i) => i.instanceId === id),
        item =
          p.instances.find((i) => i.instanceId === id) ?? m.instances[index],
        a = m.assets.find(
          (a) => item && refKey(a.assetRef) === refKey(item.assetRef),
        );
      paragraph(
        target,
        `变化对象：${index < 0 ? "新增" : `原对象 ${index + 1}`} ${category(a?.manifest.category ?? "对象")}`,
      );
    });
    paragraph(
      target,
      `影响地形块：${p.changedTileIds.length}。H 外实例与未影响地形必须保持不变；锁定对象不自动解锁。`,
    );
    p.patch.operations.forEach((operation) => {
      if (operation.kind !== "add" && operation.kind !== "replace") return;
      const assetRef = operation.assetRef;
      const a = controller
        .getCurrentCatalog()
        ?.manifests.find((a) => refKey(a) === refKey(assetRef));
      if (a)
        paragraph(
          target,
          `本次${operation.kind === "replace" ? "替换" : "添加"}素材：${category(a.category)}，${origin(a.origin)}；${a.provenance.author}；许可 ${a.provenance.license.id}。`,
        );
    });
    const label = node("label"),
      check = node("input");
    label.className = "general-check";
    check.id = "general-scope-accept";
    check.type = "checkbox";
    label.append(
      check,
      node("span", "我确认上述 R、H 与变化对象，再生成局部预览。"),
    );
    target.append(label);
    const preview = node("button", "生成局部预览");
    preview.id = "general-patch-preview";
    preview.disabled = true;
    target.append(preview);
    check.onchange = () => {
      if (!check.checked && state().phase === "previewing") {
        cancel("局部修改范围确认已撤回，预览已取消。");
        return;
      }
      update(state());
    };
    preview.onclick = () => {
      void run(async (ticket) => {
        if (!proposal || !check.checked) throw Error("请先确认实际影响范围。");
        const accepted = parsePatch({
            ...proposal.patch,
            review: { ...proposal.patch.review, scopeAccepted: true },
          }),
          out = take(await controller.previewPatch(accepted));
        if (!live(ticket)) return;
        metadata = projection(out.compiled.snapshot, "editable");
        renderMetadata();
      });
    };
    get("general-evidence").textContent = JSON.stringify(
      {
        patch: p.patch,
        changedInstanceIds: p.changedInstanceIds,
        changedTileIds: p.changedTileIds,
      },
      null,
      2,
    );
  }
  const unsubscribeMode = ports.subscribeMode((mode) => {
    inGeneral = mode === "general";
    if (inGeneral) {
      syncCurrent(state());
      return;
    }
    epoch++;
    pending = false;
    catalogAbort?.abort();
    catalogAbort = null;
    clearReview();
    request = null;
    intent = null;
    draft = null;
    query = null;
    catalog = null;
    manualSetup = false;
    showingImport = false;
    metadata =
      currentMetadata?.revisionId === state().current?.revisionId
        ? currentMetadata
        : null;
    get("general-form").hidden = true;
    get("general-global").hidden = true;
    get<HTMLInputElement>("general-global-accept").checked = false;
    get("general-confirmations").replaceChildren();
    get("general-summary").replaceChildren();
    button("general-review").hidden = true;
    renderMetadata();
    update(state());
  });
  update(state());
  return {
    async dispose() {
      if (dead) return;
      dead = true;
      epoch++;
      catalogAbort?.abort();
      controller.cancel();
      unsubscribe();
      unsubscribeMode();
      resolved = null;
      proposal = null;
      metadata = null;
      currentMetadata = null;
      catalog = null;
      request = null;
      draft = null;
      intent = null;
      original = null;

      host.replaceChildren();
      await controller.whenSettled();
    },
  };
}
