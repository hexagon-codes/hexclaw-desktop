import type { ChatMessage, ChatSession } from '@/types'

/**
 * 切会话时合并「后端历史」与「本地内存快照」——后端已有的以后端为准（authoritative），
 * 后端尚无但本地有的（乐观插入/在途、后端尚未落库的消息）保留追加，绝不因后端返回少而抹掉
 * 刚发的消息（BUG-20260712 #F：切走再切回刚发的消息消失）。
 *
 * 时序：后端消息在前（含历史顺序），本地独有的按其原顺序追加在后——乐观/在途消息恒为最新。
 * 后端补齐（下次加载 backend 已含该 id）时按 id 去重，不产生重复。
 */
export function mergeMessagesById(
  backend: ChatMessage[],
  cached: ChatMessage[],
): ChatMessage[] {
  if (cached.length === 0) return backend
  const canonicalMessageId = (message: ChatMessage): string => {
    const backendMessageId = message.metadata?.backend_message_id
    return typeof backendMessageId === 'string' && backendMessageId
      ? backendMessageId
      : message.id
  }
  const backendIds = new Set(backend.map(canonicalMessageId))
  const extras = cached.filter((message) => !backendIds.has(canonicalMessageId(message)))
  return extras.length ? [...backend, ...extras] : backend
}

export function upsertSession(
  sessions: ChatSession[],
  session: ChatSession,
  prepend = false,
): ChatSession[] {
  const idx = sessions.findIndex((item) => item.id === session.id)
  if (idx >= 0) {
    const next = [...sessions]
    next[idx] = { ...next[idx]!, ...session }
    return next
  }
  return prepend ? [session, ...sessions] : [...sessions, session]
}

export function bumpSession(sessions: ChatSession[], sessionId: string): ChatSession[] {
  const idx = sessions.findIndex((item) => item.id === sessionId)
  if (idx < 0) return sessions
  const current = sessions[idx]!
  const updated: ChatSession = {
    ...current,
    updated_at: new Date().toISOString(),
  }
  const next = [...sessions]
  next.splice(idx, 1)
  next.unshift(updated)
  return next
}

export function setSessionTitle(
  sessions: ChatSession[],
  sessionId: string,
  title: string,
): ChatSession[] {
  const idx = sessions.findIndex((item) => item.id === sessionId)
  if (idx < 0) return sessions
  const updated: ChatSession = {
    ...sessions[idx]!,
    title,
    updated_at: new Date().toISOString(),
  }
  const next = [...sessions]
  next.splice(idx, 1)
  next.unshift(updated)
  return next
}
