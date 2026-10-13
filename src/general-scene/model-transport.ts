import { record } from "../data-validation.ts";
import { LLAMA_SMALL_MODEL, type ModelReply } from "../planner/service.ts";
import { canonicalJson } from "./canonical.ts";
import { GENERAL_LIMITS as L } from "./core.ts";
export type GeneralModelRequest = {
  stage: "intent" | "plan" | "repair";
  system: string;
  payload: unknown;
  schema: unknown;
};
export type GeneralTransport = ((
  request: GeneralModelRequest,
  signal: AbortSignal,
) => Promise<ModelReply>) & { readonly provenance?: "real" | "constructed" };
export type TokenCounter = (
  serializedInput: string,
  signal: AbortSignal,
) => Promise<number>;
const BASE = "http://127.0.0.1:8080/v1/chat/completions";
export function buildGeneralEnvelope(request: GeneralModelRequest) {
  return {
    model: LLAMA_SMALL_MODEL,
    stream: false,
    temperature: 0,
    max_tokens: L.maxModelOutputTokens,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: canonicalJson(request.payload) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "general_scene", schema: request.schema },
    },
  };
}
/** Reply-bearing failures preserve real returned identity/text without treating them as valid output. */
export class GeneralTransportError extends Error {
  constructor(
    message: string,
    readonly reply: { raw: string | null; model: string | null } | null = null,
  ) {
    super(message);
  }
}
export async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason ?? Error("操作已取消"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    const value = await Promise.race([work, aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new GeneralTransportError(`本地服务 HTTP ${response.status}`);
  }
  if (!response.body) throw new GeneralTransportError("本地服务没有正文");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new GeneralTransportError("本地响应超过64KiB");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function createGeneralTransport(
  fetcher: typeof fetch = fetch,
): GeneralTransport {
  const transport: GeneralTransport = async (request, signal) => {
    signal.throwIfAborted();
    const data = await boundedJson(
      await abortable(
        fetcher(BASE, {
          method: "POST",
          redirect: "error",
          signal,
          headers: { "content-type": "application/json" },
          body: canonicalJson(buildGeneralEnvelope(request)),
        }),
        signal,
      ),
      signal,
    );
    const choice = data?.choices?.[0],
      raw =
        typeof choice?.message?.content === "string"
          ? choice.message.content
          : null,
      model = typeof data?.model === "string" ? data.model : null;
    const fail = (message: string): never => {
      throw new GeneralTransportError(message, { raw, model });
    };
    if (
      !Array.isArray(data?.choices) ||
      data.choices.length !== 1 ||
      choice?.message?.role !== "assistant" ||
      raw === null ||
      !model ||
      typeof choice.finish_reason !== "string" ||
      (choice.message.tool_calls !== undefined &&
        (!Array.isArray(choice.message.tool_calls) ||
          choice.message.tool_calls.length !== 0)) ||
      choice.message.function_call != null
    )
      fail("本地模型响应协议无效");
    if (model !== LLAMA_SMALL_MODEL)
      fail("返回模型身份与请求不符（alias不是权重摘要证明）");
    if (choice.finish_reason !== "stop")
      fail(`模型未正常结束: ${choice.finish_reason}`);
    return {
      raw: raw!,
      model: model!,
      done: true,
      doneReason: choice.finish_reason,
    };
  };
  Object.defineProperty(transport, "provenance", {
    value: fetcher === fetch ? "real" : "constructed",
  });
  return transport;
}
export function createTokenCounter(
  fetcher: typeof fetch = fetch,
): TokenCounter {
  return async (serializedInput, signal) => {
    signal.throwIfAborted();
    let envelope: any;
    try {
      envelope = JSON.parse(serializedInput);
      record(envelope, [
        "model",
        "stream",
        "temperature",
        "max_tokens",
        "messages",
        "response_format",
      ]);
      if (
        envelope.model !== LLAMA_SMALL_MODEL ||
        envelope.stream !== false ||
        envelope.temperature !== 0 ||
        envelope.max_tokens !== 1024 ||
        !Array.isArray(envelope.messages) ||
        envelope.messages.length !== 2
      )
        throw Error();
      for (const [i, m] of envelope.messages.entries()) {
        record(m, ["role", "content"]);
        if (
          m.role !== (i === 0 ? "system" : "user") ||
          typeof m.content !== "string"
        )
          throw Error();
      }
      record(envelope.response_format, ["type", "json_schema"]);
      record(envelope.response_format.json_schema, ["name", "schema"]);
      if (
        envelope.response_format.type !== "json_schema" ||
        envelope.response_format.json_schema.name !== "general_scene"
      )
        throw Error();
      canonicalJson(envelope);
    } catch {
      throw new GeneralTransportError("Invalid internal generation envelope");
    }
    const data = await boundedJson(
      await abortable(
        fetcher(BASE + "/input_tokens", {
          method: "POST",
          redirect: "error",
          signal,
          headers: { "content-type": "application/json" },
          body: canonicalJson(envelope),
        }),
        signal,
      ),
      signal,
    );
    if (
      data?.object !== "response.input_tokens" ||
      !Number.isSafeInteger(data.input_tokens) ||
      data.input_tokens < 0
    )
      throw new GeneralTransportError("实际token计数不可用，请使用手工模式");
    return data.input_tokens;
  };
}
