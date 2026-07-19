import { logger } from '@/utils/logger'
import { DESKTOP_USER_ID } from '@/constants'
import { apiPost, apiGet, apiPatch, apiPut, apiDelete } from './client'
import type { ChatMessage, ChatSession, ChatRequest } from '@/types'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'

// ─── 会话 API 辅助函数 ─────────────────────────────────
//
// 所有会话/消息相关的后端 API 必须携带 user_id，否则后端
// 无法关联会话归属，导致 "不属于当前用户" 错误。
//
// 这组辅助函数自动注入 user_id，避免每个函数手动传参遗漏。
// 新增会话 API 时请使用这些函数，不要直接调用 apiGet/apiPost。

/**
 * Append `user_id=` to the URL query string unless it is already present.
 *
 * Belt-and-suspenders for the three backend reader categories
 * (api/handler_session.go):
 *   1. query-only   — suggestSessionTitle / updateMessageFeedback handlers
 *   2. query-or-body — handleCreateSession
 *   3. body-only    — handleForkSession (line 547 falls back to "api-user"
 *      when the body lacks user_id)
 * The session* write wrappers therefore inject user_id into BOTH the URL
 * query (covers 1 and 2) and the JSON body (covers 2 and 3), so a future
 * sessionPost against any handler category cannot lose the user identity.
 */
function withUserIdQuery(url: string): string {
  if (/[?&]user_id=/.test(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}user_id=${encodeURIComponent(DESKTOP_USER_ID)}`
}

function sessionGet<T>(url: string, query?: Record<string, unknown>) {
  return apiGet<T>(url, { ...query, user_id: DESKTOP_USER_ID })
}

function sessionPost<T>(url: string, body?: Record<string, unknown>) {
  return apiPost<T>(withUserIdQuery(url), { ...body, user_id: DESKTOP_USER_ID })
}

function sessionPatch<T>(url: string, body?: Record<string, unknown>) {
  return apiPatch<T>(withUserIdQuery(url), { ...body, user_id: DESKTOP_USER_ID })
}

// Completes the write-wrapper family; the structural-guard tests in __tests__
// regex-assert its presence and shape, so it is kept even with no runtime caller yet.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function sessionPut<T>(url: string, body?: Record<string, unknown>) {
  return apiPut<T>(withUserIdQuery(url), { ...body, user_id: DESKTOP_USER_ID })
}

export type { ChatMessage, ChatSession, ChatRequest }
export type { ToolCall } from '@/types'

/** 后端聊天响应 */
export interface BackendChatResponse {
  reply: string
  message_content?: MessageContent
  render_manifest?: RenderManifest
  session_id: string
  tool_calls?: import('@/types').ToolCall[]
  blocks?: import('@/types').ContentBlock[]
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
  blocks?: import('@/types').ContentBlock[]
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
 * 通过 hexclaw 后端发送聊天消息（SSE 流式 — BUG-20260523-v2 架构修复）
 *
 * 走 Rust `backend_chat` 命令 → hexclaw 后端 POST /api/v1/chat（Accept: text/event-stream）
 * 后端处理完整 ReAct Agent 循环（含工具调用、RAG、搜索等）
 *
 * Rust 端会通过 `backend-chat-stream` 事件实时推 chunk；
 * 本函数维持原签名向后兼容（等到 [DONE] 拿到累积 reply 才 resolve），
 * 同时把每个 chunk 输出到 logger 便于排查全链路。
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

  const reqId = options?.requestId || ''
  const t0 = performance.now()
  let chunkCount = 0
  let lastChunkTs = t0

  logger.debug(`→ backend_chat: ${message.slice(0, 50)}... request_id=${reqId} model=${options?.model || ''}`)

  // 监听本次请求的流式事件（按 request_id 过滤；req_id 为空时收所有以便兜底）。
  // vitest 等无 Tauri runtime 环境下 @tauri-apps/api/event 不可用，graceful 退化为"不监听"——
  // 不影响 invoke 主流程，仅失去 chunk 级别日志。
  let unlisten: undefined | (() => void)
  try {
    const { listen } = await import('@tauri-apps/api/event')
    unlisten = await listen<{ request_id: string; event_type: string; data: string }>(
      'backend-chat-stream',
      (evt) => {
        const p = evt.payload
        if (reqId && p.request_id && p.request_id !== reqId && p.request_id !== '(unset)') return

        const now = performance.now()
        const gap = Math.round(now - lastChunkTs)
        lastChunkTs = now

        switch (p.event_type) {
          case 'chunk':
            chunkCount += 1
            logger.debug(`[backend_chat] chunk #${chunkCount} +${gap}ms data_len=${p.data.length}`)
            break
          case 'done':
            logger.debug(`[backend_chat] [DONE] chunks=${chunkCount} elapsed=${Math.round(now - t0)}ms`)
            break
          case 'error':
            logger.error(`[backend_chat] STREAM ERROR chunks=${chunkCount} err=${p.data}`)
            break
        }
      },
    )
  } catch (e) {
    logger.debug(`[backend_chat] event listener 不可用（${(e as Error).message}）— 跳过 chunk 日志`)
  }

  try {
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
    const elapsed = Math.round(performance.now() - t0)
    logger.debug(
      `← backend_chat: reply_len=${(result?.reply ?? '').length} session=${result.session_id} chunks=${chunkCount} elapsed=${elapsed}ms`,
    )
    return result
  } finally {
    unlisten?.()
  }
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
  // user_id must reach the BODY: backend handleForkSession (handler_session.go:547)
  // reads the body only and falls back to "api-user" when it is absent.
  // sessionPost injects user_id into both the body and the URL query.
  return sessionPost<{ session: SessionSummary; message: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fork`, {
    message_id: messageId,
  })
}

/** 获取会话的分支列表
 *  后端 handleListBranches 返回 { branches: []*storage.Session, total }，故声明 total。 */
export function getSessionBranches(sessionId: string) {
  return sessionGet<{ branches: ChatSession[]; total: number }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/branches`)
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
  // sessionPatch appends an encoded user_id= to the URL query and injects it
  // into the body, covering every backend reader category.
  return sessionPatch<{ id: string; title: string; updated_at: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { title })
}

/** 建议更自然的会话标题；若标题已被手动改动，后端会返回 updated=false */
export function suggestSessionTitle(sessionId: string, expectedTitle?: string) {
  // user_id 必须放 URL query — 后端 handleSuggestSessionTitle 用 sessionUserIDFromRequest
  // 只读 query；body 里的同名字段不会被消费（BUG-20260611）。
  return apiPost<SessionTitleSuggestionResponse>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/suggest-title?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`,
    { expected_title: expectedTitle },
  )
}

/** 删除会话 */
export function deleteSession(sessionId: string) {
  return apiDelete<{ message: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`)
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
  // user_id 必须放 URL query — 后端 feedback handler 用 sessionUserIDFromRequest
  // 只读 query；body 里的同名字段不会被消费（BUG-20260611）。
  return apiPut<{ message: string }>(
    `/api/v1/messages/${encodeURIComponent(messageId)}/feedback?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`,
    { feedback },
  )
}
