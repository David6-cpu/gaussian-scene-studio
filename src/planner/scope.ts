/** Conservative guard for the existing wetland-only parameter endpoint, not a general biome classifier. */
export function assertWetlandScope(prompt: string): void {
  if (/雪|冰川|冰原|\bsnow(?:y|fields?)?\b|\bglaci(?:ers?|al)\b|\balpine\b/i.test(prompt))
    throw Error(
      "雪山/雪地/冰川相关资源缺失，当前文字入口仅调整湿地参数。请澄清需求；若这些词是否定或对比，请只描述本次要生成的湿地。不会用湿地代替，也不会调用模型编造资产。",
    );
}
