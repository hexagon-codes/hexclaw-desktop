/**
 * llmContract — Skill 执行的 Prompt 构建与输出验证。
 *
 * 纯函数模块，不创建 class，不维护状态。
 * 职责：
 * - 从 RuntimeContext 构建 { system?, user } prompt 输入
 * - 清洗 SKILL.md 中可能触发 LLM 内置工具的关键词
 * - 检测 SKILL.md 期望的输出格式
 * - 验证 LLM 输出是否符合格式要求
 *
 * 不做：
 * - LLM 调用（由 providerAdapter 负责）
 * - Transport（由 backendLLMClient 负责）
 * - 状态管理（由 RuntimeStore 负责）
 */

import type { RuntimeContext } from '@/types/context'

// ── 类型 ─────────────────────────────────────────

/** Prompt 构建输出 */
export interface PromptInput {
  system?: string
  user: string
}

/** Skill 输出格式推断结果 */
export type SkillOutputFormat = 'bullet' | 'numbered' | 'free'

// ── 关键词清洗 ───────────────────────────────────

/**
 * 可能触发 LLM 内置工具调用的关键词列表。
 * 清洗策略：替换为 `***`，保留 SKILL.md 其他语义不变。
 */
const SKILL_KEYWORD_BLOCKLIST = ['summarize', 'bulletize', 'search', 'web_search']

/**
 * 清洗 SKILL.md 中的危险关键词。
 *
 * @param markdown - 原始 SKILL.md 内容
 * @returns 清洗后的内容
 */
export function sanitizeSkillMarkdown(markdown: string): string {
  let result = markdown
  for (const keyword of SKILL_KEYWORD_BLOCKLIST) {
    result = result.replace(new RegExp(keyword, 'gi'), '***')
  }
  return result
}

// ── Prompt 构建 ──────────────────────────────────

/**
 * 从 RuntimeContext 构建 LLM prompt 输入。
 *
 * System prompt 组装顺序（末尾 = 最强 recency bias）：
 *   1. <SKILL_INSTRUCTIONS> — SKILL.md 内容 + MODE:DIRECT
 *   2. <CONSTRAINTS> — 系统约束
 *   3. <OUTPUT_COMPLIANCE> — 格式合规指令（放在最后）
 *
 * User message：原始用户输入，不再追加 [MODE: DIRECT]（消除双重注入）。
 *
 * @param context - RuntimeContext 5 层聚合根
 * @returns { system?, user } prompt 输入
 */
export function buildPromptInput(context: RuntimeContext): PromptInput {
  const taskLayer = context.task
  const systemLayer = context.system
  const skillLayer = context.skill

  const parts: string[] = []

  if (skillLayer?.markdown) {
    const sanitized = sanitizeSkillMarkdown(skillLayer.markdown)
    parts.push(`<SKILL_INSTRUCTIONS>
[MODE: DIRECT] Output directly. No planning. No tool calls.
${sanitized}
</SKILL_INSTRUCTIONS>`)
  }

  if (systemLayer?.constraints?.length) {
    parts.push(`<CONSTRAINTS>
${systemLayer.constraints.join('\n')}
</CONSTRAINTS>`)
  }

  if (skillLayer?.markdown) {
    // 格式合规指令放在 system prompt 末尾 — 最强 recency bias
    // 即使 Go backend 在前面拼接内容，此指令仍在最后
    parts.push(`<OUTPUT_COMPLIANCE>
You MUST follow the EXACT output format defined in <SKILL_INSTRUCTIONS>.
Do NOT deviate. Do NOT add text before or after.
Output ONLY the formatted result.
</OUTPUT_COMPLIANCE>`)
  }

  const system = parts.length > 0 ? parts.join('\n\n') : undefined

  const payload = taskLayer?.input?.payload
  const user = typeof payload?.text === 'string'
    ? payload.text
    : typeof payload?.message === 'string'
      ? payload.message
      : typeof payload?.goal === 'string'
        ? payload.goal
        : JSON.stringify(payload ?? {})

  return { system, user }
}

// ── 输出格式检测 ─────────────────────────────────

/**
 * 从 SKILL.md 内容推断期望的输出格式。
 *
 * @param skillMarkdown - SKILL.md 原始内容
 * @returns 推断的输出格式
 */
export function detectOutputFormat(skillMarkdown: string): SkillOutputFormat {
  if (/^•\s/m.test(skillMarkdown) || /每行必须用 `•`/.test(skillMarkdown)) return 'bullet'
  if (/\[要点N?\]/.test(skillMarkdown) || /每行必须用 `\[要点N\]`/.test(skillMarkdown)) return 'numbered'
  return 'free'
}

// ── 输出验证 ─────────────────────────────────────

/**
 * 验证 LLM 输出是否符合 SKILL.md 定义的格式。
 *
 * - bullet 格式：每行以 `• ` 开头
 * - numbered 格式：每行以 `[要点N] ` 开头
 * - free 格式：始终有效
 *
 * 如果格式不完全匹配但可清洗（提取符合格式的行），返回 cleaned 版本。
 *
 * @param content - LLM 原始输出
 * @param format - 期望的输出格式
 * @returns { valid, cleaned? } 验证结果
 */
export function validateSkillOutput(
  content: string,
  format: SkillOutputFormat,
): { valid: boolean; cleaned?: string } {
  const lines = content.split('\n').filter(l => l.trim())

  if (format === 'bullet') {
    const validLines = lines.filter(l => /^•\s/.test(l.trim()))
    if (validLines.length > 0) {
      const cleaned = validLines.join('\n')
      // 如果 cleaned 与原始 content 不同，说明有清洗
      return cleaned === content
        ? { valid: true }
        : { valid: true, cleaned }
    }
    return { valid: false }
  }

  if (format === 'numbered') {
    const validLines = lines.filter(l => /^\[要点\d+\]\s/.test(l.trim()))
    if (validLines.length > 0) {
      const cleaned = validLines.join('\n')
      return cleaned === content
        ? { valid: true }
        : { valid: true, cleaned }
    }
    return { valid: false }
  }

  // free 格式始终有效
  return { valid: true }
}
