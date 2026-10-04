import { describe, expect, it } from "vitest";
import { defaultRecipe } from "../recipe";
import { proposalFromRecipe } from "./contract";
import { planScene, LLAMA_MODEL, MODEL, demoPlan } from "./service";
import { confirmPlan, exportPlan, importPlan, parseDraft } from "./history";
import { createLlamaTransport, readLlamaStatus } from "./server";

const small = "qwen2.5-3b-instruct-q4_k_m";
const raw = JSON.stringify(proposalFromRecipe(defaultRecipe));
const reply = (model: string, value = raw) => ({ raw: value, model, done: true, doneReason: "stop" });
const signal = () => new AbortController().signal;

describe("explicit model selection (controlled replies, not inference)", () => {
  it("accepts 3B only when explicitly selected and records its target on failures", async () => {
    const draft = await planScene("湿地", async () => reply(small), signal(), "llama.cpp", small);
    expect(draft).toMatchObject({ source: "llama.cpp", backend: "llama.cpp", model: small, repaired: false });
    expect((await planScene("湿地", async () => reply(small), signal(), "llama.cpp")).source).toBe("default");
    const failed = await planScene("湿地", async () => { throw Error("offline"); }, signal(), "llama.cpp", small);
    expect(failed).toMatchObject({ source: "default", model: small, attempts: [{ model: null }] });
  });
  it("retains invalid first output and labels the one repair; mismatched 7B never becomes 3B success", async () => {
    let n = 0;
    const repaired = await planScene("湿地", async () => reply(small, n++ ? raw : "{}"), signal(), "llama.cpp", small);
    expect(repaired).toMatchObject({ source: "llama.cpp", model: small, repaired: true });
    expect(repaired.attempts[0].error).toBeTruthy();
    const mismatch = await planScene("湿地", async () => reply(LLAMA_MODEL), signal(), "llama.cpp", small);
    expect(mismatch.source).toBe("default");
    expect(mismatch.attempts.every(a => a.model === LLAMA_MODEL && a.error)).toBe(true);
  });
  it("rejects unknown models or incompatible backend before calling transport", async () => {
    let called = false;
    for (const [backend, model] of [["llama.cpp", "other"], ["ollama", small], ["llama.cpp", MODEL]] as const) {
      await expect(planScene("湿地", async () => { called = true; return reply(model); }, signal(), backend, model)).rejects.toThrow();
    }
    expect(called).toBe(false);
  });
  it("exports v3 with explicit target and imports v2 and v1 as their original 7B target", async () => {
    const smallDraft = await planScene("湿地", async () => reply(small), signal(), "llama.cpp", small);
    const saved = await confirmPlan(smallDraft);
    expect(saved.schemaVersion).toBe(3);
    expect((await importPlan(exportPlan(saved))).draft.model).toBe(small);
    expect(() => parseDraft({ ...smallDraft, model: LLAMA_MODEL })).toThrow();
    for (const backend of ["llama.cpp", "ollama"] as const) {
      const model = backend === "ollama" ? MODEL : LLAMA_MODEL;
      const old = await confirmPlan(await planScene("湿地", async () => reply(model), signal(), backend));
      const { model: _model, ...v2draft } = old.draft;
      const migrated = await importPlan(JSON.stringify({ ...old, schemaVersion: 2, draft: v2draft }));
      expect(migrated).toMatchObject({ schemaVersion: 3, recipeHash: old.recipeHash, origin: "imported", draft: { model } });
      if (backend === "ollama") {
        const { backend: _backend, ...v1draft } = v2draft;
        expect((await importPlan(JSON.stringify({ ...old, schemaVersion: 1, draft: v1draft }))).draft.model).toBe(MODEL);
      }
    }
    expect(() => parseDraft({ ...demoPlan(), model: small })).toThrow();
  });
  it("sends the selected 3B identity and checks that exact status without loading another model", async () => {
    let sent: any;
    const transport = createLlamaTransport(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ model: small, choices: [{ finish_reason: "stop", message: { role: "assistant", content: raw } }] });
    }, small);
    await transport({ prompt: "湿地" }, signal());
    expect(sent.model).toBe(small);
    expect(sent.max_tokens).toBe(1024);
    const status = await readLlamaStatus(async () => Response.json({ data: [{ id: LLAMA_MODEL }] }), small);
    expect(status).toMatchObject({ available: false, model: small });
  });
});
