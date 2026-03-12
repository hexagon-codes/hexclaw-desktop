import { apiGet, apiPost, apiDelete, apiSSE } from './client'
import type { ChatMessage, ChatSession, ChatRequest } from '@/types'

export type { ChatMessage, ChatSession, ChatRequest }
export type { ToolCall } from '@/types'

/** 发送聊天消息 (非流式) */
export function sendChat(req: ChatRequest) {
  return apiPost<{ message: ChatMessage; session_id: string }>('/api/v1/chat', req)
}

/** 发送聊天消息 (SSE 流式) */
export function sendChatStream(req: ChatRequest, signal?: AbortSignal) {
  return apiSSE('/api/v1/chat/stream', req as unknown as Record<string, unknown>, signal)
}

/** 获取会话列表 */
export function getSessions(agentId?: string) {
  const query = agentId ? { agent_id: agentId } : undefined
  return apiGet<{ sessions: ChatSession[] }>('/api/v1/sessions', query)
}

/** 获取会话消息历史 */
export function getSessionMessages(sessionId: string) {
  return apiGet<{ messages: ChatMessage[] }>(`/api/v1/sessions/${sessionId}/messages`)
}

/** 删除会话 */
export function deleteSession(sessionId: string) {
  return apiDelete(`/api/v1/sessions/${sessionId}`)
}
