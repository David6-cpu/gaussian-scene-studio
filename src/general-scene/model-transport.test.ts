import { expect, test } from "vitest";
import {
  buildGeneralEnvelope,
  createGeneralTransport,
  createTokenCounter,
} from "./model-transport.ts";
import { LLAMA_SMALL_MODEL } from "../planner/service.ts";
const req = {
  stage: "intent" as const,
  system: "Preserve original requirements",
  payload: { prompt: " 不要水 " },
  schema: { type: "object" },
};
const good = () => ({
  model: LLAMA_SMALL_MODEL,
  choices: [
    {
      message: { role: "assistant", content: '{"a":1}' },
      finish_reason: "stop",
    },
  ],
});
test("counter and generation send equal exact envelopes to fixed loopback endpoints", async () => {
  const bodies: any[] = [],
    urls: string[] = [];
  const controller = new AbortController();
  const fetcher = async (url: any, init: any) => {
    urls.push(String(url));
    bodies.push(JSON.parse(init.body));
    expect(init.redirect).toBe("error");
    expect(init.signal).toBe(controller.signal);
    return Response.json(
      String(url).endsWith("input_tokens")
        ? { object: "response.input_tokens", input_tokens: 2816 }
        : good(),
    );
  };
  expect(
    await createTokenCounter(fetcher)(
      JSON.stringify(buildGeneralEnvelope(req)),
      controller.signal,
    ),
  ).toBe(2816);
  expect(
    await createGeneralTransport(fetcher)(req, controller.signal),
  ).toMatchObject({
    raw: '{"a":1}',
    model: LLAMA_SMALL_MODEL,
    doneReason: "stop",
  });
  expect(urls).toEqual([
    "http://127.0.0.1:8080/v1/chat/completions/input_tokens",
    "http://127.0.0.1:8080/v1/chat/completions",
  ]);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({
    model: LLAMA_SMALL_MODEL,
    max_tokens: 1024,
    stream: false,
    temperature: 0,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: '{"prompt":" 不要水 "}' },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { schema: req.schema },
    },
  });
});
test.each([NaN, -1, 1.5, "1", null])(
  "invalid token count %s is not a character fallback",
  async (count) => {
    await expect(
      createTokenCounter(async () =>
        Response.json({ object: "response.input_tokens", input_tokens: count }),
      )(
        JSON.stringify(buildGeneralEnvelope(req)),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
test.each(["identity", "truncated", "tools", "choices", "role"])(
  "rejects %s and preserves available reply evidence",
  async (kind) => {
    const v: any = good();
    if (kind === "identity") v.model = "wrong-model";
    if (kind === "truncated") v.choices[0].finish_reason = "length";
    if (kind === "tools") v.choices[0].message.tool_calls = [{}];
    if (kind === "choices") v.choices.push(v.choices[0]);
    if (kind === "role") v.choices[0].message.role = "user";
    await expect(
      createGeneralTransport(async () => Response.json(v))(
        req,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    try {
      await createGeneralTransport(async () => Response.json(v))(
        req,
        new AbortController().signal,
      );
    } catch (e: any) {
      expect(e.reply?.raw).toBe('{"a":1}');
      expect(e.reply?.model).toBe(v.model);
    }
  },
);
test("64KiB limit counts streamed UTF-8 bytes and rejects malformed UTF-8", async () => {
  for (const bytes of [
    new TextEncoder().encode(
      JSON.stringify({ ...good(), padding: "汉".repeat(23000) }),
    ),
    new Uint8Array([0xff]),
  ]) {
    await expect(
      createGeneralTransport(async () => new Response(bytes))(
        req,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
});
test("counter refuses a supplied envelope with altered model or added generation controls", async () => {
  const transport = createTokenCounter(async () => {
    throw Error("must not fetch");
  });
  const envelope = buildGeneralEnvelope(req);
  envelope.model = "remote";
  await expect(
    transport(JSON.stringify(envelope), new AbortController().signal),
  ).rejects.toThrow(/envelope/i);
});
