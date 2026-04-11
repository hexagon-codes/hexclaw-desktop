import { DEFAULT_SESSION_TITLE } from '@/constants'
import type { ChatMessage } from '@/types'
import type { ChatSession } from '@/types'

export function shouldBlockChatSend(params: {
  initialSessionId: string | null
  pendingSessionIds: Record<string, boolean>
  draftSending: boolean
  isSessionStreaming: (sessionId: string) => boolean
}): boolean {
  const {
    initialSessionId,
    pendingSessionIds,
    draftSending,
    isSessionStreaming,
  } = params

  if (initialSessionId && (pendingSessionIds[initialSessionId] || isSessionStreaming(initialSessionId))) {
    return true
  }
  if (!initialSessionId && draftSending) {
    return true
  }
  return false
}

export function shouldSeedChatAutoTitle(params: {
  hasCustomTitle: boolean
  initialSessionId: string | null
  messages: ChatMessage[]
  sessions: ChatSession[]
  defaultSessionTitle?: string
}): boolean {
  const {
    hasCustomTitle,
    initialSessionId,
    messages,
    sessions,
    defaultSessionTitle = DEFAULT_SESSION_TITLE,
  } = params

  if (hasCustomTitle) return false
  if (!initialSessionId) return messages.length === 0
  if (messages.length !== 0) return false

  return sessions.find((session) => session.id === initialSessionId)?.title === defaultSessionTitle
}
