import { expect, test } from "vitest";
import { friendlyMessage } from "./user-message";

test("drops JavaScript error-class prefixes", () => {
  expect(friendlyMessage("导入失败：Error: 环境元数据对象缺失。")).toBe(
    "导入失败：环境元数据对象缺失。",
  );
  expect(friendlyMessage("TypeError: x")).toBe("x");
});
test("explains network failures to local services", () => {
  expect(friendlyMessage("fetch failed；保留输入，可使用手工模式。")).toBe(
    "无法连接本机服务（本地模型或项目服务可能尚未启动）；保留输入，可使用手工模式。",
  );
  expect(friendlyMessage("TypeError: Failed to fetch")).toContain(
    "无法连接本机服务",
  );
});
test("translates shared validator messages", () => {
  expect(
    friendlyMessage("Error: 配方无效：Number out of range。请修改后重试"),
  ).toBe("配方无效：数值超出允许范围。请修改后重试");
  expect(friendlyMessage("Expected integer")).toBe("需要整数");
});
test("collapses doubled punctuation from concatenated messages", () => {
  expect(friendlyMessage("导入失败：缺失。。上一场景保留。")).toBe(
    "导入失败：缺失。上一场景保留。",
  );
  expect(friendlyMessage("失败。；请重试")).toBe("失败；请重试");
});
test("leaves ordinary Chinese text unchanged", () => {
  const text = "预览就绪 · 请检查画面；可以取消、保存到本机或下载备份。";
  expect(friendlyMessage(text)).toBe(text);
});
