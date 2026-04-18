import { logger } from '@/utils/logger'
import { DESKTOP_USER_ID } from '@/constants'
import { apiPost, apiGet, apiPatch, apiPut, apiDelete } from './client'
import type { ChatMessage, ChatSession, ChatRequest } from '@/types'

// ─── 会话 API 辅助函数 ─────────────────────────────────
//
// 所有会话/消息相关的后端 API 必须携带 user_id，否则后端
// 无法关联会话归属，导致 "不属于当前用户" 错误。
//
// 这组辅助函数自动注入 user_id，避免每个函数手动传参遗漏。
// 新增会话 API 时请使用这些函数，不要直接调用 apiGet/apiPost。

function sessionGet<T>(url: string, query?: Record<string, unknown>) {
  return apiGet<T>(url, { ...query, user_id: DESKTOP_USER_ID })
}

function sessionPost<T>(url: string, body?: Record<string, unknown>) {
  return apiPost<T>(url, { ...body, user_id: DESKTOP_USER_ID })
}

function sessionPatch<T>(url: string, body?: Record<string, unknown>) {
  return apiPatch<T>(url, { ...body, user_id: DESKTOP_USER_ID })
}

function sessionPut<T>(url: string, body?: Record<string, unknown>) {
  return apiPut<T>(url, { ...body, user_id: DESKTOP_USER_ID })
}

export type { ChatMessage, ChatSession, ChatRequest }
export type { ToolCall } from '@/types'

/** 后端聊天响应 */
export interface BackendChatResponse {
  reply: string
  session_id: string
  tool_calls?: import('@/types').ToolCall[]
  metadata?: Record<string, unknown>
  usage?: {
    /** 后端实际返回 input_tokens (非 OpenAI prompt_tokens)，同时兼容两种命名 */
    input_tokens?: number; output_tokens?: number; total_tokens?: number
    prompt_tokens?: number; completion_tokens?: number
  }
}

export interface ActiveStreamSnapshot {
  request_id: string
  session_id: string
  user_id?: string
  content?: string
  reasoning?: string
  done: boolean
  status: 'pending' | 'streaming' | 'completed' | 'errored' | 'cancelled'
  metadata?: Record<string, string>
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; provider?: string; model?: string; cost?: number }
  tool_calls?: import('@/types').ToolCall[]
  started_at?: string
  updated_at?: string
}

export interface SessionMessageSearchResult {
  message: ChatMessage & { session_id: string }
  session_title: string
  rank?: number
}

export interface SessionTitleSuggestionResponse {
  id: string
  title: string
  updated: boolean
  updated_at: string
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
    requestId?: string
    metadata?: Record<string, string>
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
      request_id: options?.requestId ?? null,
      metadata: options?.metadata || null,
      attachments: options?.attachments || null,
    },
  })

  let result: BackendChatResponse
  try {
    result = JSON.parse(text)
  } catch {
    throw new Error(`Backend returned a non-JSON response: ${text.slice(0, 200)}`)
  }
  logger.debug(`← backend_chat: reply=${(result?.reply ?? '').slice(0, 50)}... session=${result.session_id}`)
  return result
}

/** 兼容旧接口: 发送聊天消息 */
export function sendChat(req: ChatRequest) {
  return sendChatViaBackend(req.message, {
    sessionId: req.session_id,
    provider: req.provider ?? req.provider_id,
    model: req.model,
    temperature: req.temperature,
    maxTokens: req.max_tokens,
    requestId: req.request_id,
    metadata: req.metadata,
  })
}

// ============== Session Fork (D10) ==============

/** 从指定消息处分支对话 */
export function forkSession(sessionId: string, messageId?: string) {
  return sessionPost<{ session: SessionSummary; message: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fork`, {
    message_id: messageId,
  })
}

/** 获取会话的分支列表 */
export function getSessionBranches(sessionId: string) {
  return sessionGet<{ branches: ChatSession[] }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/branches`)
}

// ============== Session Management ==============

/** 会话摘要（列表用） */
export interface SessionSummary {
  id: string
  title: string
  user_id: string
  parent_session_id?: string
  branch_message_id?: string
  created_at: string
  updated_at: string
  message_count?: number
}

/** 获取会话列表 */
export function listSessions(opts?: { limit?: number; offset?: number }) {
  const q: Record<string, unknown> = {}
  if (opts?.limit) q.limit = opts.limit
  if (opts?.offset) q.offset = opts.offset
  return sessionGet<{ sessions: SessionSummary[]; total: number }>('/api/v1/sessions', q)
}

/** 获取单个会话详情 */
export function getSession(sessionId: string) {
  return sessionGet<SessionSummary>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)
}

/** 获取会话消息历史 */
export function listSessionMessages(sessionId: string, opts?: { limit?: number; offset?: number }) {
  const q: Record<string, unknown> = {}
  if (opts?.limit) q.limit = opts.limit
  if (opts?.offset) q.offset = opts.offset
  return sessionGet<{ messages: ChatMessage[]; total: number }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, q)
}

/** 创建会话 */
export function createSession(id: string, title: string) {
  return sessionPost<{ id: string; title: string; created_at: string }>('/api/v1/sessions', { id, title })
}

/** 更新会话标题 */
export function updateSessionTitle(sessionId: string, title: string) {
  return sessionPatch<{ id: string; title: string; updated_at: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}?user_id=${DESKTOP_USER_ID}`, { title })
}

/** 建议更自然的会话标题；若标题已被手动改动，后端会返回 updated=false */
export function suggestSessionTitle(sessionId: string, expectedTitle?: string) {
  return sessionPost<SessionTitleSuggestionResponse>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/suggest-title`, {
    expected_title: expectedTitle,
  })
}

/** 删除会话 */
export function deleteSession(sessionId: string) {
  return apiDelete<{ message: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}?user_id=${DESKTOP_USER_ID}`)
}

/** 跨会话全文搜索消息 */
export function searchMessages(query: string, opts?: { limit?: number; offset?: number }) {
  const q: Record<string, unknown> = { q: query }
  if (opts?.limit) q.limit = opts.limit
  if (opts?.offset) q.offset = opts.offset
  return sessionGet<{ results: SessionMessageSearchResult[]; total: number; query: string }>('/api/v1/messages/search', q)
}

/** 获取当前仍在后台生成的流式请求 */
export function listActiveStreams() {
  return sessionGet<{ streams: ActiveStreamSnapshot[]; total: number }>('/api/v1/streams/active')
}

/** 获取某个流式请求的最新快照 */
export function getActiveStreamSnapshot(requestId: string) {
  return sessionGet<ActiveStreamSnapshot>(`/api/v1/streams/${encodeURIComponent(requestId)}`)
}

/** 删除单条消息 — 必须传 user_id 让后端 getOwnedSession 校验归属，否则 403 */
export function deleteMessage(messageId: string) {
  return apiDelete<{ message: string }>(
    `/api/v1/messages/${encodeURIComponent(messageId)}?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`,
  )
}

/** 追加单条消息到会话（用于图像/视频/语音对话生成模式绕过 chat handler 持久化） */
export interface AppendMessageRequest {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** 附件等结构化信息直接放在 metadata，后端存 metadata 列；传对象即可 */
  metadata?: Record<string, unknown>
  model_name?: string
  parent_id?: string
  request_id?: string
  finish_reason?: string
}

export function appendSessionMessage(sessionId: string, msg: AppendMessageRequest) {
  // user_id 必须放 URL query — 后端 sessionUserIDFromRequest 读 query param；body 里的同名字段是
  // sessionPost 自动注入的兼容字段（不影响后端）。URL query 不能省略。
  return sessionPost<{ id: string; session_id: string }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`,
    msg as unknown as Record<string, unknown>,
  )
}

/**
 * 批量追加消息到会话，后端同一事务内写入。
 * 任一失败整批回滚，避免 user 写入成功但 assistant 失败的数据不一致。
 */
export function appendSessionMessagesBatch(sessionId: string, messages: AppendMessageRequest[]) {
  return sessionPost<{ ids: string[]; session_id: string }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`,
    { messages } as unknown as Record<string, unknown>,
  )
}

export type UserFeedback = '' | 'like' | 'dislike'

/** 更新消息反馈 (like/dislike) */
export function updateMessageFeedback(messageId: string, feedback: UserFeedback) {
  return sessionPut<{ message: string }>(`/api/v1/messages/${encodeURIComponent(messageId)}/feedback`, { feedback })
}
