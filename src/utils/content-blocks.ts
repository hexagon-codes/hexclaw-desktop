import type { ChatMessage, ContentBlock } from '@/types/chat'

/**
 * 将 ChatMessage 转换为 ContentBlock[]。
 * 优先返回 msg.blocks；否则从 content / reasoning / tool_calls 字段构建。
 */
export function toContentBlocks(msg: ChatMessage): ContentBlock[] {
  if (msg.blocks && msg.blocks.length > 0) {
    return msg.blocks
  }

  const blocks: ContentBlock[] = []

  // 1. reasoning → thinking block
  if (msg.reasoning) {
    const duration =
      msg.metadata?.thinking_duration != null
        ? Number(msg.metadata.thinking_duration)
        : undefined
    blocks.push({ type: 'thinking', thinking: msg.reasoning, duration })
  }

  // 2. content → text block
  if (msg.content) {
    blocks.push({ type: 'text', text: msg.content })
  }

  // 3. tool_calls → tool_use + tool_result blocks
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      })
      if (tc.result != null) {
        blocks.push({
          type: 'tool_result',
          toolUseId: tc.id,
          toolName: tc.name,
          output: tc.result,
          isError: false,
        })
      }
    }
  }

  return blocks
}

/* ── Type guards ── */

export function isTextBlock(b: ContentBlock): b is ContentBlock & { type: 'text' } {
  return b.type === 'text'
}

export function isThinkingBlock(b: ContentBlock): b is ContentBlock & { type: 'thinking' } {
  return b.type === 'thinking'
}

export function isToolUseBlock(b: ContentBlock): b is ContentBlock & { type: 'tool_use' } {
  return b.type === 'tool_use'
}

export function isToolResultBlock(b: ContentBlock): b is ContentBlock & { type: 'tool_result' } {
  return b.type === 'tool_result'
}

export function isCodeBlock(b: ContentBlock): b is ContentBlock & { type: 'code' } {
  return b.type === 'code'
}
