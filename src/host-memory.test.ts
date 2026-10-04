import { test, expect } from "vitest";
import { parseSwap, pressureLabel } from "../scripts/observe-memory.mjs";
test("host parser preserves MiB units and unknown readings stay unknown", () => {
  expect(
    parseSwap("vm.swapusage: total = 2048.00M used = 414.75M free = 1633.25M"),
  ).toBe(414.75);
  expect(parseSwap("used = 1.25G")).toBe(1280);
  expect(parseSwap("denied")).toBeNull();
  expect(pressureLabel("1\n")).toBe("normal");
  expect(pressureLabel("2")).toBe("warning");
  expect(pressureLabel("4")).toBe("critical");
  expect(pressureLabel("unknown")).toBeNull();
});
