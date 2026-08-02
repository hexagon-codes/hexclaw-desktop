import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './client'
import { DESKTOP_USER_ID } from '@/constants'
import type { ChatMessage, ChatSession } from '@/types'

export const CHAT_TRANSPORT = 'websocket' as const
export type ChatTransport = typeof CHAT_TRANSPORT
export type UserFeedback = 'like' | 'dislike' | ''

export interface SessionMessageSearchResult {
  message_id?: string
  session_id: string
  session_title?: string
  content: string
  message: ChatMessage & { session_id: string; session_title?: string }
  role?: string
  created_at?: string
  rank?: number
  [key: string]: unknown
}

export interface ActiveStreamSnapshot {
  request_id: string
  session_id: string
  content: string
  reasoning?: string
  metadata?: Record<string, unknown> & {
    assistant_message_id?: string
    assistant_message_aliases?: string[]
    thinking_enabled?: boolean | string
  }
  started_at?: string
  message_content?: ChatMessage['message_content']
  done: boolean
  [key: string]: unknown
}

const userQuery = () => ({ user_id: DESKTOP_USER_ID })
const ownedPath = (path: string) =>
  `${path}${path.includes('?') ? '&' : '?'}user_id=${encodeURIComponent(DESKTOP_USER_ID)}`

export function listSessions(params: { limit?: number; offset?: number } = {}) {
  return apiGet<{ sessions: ChatSession[]; total: number }>('/api/v1/sessions', {
    ...userQuery(),
    ...(params.limit ? { limit: params.limit } : {}),
    ...(params.offset ? { offset: params.offset } : {}),
  })
}

export function getSession(id: string) {
  return apiGet<ChatSession>(`/api/v1/sessions/${encodeURIComponent(id)}`, userQuery())
}

export function createSession(id: string, title: string) {
  return apiPost<ChatSession>(ownedPath('/api/v1/sessions'), {
    id,
    title,
    user_id: DESKTOP_USER_ID,
  })
}

export function updateSessionTitle(id: string, title: string) {
  return apiPatch<ChatSession>(ownedPath(`/api/v1/sessions/${encodeURIComponent(id)}`), {
    title,
    user_id: DESKTOP_USER_ID,
  })
}

export function suggestSessionTitle(id: string, expectedTitle?: string) {
  return apiPost<ChatSession & { updated?: boolean }>(
    ownedPath(`/api/v1/sessions/${encodeURIComponent(id)}/suggest-title`),
    { expected_title: expectedTitle },
  )
}

export function deleteSession(id: string) {
  return apiDelete<{ message: string }>(ownedPath(`/api/v1/sessions/${encodeURIComponent(id)}`))
}

export function forkSession(
  id: string,
  messageId?: string,
  options: { includeMessage?: boolean } = {},
) {
  return apiPost<{ session: ChatSession; message?: string }>(
    ownedPath(`/api/v1/sessions/${encodeURIComponent(id)}/fork`),
    {
      message_id: messageId,
      ...(options.includeMessage === undefined ? {} : { include_message: options.includeMessage }),
      user_id: DESKTOP_USER_ID,
    },
  )
}

export function getSessionBranches(id: string) {
  return apiGet<{ branches: ChatSession[]; total: number }>(
    `/api/v1/sessions/${encodeURIComponent(id)}/branches`,
    userQuery(),
  )
}

export function listSessionMessages(
  id: string,
  params: { limit?: number; offset?: number } = {},
) {
  return apiGet<{ messages: ChatMessage[]; total: number }>(
    `/api/v1/sessions/${encodeURIComponent(id)}/messages`,
    {
      ...userQuery(),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.offset ? { offset: params.offset } : {}),
    },
  )
}

export function searchMessages(query: string, params: { limit?: number; offset?: number } = {}) {
  return apiGet<{ results: SessionMessageSearchResult[]; total: number; query: string }>(
    '/api/v1/messages/search',
    { q: query, ...userQuery(), ...params },
  )
}

export function listActiveStreams() {
  return apiGet<{ streams: ActiveStreamSnapshot[]; total: number }>(
    '/api/v1/streams/active',
    userQuery(),
  )
}

export function getActiveStreamSnapshot(requestId: string) {
  return apiGet<ActiveStreamSnapshot>(
    `/api/v1/streams/${encodeURIComponent(requestId)}`,
    userQuery(),
  )
}

export function deleteMessage(id: string) {
  return apiDelete<{ message: string }>(ownedPath(`/api/v1/messages/${encodeURIComponent(id)}`))
}

export function updateMessageFeedback(id: string, feedback: UserFeedback | string) {
  return apiPut<{ message: string }>(
    ownedPath(`/api/v1/messages/${encodeURIComponent(id)}/feedback`),
    { feedback },
  )
}

export function appendSessionMessage(
  sessionId: string,
  message: Record<string, unknown> & Pick<ChatMessage, 'role' | 'content'> & { id?: string },
) {
  return apiPost<{ message: ChatMessage }>(
    ownedPath(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`),
    { ...message, user_id: DESKTOP_USER_ID },
  )
}

export function appendSessionMessagesBatch(
  sessionId: string,
  messages: Array<Record<string, unknown> & Pick<ChatMessage, 'role' | 'content'> & { id?: string }>,
) {
  return apiPost<{ messages: ChatMessage[] }>(
    ownedPath(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`),
    { messages, user_id: DESKTOP_USER_ID },
  )
}

// Deprecated send names are implemented by a WebSocket-only compatibility
// adapter. Session CRUD above remains ordinary management HTTP, not a second
// assistant-stream protocol.
export * from './chat-websocket-compat'
