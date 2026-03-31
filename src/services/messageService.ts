/**
 * 消息持久化服务
 *
 * 从 ChatStore 提取的 DB 操作层。所有 SQLite 读写集中在此，
 * Store 通过调用本服务完成持久化，自身不直接操作 DB。
 */

import {
  dbGetSessions,
  dbCreateSession,
  dbUpdateSessionTitle,
  dbTouchSession,
  dbDeleteSession,
  dbGetMessages,
  dbSaveMessage,
  dbDeleteMessage,
} from '@/db/chat'
import { dbGetArtifacts, dbSaveArtifact, dbDeleteSessionArtifacts } from '@/db/artifacts'
import { dbGetAppState, dbSetAppState } from '@/db/connection'
import { logger } from '@/utils/logger'
import type { ChatMessage, ChatSession, Artifact } from '@/types'

// ─── 消息序列化 ──────────────────────────────────────

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
  const rows = await dbGetSessions()
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
    message_count: 0,
  }))
}

export async function createSession(id: string, title: string): Promise<void> {
  await dbCreateSession(id, title)
}

export async function updateSessionTitle(id: string, title: string): Promise<void> {
  await dbUpdateSessionTitle(id, title)
}

export async function touchSession(id: string): Promise<void> {
  await dbTouchSession(id)
}

export async function deleteSession(id: string): Promise<void> {
  await dbDeleteSessionArtifacts(id)
  await dbDeleteSession(id)
}

// ─── 消息操作 ──────────────────────────────────────

export async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  const rows = await dbGetMessages(sessionId)
  return rows.map(normalizeLoadedMessage)
}

export async function persistMessage(msg: ChatMessage, sessionId: string): Promise<void> {
  try {
    await dbSaveMessage(
      msg.id, sessionId, msg.role, msg.content, msg.timestamp,
      serializeMessageMetadata(msg),
    )
  } catch (e) {
    logger.warn('持久化消息失败', e)
  }
}

export async function removeMessage(id: string): Promise<void> {
  await dbDeleteMessage(id)
}

// ─── Artifacts 操作 ──────────────────────────────────

export async function loadArtifacts(sessionId: string): Promise<Artifact[]> {
  return dbGetArtifacts(sessionId)
}

export async function saveArtifact(sessionId: string, artifact: Artifact): Promise<void> {
  await dbSaveArtifact(sessionId, artifact)
}

// ─── App State ──────────────────────────────────────

export async function getLastSessionId(): Promise<string | null> {
  return dbGetAppState('lastSessionId')
}

export async function setLastSessionId(id: string): Promise<void> {
  await dbSetAppState('lastSessionId', id)
}
