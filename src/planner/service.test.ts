import { describe, expect, it, vi } from "vitest";
import { defaultRecipe } from "../recipe";
import { proposalFromRecipe } from "./contract";
import {
  planScene,
  demoPlan,
  MODEL,
  LLAMA_MODEL,
  type Transport,
} from "./service";
const raw = JSON.stringify(proposalFromRecipe(defaultRecipe));
const reply = (text = raw) => ({
  raw: text,
  model: MODEL,
  done: true,
  doneReason: "stop",
});
describe("bounded planning orchestration", () => {
  it("records the explicit llama.cpp route for success and unavailable fallback", async () => {
    const signal = new AbortController().signal;
    const result = await planScene(
      "湿地",
      async () => ({ ...reply(), model: LLAMA_MODEL }),
      signal,
      "llama.cpp",
    );
    expect(result).toMatchObject({ source: "llama.cpp", backend: "llama.cpp" });
    expect(result.attempts[0].model).toBe(LLAMA_MODEL);
    const unavailable = await planScene(
      "湿地",
      async () => {
        throw Error("offline");
      },
      signal,
      "llama.cpp",
    );
    expect(unavailable).toMatchObject({
      source: "default",
      backend: "llama.cpp",
    });
    expect(unavailable.attempts).toHaveLength(1);
    expect(unavailable.attempts[0].model).toBeNull();
  });
  it("does not accept an Ollama reply as llama.cpp and preserves reported identity", async () => {
    const result = await planScene(
      "湿地",
      async () => reply(),
      new AbortController().signal,
      "llama.cpp",
    );
    expect(result).toMatchObject({ source: "default", backend: "llama.cpp" });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.model === MODEL && a.error)).toBe(
      true,
    );
  });
  it("records a genuine valid first reply", async () => {
    const d = await planScene(
      "一片有十块石头的湿地",
      async () => reply(),
      new AbortController().signal,
    );
    expect(d.source).toBe("ollama");
    expect(d.repaired).toBe(false);
    expect(d.attempts).toHaveLength(1);
    expect(d.attempts[0].raw).toBe(raw);
  });
  it("repairs invalid output once with its error, retaining both replies", async () => {
    let calls = 0;
    const transport: Transport = async (request) => {
      calls++;
      if (calls === 1) return reply('{"validation":"passed"}');
      expect(request.repair?.error).toBeTruthy();
      expect(request.repair?.raw).toContain("validation");
      return reply();
    };
    const d = await planScene("湿地", transport, new AbortController().signal);
    expect(d.source).toBe("ollama");
    expect(d.repaired).toBe(true);
    expect(d.attempts).toHaveLength(2);
    expect(d.attempts[0].error).toBeTruthy();
  });
  it("defaults after exactly two illegal outputs; no silent clipping", async () => {
    let calls = 0;
    const d = await planScene(
      "100米湿地",
      async () => {
        calls++;
        return reply(raw.replace('"width":10', '"width":100'));
      },
      new AbortController().signal,
    );
    expect(calls).toBe(2);
    expect(d.source).toBe("default");
    expect(d.proposal.width).toBe(10);
    expect(d.reason).toBeTruthy();
  });
  it("transport failure defaults immediately, without pretending it interpreted the prompt", async () => {
    let calls = 0;
    const d = await planScene(
      "很多芦苇",
      async () => {
        calls++;
        throw Error("ECONNREFUSED");
      },
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(d.source).toBe("default");
    expect(d.reason).toContain("ECONNREFUSED");
    expect(d.attempts[0].model).toBeNull();
  });
  it.each([
    { done: false },
    { doneReason: "length" },
    { model: "another-model" },
    { raw: "x".repeat(65537) },
  ])("rejects incomplete/mismatched model output %j", async (change) => {
    const d = await planScene(
      "湿地",
      async () => ({ ...reply(), ...change }),
      new AbortController().signal,
    );
    expect(d.source).toBe("default");
    expect(d.attempts).toHaveLength(2);
  });
  it("cancellation never becomes fallback or a late success", async () => {
    const c = new AbortController();
    const pending = planScene(
      "湿地",
      async () => {
        c.abort();
        return reply();
      },
      c.signal,
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("bounds each unresponsive attempt to sixty seconds", async () => {
    vi.useFakeTimers();
    try {
      const pending = planScene(
        "湿地",
        async () => new Promise(() => {}),
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(60000);
      const d = await pending;
      expect(d.source).toBe("default");
      expect(d.reason).toContain("60");
      expect(d.attempts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("offline example is explicitly demo, with no model attempts", () => {
    expect(demoPlan().source).toBe("demo");
    expect(demoPlan().attempts).toEqual([]);
  });
  it.each(["", " ", "a".repeat(1001)])(
    "rejects invalid input before transport",
    async (prompt) => {
      await expect(
        planScene(prompt, async () => reply(), new AbortController().signal),
      ).rejects.toThrow();
    },
  );
});
