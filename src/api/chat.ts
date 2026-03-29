import { logger } from '@/utils/logger'
import { DESKTOP_USER_ID } from '@/constants'
import type { ChatMessage, ChatSession, ChatRequest } from '@/types'

export type { ChatMessage, ChatSession, ChatRequest }
export type { ToolCall } from '@/types'

/** 后端聊天响应 */
export interface BackendChatResponse {
  reply: string
  session_id: string
  tool_calls?: import('@/types').ToolCall[]
  metadata?: Record<string, unknown>
}

/**
 * 通过 hexclaw 后端发送聊天消息
 *
 * 走 Rust `backend_chat` 命令 → hexclaw 后端 POST /api/v1/chat
 * 后端处理完整 ReAct Agent 循环（含工具调用、RAG、搜索等）
 */
export async function sendChatViaBackend(
  message: string,
  options?: {
    sessionId?: string
    role?: string
    provider?: string
    model?: string
    temperature?: number
    maxTokens?: number
    attachments?: { type: string; name: string; mime: string; data: string }[]
  },
): Promise<BackendChatResponse> {
  const { invoke } = await import('@tauri-apps/api/core')

  logger.debug(`→ backend_chat: ${message.slice(0, 50)}...`)

  const text = await invoke<string>('backend_chat', {
    params: {
      message,
      session_id: options?.sessionId || null,
      role: options?.role || null,
      provider: options?.provider || null,
      user_id: DESKTOP_USER_ID,
      model: options?.model || null,
      temperature: options?.temperature ?? null,
      max_tokens: options?.maxTokens ?? null,
      attachments: options?.attachments || null,
    },
  })

  let result: BackendChatResponse
  try {
    result = JSON.parse(text)
  } catch {
    throw new Error(`后端返回非 JSON 响应: ${text.slice(0, 200)}`)
  }
  logger.debug(`← backend_chat: reply=${result.reply.slice(0, 50)}... session=${result.session_id}`)
  return result
}

/** 兼容旧接口: 发送聊天消息 */
export function sendChat(req: ChatRequest) {
  return sendChatViaBackend(req.message, {
    sessionId: req.session_id,
    provider: req.provider ?? req.provider_id,
    model: req.model,
  })
}

/**
 * 通过 Tauri Rust 端代理流式聊天请求（直连 LLM Provider，绕过 CORS）
 * 保留用于未来直连模式或后端不可用时的降级方案
 */
export async function sendStreamViaTauri(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  params: { temperature?: number; max_tokens?: number },
  onChunk: (data: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): Promise<{ requestId: string; unlisten: () => void }> {
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  const { nanoid } = await import('nanoid')

  const requestId = nanoid(12)

  logger.debug(`→ stream_chat request_id=${requestId} model=${model}`)

  const unlisten = await listen<{ request_id: string; event_type: string; data: string }>(
    'chat-stream',
    (event) => {
      if (event.payload.request_id !== requestId) return

      switch (event.payload.event_type) {
        case 'chunk':
          onChunk(event.payload.data)
          break
        case 'done':
          onDone()
          break
        case 'error':
          onError(event.payload.data)
          break
      }
    },
  )

  invoke('stream_chat', {
    params: {
      base_url: baseUrl,
      api_key: apiKey,
      model,
      messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 4096,
      request_id: requestId,
    },
  }).catch((err) => {
    onError(typeof err === 'string' ? err : (err instanceof Error ? err.message : '请求失败'))
  })

  return { requestId, unlisten }
}

// ============== Session Fork (D10) ==============

import { apiPost, apiGet } from './client'

/** 从指定消息处分支对话 */
export function forkSession(sessionId: string, messageId?: string) {
  return apiPost<{ session_id: string; message: string }>(`/api/v1/sessions/${sessionId}/fork`, {
    message_id: messageId,
  })
}

/** 获取会话的分支列表 */
export function getSessionBranches(sessionId: string) {
  return apiGet<{ branches: ChatSession[] }>(`/api/v1/sessions/${sessionId}/branches`)
}

// ============== Session Management ==============

import { apiDelete } from './client'

/** 会话摘要（列表用） */
export interface SessionSummary {
  id: string
  title: string
  user_id: string
  parent_id?: string
  fork_message_id?: string
  created_at: string
  updated_at: string
  message_count?: number
}

/** 获取会话列表 */
export function listSessions(opts?: { limit?: number; offset?: number }) {
  const q: Record<string, unknown> = { user_id: DESKTOP_USER_ID }
  if (opts?.limit) q.limit = opts.limit
  if (opts?.offset) q.offset = opts.offset
  return apiGet<{ sessions: SessionSummary[]; total: number }>('/api/v1/sessions', q)
}

/** 获取单个会话详情 */
export function getSession(sessionId: string) {
  return apiGet<SessionSummary>(`/api/v1/sessions/${sessionId}`)
}

/** 获取会话消息历史 */
export function listSessionMessages(sessionId: string, opts?: { limit?: number; offset?: number }) {
  const q: Record<string, unknown> = {}
  if (opts?.limit) q.limit = opts.limit
  if (opts?.offset) q.offset = opts.offset
  return apiGet<{ messages: ChatMessage[]; total: number }>(`/api/v1/sessions/${sessionId}/messages`, q)
}

/** 删除会话 */
export function deleteSession(sessionId: string) {
  return apiDelete<{ message: string }>(`/api/v1/sessions/${sessionId}`)
}

/** 跨会话全文搜索消息 */
export function searchMessages(query: string, opts?: { limit?: number; offset?: number }) {
  const q: Record<string, unknown> = { q: query, user_id: DESKTOP_USER_ID }
  if (opts?.limit) q.limit = opts.limit
  if (opts?.offset) q.offset = opts.offset
  return apiGet<{ results: Array<ChatMessage & { session_id: string; score?: number }>; total: number; query: string }>('/api/v1/messages/search', q)
}

/** 更新消息反馈 (like/dislike) */
export function updateMessageFeedback(messageId: string, feedback: 'like' | 'dislike' | '') {
  return import('./client').then(({ apiPut }) =>
    apiPut<{ message: string }>(`/api/v1/messages/${messageId}/feedback`, { feedback }),
  )
}
