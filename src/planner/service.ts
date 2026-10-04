import { parseProposal, proposalFromRecipe, type Proposal } from "./contract";
import { defaultRecipe } from "../recipe";
import { terrainIntent, assertTerrainIntent } from "./terrain-intent";
import { assertWetlandScope } from "./scope";
export const MODEL = "qwen2.5:7b-instruct-q4_K_M";
export const LLAMA_MODEL = "qwen2.5-7b-instruct-q4_k_m";
export const LLAMA_SMALL_MODEL = "qwen2.5-3b-instruct-q4_k_m";
export type ModelId = typeof MODEL | typeof LLAMA_MODEL | typeof LLAMA_SMALL_MODEL;
export type Backend = "ollama" | "llama.cpp";
export function parseBackend(value: unknown): Backend {
  if (value !== "ollama" && value !== "llama.cpp") throw Error("未知本地后端");
  return value;
}
export const modelForBackend = (backend: Backend) =>
  backend === "ollama" ? MODEL : LLAMA_MODEL;
export function parseModel(backend: Backend, value: unknown): ModelId {
  if (value === modelForBackend(backend) ||
      (backend === "llama.cpp" && value === LLAMA_SMALL_MODEL)) return value as ModelId;
  throw Error("模型不在所选后端的允许列表中");
}
export type ModelReply = {
  raw: string;
  model: string;
  done: boolean;
  doneReason: string;
};
export type Transport = (
  request: { prompt: string; repair?: { raw: string; error: string } },
  signal: AbortSignal,
) => Promise<ModelReply>;
export type Attempt = {
  raw: string;
  model: string | null;
  error: string | null;
  elapsedMs: number;
};
export type PlanDraft = {
  prompt: string;
  proposal: Proposal;
  source: Backend | "default" | "demo";
  backend: Backend | null;
  model: ModelId | null;
  repaired: boolean;
  attempts: Attempt[];
  templateVersion: "parameters-v1" | "parameters-v2";
  elapsedMs: number;
  reason: string | null;
};
export function parsePrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000)
    throw Error("请输入 1–1000 字的场景描述");
  return value.trim();
}
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2048,
  );
}
export function demoPlan(): PlanDraft {
  return {
    prompt: "离线演示：6×6米湿地，少量石头与植株",
    proposal: {
      ...proposalFromRecipe(defaultRecipe),
      width: 6,
      depth: 6,
      seed: 42,
      requested: { rock: 4, reed: 6 },
    },
    source: "demo",
    backend: null,
    model: null,
    repaired: false,
    attempts: [],
    templateVersion: "parameters-v1",
    elapsedMs: 0,
    reason: "固定示例配方；没有调用语言模型。",
  };
}
async function timedCall(
  transport: Transport,
  request: Parameters<Transport>[0],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let stop: () => void;
  const limit = new Promise<never>((_, reject) => {
    stop = () => {
      controller.abort();
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("本地模型请求超过60秒"));
    }, 60000);
  });
  try {
    return await Promise.race([transport(request, controller.signal), limit]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", stop!);
  }
}
export async function planScene(
  prompt: string,
  transport: Transport,
  signal: AbortSignal,
  backend: Backend = "ollama",
  selectedModel: unknown = modelForBackend(backend),
): Promise<PlanDraft> {
  backend = parseBackend(backend);
  const model = parseModel(backend, selectedModel);
  prompt = parsePrompt(prompt);
  signal.throwIfAborted();
  assertWetlandScope(prompt);
  const intent = terrainIntent(prompt);
  const start = performance.now(),
    attempts: Attempt[] = [];
  let repair: Parameters<Transport>[0]["repair"];
  for (let i = 0; i < 2; i++) {
    const began = performance.now();
    let reply: ModelReply;
    try {
      reply = await timedCall(transport, { prompt, repair }, signal);
    } catch (error) {
      signal.throwIfAborted();
      attempts.push({
        raw: "",
        model: null,
        error: errorText(error),
        elapsedMs: performance.now() - began,
      });
      break; // Transport failures are not model-format repair opportunities.
    }
    signal.throwIfAborted();
    const attempt: Attempt = {
      raw: reply.raw.slice(0, 65536),
      model: reply.model.slice(0, 200),
      error: null,
      elapsedMs: performance.now() - began,
    };
    attempts.push(attempt);
    try {
      if (new TextEncoder().encode(reply.raw).byteLength > 65536)
        throw Error("模型输出超过64KiB");
      if (!reply.done || reply.doneReason !== "stop")
        throw Error("模型输出未完整结束或被截断");
      if (reply.model !== model)
        throw Error("服务报告的模型标识与预期不符");
      const proposal = parseProposal(JSON.parse(reply.raw));
      assertTerrainIntent(intent, proposal);
      return {
        prompt,
        proposal,
        source: backend,
        backend,
        model,
        repaired: i === 1,
        attempts,
        templateVersion: "parameters-v2",
        elapsedMs: performance.now() - start,
        reason: null,
      };
    } catch (error) {
      attempt.error = errorText(error);
      repair = { raw: attempt.raw, error: attempt.error };
    }
  }
  signal.throwIfAborted();
  return {
    prompt,
    proposal: proposalFromRecipe(defaultRecipe),
    source: "default",
    backend,
    model,
    repaired: false,
    attempts,
    templateVersion: "parameters-v2",
    elapsedMs: performance.now() - start,
    reason: `未得到可用的模型配方，使用固定默认值（未解释输入）：${attempts.at(-1)?.error}`,
  };
}
