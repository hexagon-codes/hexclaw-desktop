/**
 * SOUL 结构化编辑器纯逻辑（原型 C 方案落地，BUG-20260703 批次）。
 *
 * 7 个自由段 + 三预设 + 合成 + 体检打分。与原型 app.html 的 SOUL_FREE/soulScore
 * 语义对齐：段顺序与「## 中文（English）」小节格式是稳定契约——合成产物直接写回
 * agent 的 system_prompt，后端按纯文本消费，无新契约。
 */

export interface SoulSegmentDef {
  key: string
  zh: string
  en: string
  /** 输入框占位提示 */
  ph: string
  /** 一键示例文本 */
  eg: string
  /** 体检权重（总和 + 基础 12 分 = 100） */
  weight: number
}

export const SOUL_SEGMENTS: SoulSegmentDef[] = [
  { key: 'identity', zh: '身份', en: 'Identity', ph: '你是谁——名字、角色、性格基调', eg: '你是「小蟹」🦀，HexClaw 的桌面 AI 助理，沉稳克制、专业可靠，优先把事办成。', weight: 16 },
  { key: 'mission', zh: '目标', en: 'Mission', ph: '核心使命与成功标准', eg: '在用户本机把任务做完并交付可用结果，而不是只给建议。', weight: 16 },
  { key: 'context', zh: '上下文', en: 'Context', ph: '运行环境、用户、领域背景', eg: '运行于用户自有 macOS 桌面，单用户、数据私有、可联网。', weight: 8 },
  { key: 'decision', zh: '决策规则', en: 'Decision', ph: '优先级、取舍、何时澄清或拒绝', eg: '信息不足先澄清再动手；高风险操作先确认；安全与正确性优先于速度。', weight: 12 },
  { key: 'constraints', zh: '约束', en: 'Constraints', ph: '红线与禁止项', eg: '不编造事实与来源；不泄露密钥；破坏性操作必须二次确认。', weight: 14 },
  { key: 'output', zh: '输出结构', en: 'OutputSchema', ph: '回复格式 / JSON 结构', eg: '默认「结论先行 + 要点列表」；被要求时输出严格 JSON。', weight: 12 },
  { key: 'eval', zh: '自检', en: 'Evaluation', ph: '交付前自我核对', eg: '交付前自检：是否答到点、有无编造、是否符合输出结构。', weight: 10 },
]

export interface SoulSegState {
  on: boolean
  val: string
}

export type SoulState = Record<string, SoulSegState>

export const SOUL_PRESETS: Record<string, { label: string; on: string[] }> = {
  blank: { label: '空白', on: [] },
  lite: { label: '极简', on: ['identity', 'mission', 'constraints'] },
  full: { label: '完整', on: SOUL_SEGMENTS.map((s) => s.key) },
}

/** 按预设生成初始状态：开启的段带示例文本（可一键起草后微调）。 */
export function presetState(preset: keyof typeof SOUL_PRESETS): SoulState {
  const ps = SOUL_PRESETS[preset] ?? SOUL_PRESETS.blank!
  const st: SoulState = {}
  for (const seg of SOUL_SEGMENTS) {
    const on = ps.on.includes(seg.key)
    st[seg.key] = { on, val: on ? seg.eg : '' }
  }
  return st
}

/** 用现有人设文本做种子：完整预设为底，identity 覆盖为现有文本（非空时）。 */
export function seedFromText(text: string): SoulState {
  const st = presetState('full')
  const t = text.trim()
  if (t) st.identity = { on: true, val: t }
  return st
}

/** 合成写回 system_prompt 的 markdown：只含开启且非空的段，按定义顺序。全空返回 ''。 */
export function assembleSoul(state: SoulState): string {
  const parts: string[] = []
  for (const seg of SOUL_SEGMENTS) {
    const st = state[seg.key]
    if (st?.on && st.val.trim()) {
      parts.push(`## ${seg.zh}（${seg.en}）\n${st.val.trim()}`)
    }
  }
  return parts.join('\n\n')
}

export interface SoulHealthTip {
  level: 'ok' | 'warn' | 'miss'
  text: string
}

/** 体检打分（对齐原型 soulScore）：满 12 字计满权重，1-11 字计半权重并提示偏短，
 *  空/关闭计缺失；基础分 12。 */
export function soulHealth(state: SoulState): { score: number; tips: SoulHealthTip[] } {
  let score = 12
  const tips: SoulHealthTip[] = []
  for (const seg of SOUL_SEGMENTS) {
    const st = state[seg.key]
    const val = st?.on ? (st.val ?? '').trim() : ''
    if (val.length >= 12) {
      score += seg.weight
    } else if (val.length > 0) {
      score += Math.round(seg.weight / 2)
      tips.push({ level: 'warn', text: `「${seg.zh}」偏短，建议展开到一两句` })
    } else {
      tips.push({ level: 'miss', text: `缺「${seg.zh} · ${seg.en}」` })
    }
  }
  if (tips.length === 0) tips.push({ level: 'ok', text: '结构完整，关键段齐备 👍' })
  return { score: Math.max(0, Math.min(100, score)), tips }
}
