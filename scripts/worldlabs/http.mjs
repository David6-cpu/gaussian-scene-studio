import { API_ROOT } from "./request.mjs";
export const JSON_LIMIT = 1024 ** 2;
export class HttpResponseError extends Error {
  constructor(status, redirected = false) {
    const safeStatus =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null;
    super(
      `http-rejected (HTTP ${safeStatus ?? "unknown"}${redirected ? ", redirect refused" : ""})`,
    );
    this.name = "HttpResponseError";
    this.httpStatus = safeStatus;
    this.redirected = redirected === true;
  }
}
export function assetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("asset-url-rejected");
  }
  // Conservative local policy, not a claim that the provider guarantees these hosts.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(
      url.hostname === "worldlabs.ai" || url.hostname.endsWith(".worldlabs.ai")
    ) ||
    !url.pathname.toLowerCase().endsWith(".spz")
  )
    throw Error("asset-url-rejected");
  return url.href;
}
export async function fetchBytes(
  url,
  init,
  limit,
  fetchImpl = fetch,
  timeoutMs = 60000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (response.redirected || !response.ok)
      throw new HttpResponseError(response.status, response.redirected);
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > limit)
    )
      throw Error("response-size-rejected");
    if (!response.body) throw Error("response-empty");
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("response-size-rejected");
      chunks.push(value);
    }
    // Native fetch exposes a decoded body but preserves the wire Content-Length.
    // Always bound the decoded bytes; compare lengths only for identity encoding.
    const encoding = response.headers
      .get("content-encoding")
      ?.trim()
      .toLowerCase();
    if (
      (!encoding || encoding === "identity") &&
      declared !== null &&
      size !== Number(declared)
    )
      throw Error("response-length-mismatch");
    return Buffer.concat(chunks, size);
  } catch (error) {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    if (error instanceof HttpResponseError) throw error;
    // Never surface fetch/provider text: errors may include URLs or request headers.
    const safe = new Set([
      "http-rejected",
      "response-size-rejected",
      "response-empty",
      "response-length-mismatch",
    ]);
    throw Error(safe.has(error.message) ? error.message : "network-or-timeout");
  } finally {
    clearTimeout(timer);
  }
}
export async function apiJson(path, { key, fetchImpl, body }) {
  if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key))
    throw Error("credential-unavailable");
  const bytes = await fetchBytes(
    API_ROOT + path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "WLT-Api-Key": key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    },
    JSON_LIMIT,
    fetchImpl,
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw Error("invalid-provider-json");
  }
}
