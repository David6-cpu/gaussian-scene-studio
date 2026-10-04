import { expect, test } from "vitest";
import { planScene, LLAMA_SMALL_MODEL } from "./service";
import { assertWetlandScope } from "./scope";

test.each([
  "雪山有雪地、三块石头",
  "a snowy mountain with rocks",
  "glaciers with three rocks",
  "a glacial landscape with plants",
  "a snowfield with rocks",
  "snowfields around the lake",
  "冰川边的小湖",
  "不要雪山，只要湿地",
])(
  "explicit unavailable environment needs clarification before transport: %s",
  async (prompt) => {
    let called = false;
    await expect(
      planScene(
        prompt,
        async () => {
          called = true;
          throw Error("transport must not run");
        },
        new AbortController().signal,
        "llama.cpp",
        LLAMA_SMALL_MODEL,
      ),
    ).rejects.toThrow(/缺失.*雪|雪.*缺失/);
    expect(called).toBe(false);
  },
);
test("existing wetland descriptions remain valid and scope is not presented as a general classifier", () => {
  expect(() =>
    assertWetlandScope("湿地河岸，2组碎石、6丛低草，水位0，平地。"),
  ).not.toThrow();
  expect(() => assertWetlandScope("雪山")).toThrow(/澄清/);
});
