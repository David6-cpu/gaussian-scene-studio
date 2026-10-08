import { describe, expect, it } from "vitest";
import { defaultRecipe } from "../recipe";
import { proposalFromRecipe } from "./contract";
import { planScene, LLAMA_SMALL_MODEL } from "./service";
import { confirmPlan, exportPlan, importPlan } from "./history";
import cases from "../../tests/fixtures/planner-terrain-requests.json";
import { terrainIntent, terrainReview } from "./terrain-intent";

const base = proposalFromRecipe(defaultRecipe);
const reply = (change: object) => ({ raw: JSON.stringify({ ...base, ...change }), model: LLAMA_SMALL_MODEL, done: true, doneReason: "stop" });
const run = (prompt: string, transport: Parameters<typeof planScene>[1]) => planScene(prompt, transport, new AbortController().signal, "llama.cpp", LLAMA_SMALL_MODEL);

describe("terrain intent checks do not manufacture model output", () => {
  it("detects observed flat/layer mistakes but rejects the second reply that still violates no-water", async () => {
    let calls = 0;
    const input = cases.find(c => c.id === "observed-layers")!;
    const original = reply({ amplitude: 0.6, octaves: 3 });
    const result = await run(input.prompt, async request => {
      if (++calls === 1) return original;
      expect(request.repair?.error).toContain("amplitude");
      expect(request.repair?.error).toContain("octaves");
      expect(request.repair?.raw).toBe(original.raw);
      return reply({ amplitude: 0, octaves: 1 });
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ source: "default", repaired: false, templateVersion: "parameters-v2" });
    expect(result.attempts[0].raw).toBe(original.raw);
    expect(result.attempts[0].error).toContain("语义");
    expect(result.attempts[1].raw).toBe(reply({ amplitude: 0, octaves: 1 }).raw);
    expect(result.attempts[1].error).toContain("无水");
  });
  it("labels persistent semantic failure as fallback, preserving both raw outputs", async () => {
    const bad = reply({ amplitude: 0.5, octaves: 3 });
    const result = await run("平坦地形，地形层数一", async () => bad);
    expect(result.source).toBe("default");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every(a => a.raw === bad.raw && a.error)).toBe(true);
    expect(result.reason).toContain("未解释输入");
    expect(result.proposal).toEqual(base);
  });
  it.each(["平地，振幅0.3", "地形层数1，同时地形层数3", "噪声层数六"]) (
    "requires clarification before any model call: %s", async prompt => {
      let called = false;
      await expect(run(prompt, async () => { called = true; return reply({}); })).rejects.toThrow(/澄清/);
      expect(called).toBe(false);
    },
  );
  it.each(["不要把地形层数设为3", "我不想要地形层数3", "如果地形层数3就改成2", "地形层数1到3", "起伏幅度0.3到0.5", "层数一或三"]) (
    "does not silently equate qualified values with their first number: %s", async prompt => {
      let called = false;
      await expect(run(prompt, async () => { called = true; return reply({}); })).rejects.toThrow(/澄清/);
      expect(called).toBe(false);
    },
  );
  it("does not turn a prohibition into a flat constraint or claim it was verified", () => {
    expect(terrainIntent("禁止平地").constraints).toEqual([]);
    expect(terrainReview("禁止平地", base)).toContain("请审阅");
    expect(terrainReview("禁止平地", base)).not.toContain("已核对明确");
  });
  it("does not turn a negated flat request into amplitude zero", async () => {
    const result = await run("不要平地，起伏幅度0.3，地形层数为二", async () => reply({ amplitude: 0.3, octaves: 2 }));
    expect(result).toMatchObject({ source: "llama.cpp", repaired: false, proposal: { amplitude: 0.3, octaves: 2 } });
  });
  it.each(["我不想要平地", "不是完全平地", "如果是平地才需要零起伏"]) (
    "does not treat qualified mentions as an unconditional flat constraint: %s", async phrase => {
      const result = await run(`${phrase}，起伏幅度0.3，层数二`, async () => reply({ amplitude: 0.3, octaves: 2 }));
      expect(result.source).toBe("llama.cpp");
      expect(result.proposal.amplitude).toBe(0.3);
    },
  );
  it("recognizes a flat paraphrase and Chinese layer count without filling other model fields", async () => {
    const result = await run("没有起伏的湿地地面，噪声层数为二", async () => reply({ amplitude: 0, octaves: 2, seed: 79 }));
    expect(result).toMatchObject({ source: "llama.cpp", proposal: { amplitude: 0, octaves: 2, seed: 79 } });
  });
  it("revalidates v2-template success evidence but keeps original v1 historical records readable", async () => {
    const draft = await run("平地，地形层数1", async () => reply({ amplitude: 0, octaves: 1 }));
    const saved = await confirmPlan(draft);
    const forged = { ...saved, kind: "manual", draft: { ...draft, proposal: { ...draft.proposal, amplitude: 0.5 }, attempts: [{ ...draft.attempts[0], raw: reply({ amplitude: 0.5, octaves: 1 }).raw }] } };
    await expect(importPlan(JSON.stringify(forged))).rejects.toThrow(/语义/);
    const historical = { ...forged, draft: { ...forged.draft, templateVersion: "parameters-v1" } };
    expect((await importPlan(JSON.stringify(historical))).draft.proposal.amplitude).toBe(0.5);
    expect((await importPlan(exportPlan(saved))).draft.templateVersion).toBe("parameters-v2");
  });
});
