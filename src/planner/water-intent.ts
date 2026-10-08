export type WaterIntent = {
  mode: "present" | "absent" | "unspecified" | "clarify";
  level?: number;
  evidence: string[];
  message?: string;
};

// A live-input check, never a replacement water level or an archive migration.
export function waterIntent(prompt: string): WaterIntent {
  const clauses = prompt.split(/[，,；;。！？\n]/).filter(c => /水|河|溪/.test(c));
  const evidence = clauses.map(c => c.trim());
  const clarify = (): WaterIntent => ({
    mode: "clarify", evidence,
    message: "请澄清水体要求：明确选择有水、无水或一个确定水位；不会替你猜测或修改原描述。",
  });
  const text = clauses.join("，");
  if (/不是不|并非不|不能不|不要不|如果|假如|除非|可能|也许|或许|不一定|是否|未定|没定|不确定|至少|至多|大于|小于/.test(text)) return clarify();
  const levels = [...text.matchAll(/水位\s*(?:设置为|设为|等于|为|是|[:：=])?\s*([-+]?(?:\d+(?:\.\d+)?|\.\d+))/g)];
  if (levels.length && /(?:\d|\.)\s*(?:到|至|~|～|或)\s*[-+\d.]/.test(text)) return clarify();
  const values = levels.map(m => Number(m[1]));
  if (values.some(n => !Number.isFinite(n) || n < -0.5 || n > 0.5) || new Set(values).size > 1) return clarify();
  if (/水位/.test(text) && !levels.length) return clarify();
  const dry = /不(?:要|用|需(?:要)?|放|加|添加|留)?\s*水|无水|没有水|干涸|干枯(?:的)?河/.test(text);
  const remaining = text.replace(/不(?:要|用|需(?:要)?|放|加|添加|留)?\s*水|无水|没有水|干涸|干枯(?:的)?河/g, "");
  const explicitWet = /有水|放水|加水|添加水|保留水|要水/.test(remaining) || values.length > 0;
  if (dry && explicitWet) return clarify();
  if (/不要河|无河|不是河|不需要河/.test(remaining)) return clarify();
  if (dry) return { mode: "absent", evidence };
  if (explicitWet || /河岸|河边|河流|小河|河里|河道|溪流|溪边/.test(text))
    return { mode: "present", evidence, ...(values.length ? { level: values[0] } : {}) };
  return { mode: "unspecified", evidence };
}

export function assertWaterIntent(intent: WaterIntent, level: number | null): void {
  if (intent.mode === "clarify") throw Error(intent.message);
  if (intent.mode === "present" && level === null)
    throw Error("水体要求不一致：描述需要河岸水面，返回了无水。请按原描述重新输出，不能省略水体。");
  if (intent.mode === "absent" && level !== null)
    throw Error("水体要求不一致：描述明确要求无水，返回了水位。请保留无水要求。");
  if (intent.level !== undefined && level !== intent.level)
    throw Error(`水位要求不一致：描述明确要求${intent.level}，返回${level}；不能替换为默认水位。`);
}
