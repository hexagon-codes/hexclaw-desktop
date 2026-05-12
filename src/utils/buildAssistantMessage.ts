/**
 * buildAssistantMessage — 纯函数，构建 Assistant ChatMessage。
 *
 * 从 finalizeAssistantMessage 提取的纯函数部分：
 * - think tag 解析（extractThinkTags）
 * - reasoning 归一化（normalizeAssistantReasoning）
 * - thinking_duration 计算（从参数传入，不读 stream state）
 * - ChatMessage 构造（含 fallback content 处理）
 *
 * 不做：
 * - store mutation / session 管理 / 持久化
 * - artifact 提取 / auto-title 触发
 * - stream state 读写
 */

import { extractThinkTags } from './think-tags'
import { normalizeAssistantReasoning, getAssistantDisplayContent } from './assistant-reply'
import type { ChatMessage } from '@/types'

export interface BuildAssistantMessageOptions {
  /** 消息 ID，默认自动生成 */
  id?: string
  /** 外部 reasoning（模型主动返回的，非 think tag 提取的） */
  reasoning?: string
  /** 元数据（来自 sidecar / runtime） */
  metadata?: Record<string, unknown>
  /** 思考耗时（秒），由调用方从 stream state 或 execution 计算 */
  thinkingDuration?: number
  /** tool calls */
  toolCalls?: ChatMessage['tool_calls']
  /** agent 名称 */
  agentName?: string
}

/**
 * 构建 Assistant ChatMessage。
 *
 * 输入 content 可能包含 <think> 标签。
 * 函数内部自动提取并归一化 reasoning，
 * 处理 content fallback（空内容 / prompt leak / reasoning-only）。
 */
export function buildAssistantMessage(
  content: string,
  options?: BuildAssistantMessageOptions,
): ChatMessage {
  const id = options?.id ?? generateId()

  // ── think tag 解析 ──
  const parsed = extractThinkTags(content)
  const finalContent = parsed.content
  const rawReasoning = parsed.reasoning
    ? (options?.reasoning ? options.reasoning + '\n' + parsed.reasoning : parsed.reasoning)
    : (options?.reasoning || undefined)
  const finalReasoning = rawReasoning
    ? normalizeAssistantReasoning(rawReasoning) || undefined
    : undefined

  // ── metadata + thinking_duration ──
  let shouldSetMetadata = false
  const metadata: Record<string, unknown> = {}
  if (options?.metadata !== undefined) {
    Object.assign(metadata, options.metadata)
    shouldSetMetadata = true
  }
  if (options?.thinkingDuration && options.thinkingDuration > 0) {
    metadata.thinking_duration = options.thinkingDuration
    shouldSetMetadata = true
  }

  return {
    id,
    role: 'assistant',
    content: getAssistantDisplayContent(finalContent, finalReasoning),
    timestamp: new Date().toISOString(),
    reasoning: finalReasoning,
    ...(shouldSetMetadata ? { metadata } : {}),
    tool_calls: options?.toolCalls,
    agent_name: options?.agentName,
  }
}

/** 轻量 ID 生成（非 nanoid，避免纯函数引入外部依赖） */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
