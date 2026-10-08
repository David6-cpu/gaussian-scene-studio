import { expect, test } from "vitest";
import { waterIntent, assertWaterIntent } from "./water-intent";

test.each([
  ["河岸上放一些低矮草丛和石头", "present"],
  ["干涸河床，不放水", "absent"],
  ["河岸，不放水", "absent"],
  ["草丛和石头", "unspecified"],
  ["要有水，但不要水", "clarify"],
  ["不是不要水", "clarify"],
  ["河里可能有水", "clarify"],
  ["水位0到0.1", "clarify"],
  ["水位0.1，水位-0.1", "clarify"],
  ["水位-0.8", "clarify"],
  ["河岸无水", "absent"],
  ["水位0，不放水", "clarify"],
])("water intent preserves or clarifies %s", (prompt, mode) => {
  expect(waterIntent(prompt).mode).toBe(mode);
});
test("riverbank rejects missing water without supplying a replacement", () => {
  const intent = waterIntent("河岸上放一些低矮草丛和石头");
  expect(() => assertWaterIntent(intent, null)).toThrow(/水/);
  expect(() => assertWaterIntent(intent, 0)).not.toThrow();
  expect(() => assertWaterIntent(intent, -0.025)).not.toThrow();
  expect(intent.level).toBeUndefined();
});
test("explicit level and dry requirements are never silently defaulted", () => {
  const explicit = waterIntent("河岸水位-0.025");
  expect(explicit.level).toBe(-0.025);
  expect(() => assertWaterIntent(explicit, 0)).toThrow(/水位/);
  expect(() => assertWaterIntent(explicit, -0.025)).not.toThrow();
  expect(() => assertWaterIntent(waterIntent("不放水"), 0)).toThrow(/水/);
  expect(() => assertWaterIntent(waterIntent("不放水"), null)).not.toThrow();
  expect(() => assertWaterIntent(waterIntent("不是不要水"), null)).toThrow(/澄清/);
});
