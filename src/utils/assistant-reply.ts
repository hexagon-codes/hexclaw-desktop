export const EMPTY_ASSISTANT_REPLY = '这次没有生成可显示的回答，请重试或换个方式提问。'
export const REASONING_ONLY_ASSISTANT_REPLY = '模型只完成了思考，没有输出最终回答，请重试一次。'
export const SKILL_PROMPT_LEAK_REPLY = '这次只加载了角色设定，没有生成最终回答，请重试一次。'

export function normalizeAssistantReasoning(
  reasoning: string,
  options: { trim?: boolean } = {},
): string {
  const normalized = reasoning.replace(/<\/?think(?:ing)?>/gi, '')
  return options.trim === false ? normalized : normalized.trim()
}

export function getAssistantReasoningFromMetadata(metadata?: Record<string, unknown>): string | undefined {
  if (typeof metadata?.reasoning !== 'string') return undefined
  return normalizeAssistantReasoning(metadata.reasoning) || undefined
}

function isLikelySkillPromptLeak(content: string): boolean {
  return /^#\s*角色设定/m.test(content) && /##\s*核心性格/m.test(content)
}

export function normalizeAssistantContent(content: string, reasoning?: string): string {
  if (reasoning?.trim()) {
    const leakedCloseTag = content.match(/<\/think(?:ing)?>/i)
    if (leakedCloseTag?.index !== undefined) {
      return content.slice(leakedCloseTag.index + leakedCloseTag[0].length).trimStart()
    }
  }
  return content
}

export function getAssistantDisplayContent(content: string, reasoning?: string): string {
  const hasReasoningContext = Boolean(reasoning?.trim())
  const normalizedReasoning = hasReasoningContext ? normalizeAssistantReasoning(reasoning!) : undefined
  const normalizedContent = normalizeAssistantContent(content, hasReasoningContext ? reasoning : undefined)
  if (isLikelySkillPromptLeak(normalizedContent)) return SKILL_PROMPT_LEAK_REPLY
  if (normalizedContent.trim()) return normalizedContent
  return normalizedReasoning ? REASONING_ONLY_ASSISTANT_REPLY : EMPTY_ASSISTANT_REPLY
}
