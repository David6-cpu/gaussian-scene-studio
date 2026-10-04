import type { Proposal } from "./contract";

type Field = "amplitude" | "octaves";
type Constraint = { field: Field; value: number; evidence: string };
export type TerrainIntent = { constraints: Constraint[]; notes: string[] };
const numberWords: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const negated = /(?:不(?:是|要|用|必|需要)?|非|别|避免)\s*$/;

// A narrow, independent check of explicit terrain constraints, not a scene generator.
// It never supplies or changes proposal values; all returned values remain model output.
export function terrainIntent(prompt: string): TerrainIntent {
  const constraints: Constraint[] = [], notes: string[] = [];
  for (const clause of prompt.split(/[，,；;。！？\n]/).filter(Boolean)) {
    if (/(?:amplitude|振幅|起伏幅度|octaves|层数)/i.test(clause) && (
      /不|非|别|禁止|避免|无需|如果|假如|除非|可能|大于|小于|至少|最多|以上|以下|任选/.test(clause) ||
      /[\d零〇一二两三四五六七八九十]\s*(?:到|至|和|或|与|[-~～])\s*[\d零〇一二两三四五六七八九十]/.test(clause)
    )) throw Error(`请澄清“${clause.trim()}”：含否定、条件、范围或备选值，当前只自动核对明确的单一振幅/层数；不会截取第一个数值。`);
    const flat = /平地|平坦(?:的)?(?:地形|地面)?|没有起伏|无起伏/.exec(clause);
    if (flat) {
      const qualified = /不|非|别|禁止|避免|无需|如果|假如|除非|以外|局部|部分|一半|附近|周围|中心|比较|更|稍|[“”"「」]/.test(clause);
      if (qualified) {
        notes.push(`“${clause.trim()}”含否定、局部或比较表述，未自动等同于全局零起伏，请审阅。`);
      } else constraints.push({ field: "amplitude", value: 0, evidence: flat[0] });
    }
    const patterns: [Field, RegExp][] = [
      ["amplitude", /(?:amplitude|(?:地形)?振幅|起伏幅度)\s*(?:为|是|设为|设置为|等于|[:：=])?\s*([-+]?(?:\d+(?:\.\d+)?|\.\d+))/gi],
      ["octaves", /(?:octaves|(?:地形|噪声)?层数)\s*(?:为|是|设为|设置为|等于|[:：=])?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]+)/gi],
    ];
    for (const [field, pattern] of patterns) {
      for (const match of clause.matchAll(pattern)) {
        if (negated.test(clause.slice(0, match.index))) {
          notes.push(`“${match[0]}”前有否定，未把该数值作为确定要求，请审阅。`);
          continue;
        }
        const value = numberWords[match[1]] ?? Number(match[1]);
        if (!Number.isFinite(value) || (field === "amplitude"
          ? value < 0 || value > 1
          : !Number.isInteger(value) || value < 1 || value > 5))
          throw Error(`请澄清${field === "amplitude" ? "起伏幅度（0–1）" : "地形层数（1–5的整数）"}：${match[0]}。不会截断或替换为默认值。`);
        constraints.push({ field, value, evidence: match[0] });
      }
    }
  }
  for (const field of ["amplitude", "octaves"] as const) {
    const found = constraints.filter(c => c.field === field);
    if (new Set(found.map(c => c.value)).size > 1)
      throw Error(`请澄清相互冲突的${field}要求：${found.map(c => c.evidence).join(" / ")}。不会代选其中一个。`);
  }
  return { constraints, notes: [...new Set(notes)] };
}

export function terrainDifferences(intent: TerrainIntent, proposal: Proposal): string[] {
  return intent.constraints.filter(c => proposal[c.field] !== c.value)
    .map(c => `“${c.evidence}”要求${c.field}=${c.value}，返回${proposal[c.field]}`);
}
export function assertTerrainIntent(intent: TerrainIntent, proposal: Proposal): void {
  const differences = terrainDifferences(intent, proposal);
  if (differences.length) throw Error(`语义约束不一致：${differences.join("；")}。请按原始描述重新输出完整JSON，不要改动其他已符合要求的字段。`);
}

export function terrainReview(prompt: string, proposal: Proposal): string {
  try {
    const intent = terrainIntent(prompt);
    const differences = terrainDifferences(intent, proposal);
    return [
      differences.length ? `待确认：当前配方与描述不同：${differences.join("；")}` :
        intent.constraints.length ? "已核对明确的平地/振幅/层数要求；不代表整段描述均已理解。" :
          "未识别可自动核对的明确平地/振幅/层数要求，请人工审阅。",
      ...intent.notes,
    ].join("\n");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
