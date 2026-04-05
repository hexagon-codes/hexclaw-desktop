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
  deleteSession as deleteSessionApi,
  deleteMessage as deleteMessageApi,
} from '@/api/chat'
import { DEFAULT_SESSION_TITLE } from '@/constants'
import { logger } from '@/utils/logger'
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
  const agentName = typeof metadata?.agent_name === 'string' ? metadata.agent_name : undefined
  const reasoning = typeof metadata?.reasoning === 'string' ? metadata.reasoning : undefined

  return {
    id: row.id,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    timestamp: row.timestamp,
    reasoning,
    metadata,
    tool_calls: toolCalls as ChatMessage['tool_calls'],
    agent_name: agentName,
  }
}

export function serializeMessageMetadata(msg: ChatMessage): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = { ...(msg.metadata ?? {}) }
  if (msg.tool_calls?.length) metadata.tool_calls = msg.tool_calls
  if (msg.agent_name) metadata.agent_name = msg.agent_name
  if (msg.reasoning) metadata.reasoning = msg.reasoning
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
      const metaExt = typeof (m as Record<string, unknown>).meta === 'string'
        ? parseMessageMetadata((m as Record<string, unknown>).meta as string)
        : undefined
      const reasoning = m.reasoning
        || (typeof metaExt?.reasoning === 'string' ? metaExt.reasoning : undefined)
        || (typeof meta?.reasoning === 'string' ? meta.reasoning : undefined)
      const toolCalls = m.tool_calls
        || (Array.isArray(meta?.tool_calls) ? meta.tool_calls as ChatMessage['tool_calls'] : undefined)
      const agentName = m.agent_name
        || (typeof meta?.agent_name === 'string' ? meta.agent_name : undefined)

      return {
        ...m,
        timestamp: m.timestamp || m.created_at || new Date().toISOString(),
        reasoning,
        tool_calls: toolCalls,
        agent_name: agentName,
        metadata: meta,
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
export async function persistMessage(_msg: ChatMessage, _sessionId: string): Promise<boolean> {
  return true
}

export async function removeMessage(id: string): Promise<void> {
  await deleteMessageApi(id)
}

// ─── Artifacts 操作 ──────────────────────────────────

/**
 * Artifacts 在前端从消息内容中实时提取，不再持久化到 SQLite。
 */
export async function loadArtifacts(_sessionId: string): Promise<Artifact[]> {
  return [] // Re-extracted from messages on load
}

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
