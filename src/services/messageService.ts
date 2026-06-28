/**
 * 消息服务层
 *
 * 数据库迁移后：所有数据操作通过 hexclaw 后端 API，
 * 前端不再直接操作 SQLite。
 */

import {
  listSessions,
  listSessionMessages,
  createSession as createSessionApi,
  updateSessionTitle as updateSessionTitleApi,
  suggestSessionTitle as suggestSessionTitleApi,
  deleteSession as deleteSessionApi,
  deleteMessage as deleteMessageApi,
  appendSessionMessage,
} from '@/api/chat'
import { DEFAULT_SESSION_TITLE } from '@/constants'
import { getAssistantDisplayContent, normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { extractThinkTags } from '@/utils/think-tags'
import type { ChatMessage, ChatSession, Artifact } from '@/types'

// ─── 消息序列化（保留，供外部 normalize 使用） ───────

export function parseMessageMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function normalizeLoadedMessage(row: {
  id: string
  role: string
  content: string
  timestamp: string
  metadata: string | null
}): ChatMessage {
  const metadata = parseMessageMetadata(row.metadata)
  const toolCalls = Array.isArray(metadata?.tool_calls) ? metadata.tool_calls : undefined
  // 重载有序内容块：多步 ReAct 切会话/重启后仍按真实交错序渲染（后端 meta.blocks 已落库）。
  const blocks = Array.isArray(metadata?.blocks) ? metadata.blocks : undefined
  const agentName = typeof metadata?.agent_name === 'string' ? metadata.agent_name : undefined
  const reasoning = typeof metadata?.reasoning === 'string'
    ? normalizeAssistantReasoning(metadata.reasoning) || undefined
    : undefined

  return {
    id: row.id,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    timestamp: row.timestamp,
    reasoning,
    metadata,
    tool_calls: toolCalls as ChatMessage['tool_calls'],
    blocks: blocks as ChatMessage['blocks'],
    agent_name: agentName,
  }
}

export function serializeMessageMetadata(msg: ChatMessage): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = { ...msg.metadata }
  if (msg.tool_calls?.length) metadata.tool_calls = msg.tool_calls
  if (msg.blocks?.length) metadata.blocks = msg.blocks
  if (msg.agent_name) metadata.agent_name = msg.agent_name
  if (msg.reasoning) {
    const reasoning = normalizeAssistantReasoning(msg.reasoning)
    if (reasoning) metadata.reasoning = reasoning
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

// ─── 会话操作 ──────────────────────────────────────

export async function loadAllSessions(): Promise<ChatSession[]> {
  try {
    const res = await listSessions({ limit: 200 })
    return (res.sessions || []).map(s => ({
      id: s.id,
      title: s.title || DEFAULT_SESSION_TITLE,
      created_at: s.created_at || new Date().toISOString(),
      updated_at: s.updated_at || new Date().toISOString(),
      message_count: s.message_count ?? 0,
    }))
  } catch {
    return []
  }
}

export async function createSession(id: string, title: string): Promise<void> {
  await createSessionApi(id, title)
}

export async function updateSessionTitle(id: string, title: string): Promise<void> {
  await updateSessionTitleApi(id, title)
}

export async function suggestSessionTitle(id: string, expectedTitle?: string) {
  return suggestSessionTitleApi(id, expectedTitle)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function touchSession(_id: string): Promise<void> {
  // Not needed — backend updates timestamps automatically
}

export async function deleteSession(id: string): Promise<void> {
  await deleteSessionApi(id)
}

// ─── 消息操作 ──────────────────────────────────────

export async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  try {
    const res = await listSessionMessages(sessionId, { limit: 500 })
    return (res.messages || []).map(m => {
      // 后端返回的 metadata / meta 可能是 JSON 字符串或已解析对象
      const meta = typeof m.metadata === 'string'
        ? parseMessageMetadata(m.metadata)
        : (m.metadata ?? undefined)
      // reasoning 存储在 meta 字段（扩展元数据）中
      const metaExt = typeof (m as unknown as Record<string, unknown>).meta === 'string'
        ? parseMessageMetadata((m as unknown as Record<string, unknown>).meta as string)
        : undefined
      const rawReasoning = m.reasoning
        || (typeof metaExt?.reasoning === 'string' ? metaExt.reasoning : undefined)
        || (typeof meta?.reasoning === 'string' ? meta.reasoning : undefined)
      const reasoning = rawReasoning ? normalizeAssistantReasoning(rawReasoning) || undefined : undefined
      const toolCalls = m.tool_calls
        || (Array.isArray(meta?.tool_calls) ? meta.tool_calls as ChatMessage['tool_calls'] : undefined)
      // 有序内容块：与 tool_calls 同存于 metadata（后端 SaveAssistantReply 同处落库）。
      // 重载时必须一并还原，否则多步 ReAct 切会话/重启后交错序丢失、退回扁平渲染。
      const blocks = (m as { blocks?: ChatMessage['blocks'] }).blocks
        || (Array.isArray(meta?.blocks) ? meta.blocks as ChatMessage['blocks'] : undefined)
      const agentName = m.agent_name
        || (typeof meta?.agent_name === 'string' ? meta.agent_name : undefined)

      // 兜底解析：后端可能存储了带 <think> 标签的原始 content
      let content = m.content || ''
      let mergedReasoning = reasoning
      if (m.role === 'assistant' && content) {
        const parsed = extractThinkTags(content)
        if (parsed.reasoning) {
          content = parsed.content
          mergedReasoning = mergedReasoning
            ? mergedReasoning + '\n' + parsed.reasoning
            : parsed.reasoning
        }
      }
      mergedReasoning = mergedReasoning ? normalizeAssistantReasoning(mergedReasoning) || undefined : undefined
      const displayContent = m.role === 'assistant'
        ? getAssistantDisplayContent(content, mergedReasoning)
        : content

      // 反馈与后端消息 id 还原：后端把 like/dislike 存独立 feedback 列、消息 id 即 m.id。
      // 重载时回填到 metadata，让 UI 高亮（user_feedback）与重载后再点赞落库（backend_message_id）都生效。
      const mergedMeta: Record<string, unknown> = { ...(meta ?? {}) }
      const rawFeedback = (m as unknown as Record<string, unknown>).feedback
      if (rawFeedback === 'like' || rawFeedback === 'dislike') {
        mergedMeta.user_feedback = rawFeedback
      }
      if (m.id) mergedMeta.backend_message_id = m.id
      const finalMeta = Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined

      return {
        ...m,
        content: displayContent,
        timestamp: m.timestamp || m.created_at || new Date().toISOString(),
        reasoning: mergedReasoning,
        tool_calls: toolCalls,
        blocks,
        agent_name: agentName,
        metadata: finalMeta,
      }
    })
  } catch {
    return []
  }
}

/**
 * persistMessage: 后端在 WebSocket/backend_chat 时自动持久化消息，
 * 前端不再需要显式写入。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function persistMessage(_msg: ChatMessage, _sessionId: string): Promise<boolean> {
  return true
}

/**
 * persistErrorReply: 失败回复（assistant 错误气泡）后端 chat handler 不会自动落库
 * （LLM 调用已报错、没有正常 assistant 轮次可存）。显式追加一条，保证切会话重载后
 * 错误仍可见、可重试。best-effort：落库失败不抛出，气泡已在内存中展示。
 */
export async function persistErrorReply(sessionId: string, message: ChatMessage): Promise<void> {
  try {
    await appendSessionMessage(sessionId, {
      id: message.id,
      role: 'assistant',
      content: message.content,
      metadata: { ...(message.metadata ?? {}), is_error: true },
    })
  } catch {
    // 落库失败不阻塞 UI
  }
}

export async function removeMessage(id: string): Promise<void> {
  await deleteMessageApi(id)
}

// ─── Artifacts 操作 ──────────────────────────────────

/**
 * Artifacts 在前端从消息内容中实时提取，不再持久化到 SQLite。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function loadArtifacts(_sessionId: string): Promise<Artifact[]> {
  return [] // Re-extracted from messages on load
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function saveArtifact(_sessionId: string, _artifact: Artifact): Promise<void> {
  // No-op: in-memory only
}

// ─── App State ──────────────────────────────────────

/**
 * lastSessionId: 使用 localStorage 替代 SQLite app_state
 */
export function getLastSessionId(): string | null {
  return localStorage.getItem('hexclaw_lastSessionId')
}

export function setLastSessionId(id: string): void {
  localStorage.setItem('hexclaw_lastSessionId', id)
}
