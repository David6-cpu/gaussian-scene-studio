import { record, finite } from "../data-validation";
import { text } from "../assets/catalog/metadata";
import { BUILTIN_CONTEXT, type CatalogContext } from "../assets/catalog/context";
import { waterIntent, assertWaterIntent } from "../planner/water-intent";
import {
  LLAMA_SMALL_MODEL,
  parsePrompt,
  type ModelReply,
} from "../planner/service";
import {
  assertAssetPrompt,
  parseAssetRequest,
  assetRequestSchema,
  candidateSnapshot,
  checkChoices,
  type AssetRequest,
  type Choice,
  type CandidateSlot,
} from "./contract";
export type AssetStage = "requirements" | "choose";
export type AssetTransport = (
  stage: AssetStage,
  payload: unknown,
  schema: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<ModelReply>;
export interface RequirementEvidence {
  prompt: string;
  request: AssetRequest;
  model: typeof LLAMA_SMALL_MODEL;
  raw: string;
  elapsedMs: number;
}
export interface ChoiceEvidence {
  request: AssetRequest;
  catalogVersion: string;
  candidates: CandidateSlot[];
  choices: Choice[];
  model: typeof LLAMA_SMALL_MODEL;
  raw: string;
  elapsedMs: number;
}
export const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function rawText(value: unknown): string {
  const s = text(value, 65536);
  if (new TextEncoder().encode(s).byteLength > 65536)
    throw Error("模型原文超过64KiB");
  return s;
}
function model(value: unknown): typeof LLAMA_SMALL_MODEL {
  if (value !== LLAMA_SMALL_MODEL)
    throw Error("模型身份不符，必须使用已配置3B");
  return LLAMA_SMALL_MODEL;
}
export function parseRequirementEvidence(value: unknown): RequirementEvidence {
  const e = record(value, ["prompt", "request", "model", "raw", "elapsedMs"]),
    prompt = parsePrompt(e.prompt),
    raw = rawText(e.raw),
    request = parseAssetRequest(e.request);
  assertAssetPrompt(prompt);
  if (!equal(request, parseAssetRequest(JSON.parse(raw))))
    throw Error("需求与模型原文不一致");
  return {
    prompt,
    request,
    model: model(e.model),
    raw,
    elapsedMs: finite(e.elapsedMs, 0, 3600000),
  };
}
export function parseChoiceEvidence(value: unknown, context:CatalogContext=BUILTIN_CONTEXT): ChoiceEvidence {
  const e = record(value, [
    "request",
    "catalogVersion",
    "candidates",
    "choices",
    "model",
    "raw",
    "elapsedMs",
  ]);
  const request = parseAssetRequest(e.request),
    raw = rawText(e.raw),
    choices = checkChoices(request, JSON.parse(raw),context),
    candidates = candidateSnapshot(request,context);
  if (
    e.catalogVersion !== context.catalogVersion ||
    !equal(candidates, e.candidates) ||
    !equal(choices, e.choices)
  )
    throw Error("候选版本、快照或选材结果与原文不一致");
  return {
    request,
    catalogVersion: context.catalogVersion,
    candidates,
    choices,
    model: model(e.model),
    raw,
    elapsedMs: finite(e.elapsedMs, 0, 3600000),
  };
}
export async function requestOnce(
  stage: AssetStage,
  payload: unknown,
  schema: Record<string, unknown>,
  transport: AssetTransport,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const start = performance.now(),
    controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(Error("本地3B请求超过60秒")),
    60000,
  );
  let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(controller.signal.reason ?? Error("已取消"));
    controller.signal.addEventListener("abort", stop, { once: true });
  });
  try {
    const reply = await Promise.race([
      transport(stage, payload, schema, controller.signal),
      cancelled,
    ]);
    controller.signal.throwIfAborted();
    model(reply.model);
    if (!reply.done || reply.doneReason !== "stop")
      throw Error("模型输出未完整结束，不接受截断结果");
    return {
      raw: rawText(reply.raw),
      model: LLAMA_SMALL_MODEL,
      elapsedMs: performance.now() - start,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
  }
}
export async function interpretRequest(
  value: string,
  transport: AssetTransport,
  signal: AbortSignal,
): Promise<RequirementEvidence> {
  const prompt = parsePrompt(value);
  assertAssetPrompt(prompt);
  const water = waterIntent(prompt);
  if (water.mode === "clarify") throw Error(water.message);
  // A live-input clarification gate only: never infer an affirmative source
  // from these uncertain phrases, and never reclassify archived evidence.
  if (
    /来源[^，,。；;\n]{0,8}(?:没定|未定|没确定|未确定|不确定|没想好)|(?:不是不要|不是不用|并非不要|并非不用|不是不接受|并非不接受)\s*(?:实拍|扫描|程序|合成)/.test(
      prompt,
    )
  )
    throw Error(
      "请澄清素材来源：当前表述含来源未定或双重否定。请明确需要实拍、程序或两者均可；不会替你选定来源。",
    );
  const reply = await requestOnce(
    "requirements",
    { description: prompt },
    assetRequestSchema,
    transport,
    signal,
  );
  const evidence = parseRequirementEvidence({
    prompt,
    request: parseAssetRequest(JSON.parse(reply.raw)),
    ...reply,
  });
  assertWaterIntent(water, evidence.request.waterLevel);
  return evidence;
}
export async function selectAssets(
  input: AssetRequest,
  transport: AssetTransport,
  signal: AbortSignal,
  context: CatalogContext = BUILTIN_CONTEXT,
): Promise<ChoiceEvidence> {
  const request = parseAssetRequest(input),
    candidates = candidateSnapshot(request,context);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["choices"],
    properties: {
      choices: {
        type: "array",
        minItems: candidates.length,
        maxItems: candidates.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "assetId"],
          properties: {
            key: { type: "string", enum: candidates.map((c) => c.key) },
            assetId: {
              type: "string",
              enum: candidates.flatMap((c) => c.assetIds),
            },
          },
        },
      },
    },
  };
  const payload = {
    request,
    candidates: candidates.map((c) => ({
      ...c,
      assets: c.assetIds.map((id) => {
        const a = context.entries.find((a) => a.id === id)!;
        return {
          id: a.id,
          title: a.title,
          category: a.category,
          origin: a.origin,
          points: a.gaussian.full,
          limitations: a.quality.limitations,
        };
      }),
    })),
  };
  const reply = await requestOnce("choose", payload, schema, transport, signal);
  return parseChoiceEvidence({
    request,
    catalogVersion: context.catalogVersion,
    candidates,
    choices: checkChoices(request, JSON.parse(reply.raw), context),
    ...reply,
  }, context);
}
