/**
 * Turns runtime error text into something an ordinary user can act on:
 * drops JavaScript error-class prefixes, explains network failures to local
 * services, translates common validator messages, and tidies doubled
 * punctuation left by string concatenation.
 */
export function friendlyMessage(message: string) {
  return (
    message
      .replace(/\b(?:TypeError|Error|RangeError|SyntaxError):\s*/g, "")
      .replace(
        /\b(?:fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.?)/g,
        "无法连接本机服务（本地模型或项目服务可能尚未启动）",
      )
      // Shared validators throw short English messages; translate the common ones.
      .replace(/Number out of range/g, "数值超出允许范围")
      .replace(/Expected integer/g, "需要整数")
      .replace(/Invalid enum/g, "不是可选的值")
      .replace(/Unknown or missing fields/g, "字段缺失或多余")
      .replace(/Expected object/g, "格式不正确")
      .replace(/。{2,}/g, "。")
      .replace(/。；/g, "；")
  );
}
