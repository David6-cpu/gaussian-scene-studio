import { record, finite, oneOf } from "../data-validation";
import { text, freeze } from "../assets/catalog/metadata";
import { LLAMA_SMALL_MODEL, parsePrompt } from "../planner/service";
import { assertAssetPrompt } from "../selection/contract";
import { requestOnce, equal, type AssetTransport } from "../selection/service";
import {
  parseReviewRequestV2,
  reviewRequestSchemaV2,
  type ReviewRequestV2,
} from "./requirements";
import { assertWaterRequirement, waterRequirement } from "./water";
export interface RequirementEvidenceV2 {
  schemaVersion: 2;
  prompt: string;
  request: ReviewRequestV2;
  raw: string;
  model: typeof LLAMA_SMALL_MODEL;
  elapsedMs: number;
}
export function parseRequirementEvidenceV2(
  value: unknown,
): RequirementEvidenceV2 {
  const e = record(value, [
    "schemaVersion",
    "prompt",
    "request",
    "raw",
    "model",
    "elapsedMs",
  ]);
  oneOf(e.schemaVersion, [2]);
  const prompt = parsePrompt(e.prompt),
    request = parseReviewRequestV2(e.request),
    raw = text(e.raw, 65536);
  assertAssetPrompt(prompt);
  if (new TextEncoder().encode(raw).byteLength > 65536)
    throw Error("模型原文超过64KiB");
  if (!equal(request, parseReviewRequestV2(JSON.parse(raw))))
    throw Error("需求与模型原文不一致");
  return freeze({
    schemaVersion: 2,
    prompt,
    request,
    raw,
    model: oneOf(e.model, [LLAMA_SMALL_MODEL]),
    elapsedMs: finite(e.elapsedMs, 0, 3600000),
  });
}
export async function interpretReviewRequestV2(
  prompt: string,
  transport: AssetTransport,
  signal: AbortSignal,
): Promise<RequirementEvidenceV2> {
  prompt = parsePrompt(prompt);
  assertAssetPrompt(prompt);
  waterRequirement(prompt); // Clarify before calling the model, without filling its answer.
  if (
    /来源[^，,。；;\n]{0,8}(?:没定|未定|没确定|未确定|不确定|没想好)|(?:不是不要|不是不用|并非不要|并非不用|不是不接受|并非不接受)\s*(?:实拍|扫描|程序|合成)/.test(
      prompt,
    )
  )
    throw Error("请澄清素材来源：不会替你选定不确定或双重否定的来源。");
  const reply = await requestOnce(
    "requirements",
    { description: prompt },
    reviewRequestSchemaV2,
    transport,
    signal,
  );
  const evidence = parseRequirementEvidenceV2({
    schemaVersion: 2,
    prompt,
    request: JSON.parse(reply.raw),
    ...reply,
  });
  assertWaterRequirement(prompt, evidence.request.water);
  return evidence;
}
