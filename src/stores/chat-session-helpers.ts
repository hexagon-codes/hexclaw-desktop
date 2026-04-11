import type { ChatSession } from '@/types'

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
