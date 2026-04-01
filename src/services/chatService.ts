/**
 * 聊天发送编排服务
 *
 * 从 ChatStore 提取的 WebSocket/HTTP 发送逻辑。
 * 负责 WebSocket 优先 → HTTP 回退 → Outbox 持久化的完整发送管线。
 * Store 调用本服务发送消息，不直接操作 WebSocket/HTTP。
 */

import { sendChatViaBackend } from '@/api/chat'
import { hexclawWS } from '@/api/websocket'
import { dbOutboxInsert, dbOutboxMarkSending, dbOutboxMarkSent, dbOutboxMarkFailed, dbOutboxGetPending, dbOutboxCleanup } from '@/db/outbox'
import { logger } from '@/utils/logger'
import type { ChatMessage, ChatAttachment } from '@/types'

const WS_FIRST_REPLY_TIMEOUT_MS = 120_000
const WS_INACTIVITY_TIMEOUT_MS = 120_000
const BACKEND_REPLY_TIMEOUT_MS = 120_000

export class ChatRequestError extends Error {
  noFallback: boolean
  constructor(message: string, noFallback = false) {
    super(message)
    this.name = 'ChatRequestError'
    this.noFallback = noFallback
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise
      .then((v) => { clearTimeout(timer); resolve(v) })
      .catch((e) => { clearTimeout(timer); reject(e) })
  })
}

// ─── WebSocket 流式发送 ──────────────────────────────

export interface StreamCallbacks {
  onChunk: (content: string, reasoning?: string) => void
  onDone: (content: string, metadata?: Record<string, unknown>, toolCalls?: ChatMessage['tool_calls'], agentName?: string) => void
  onError: (error: Error) => void
}

export function sendViaWebSocket(
  text: string,
  sessionId: string,
  chatParams: { model?: string; provider?: string; temperature?: number; maxTokens?: number },
  agentRole: string,
  attachments?: ChatAttachment[],
  callbacks?: StreamCallbacks,
  metadata?: Record<string, string>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    hexclawWS.clearCallbacks()

    let settled = false
    let firstReplyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      fail(new ChatRequestError('助手长时间未开始回复，已超时并停止等待。', false))
    }, WS_FIRST_REPLY_TIMEOUT_MS)
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null

    function clearTimers() {
      if (firstReplyTimer) { clearTimeout(firstReplyTimer); firstReplyTimer = null }
      if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null }
    }

    function markActivity() {
      if (firstReplyTimer) { clearTimeout(firstReplyTimer); firstReplyTimer = null }
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        fail(new ChatRequestError('助手回复长时间无新内容，已超时并停止等待。', false))
      }, WS_INACTIVITY_TIMEOUT_MS)
    }

    function fail(err: unknown) {
      if (settled) return
      settled = true
      clearTimers()
      hexclawWS.clearCallbacks()
      reject(err)
    }

    hexclawWS.onChunk((chunk) => {
      markActivity()
      callbacks?.onChunk(chunk.content, chunk.reasoning)
      if (chunk.done && !settled) {
        settled = true
        clearTimers()
        callbacks?.onDone(
          '', // content assembled by caller
          chunk.metadata,
          chunk.tool_calls,
          typeof chunk.metadata?.agent_name === 'string' ? chunk.metadata.agent_name : undefined,
        )
        resolve()
      }
    })

    hexclawWS.onReply((reply) => {
      if (settled) return
      markActivity()
      settled = true
      clearTimers()
      callbacks?.onDone(
        reply.content,
        reply.metadata,
        reply.tool_calls,
        typeof reply.metadata?.agent_name === 'string' ? reply.metadata.agent_name : undefined,
      )
      resolve()
    })

    hexclawWS.onError((errMsg: string) => {
      // 用户主动取消不是错误，直接 resolve 避免 fallback 和错误提示
      if (errMsg === '用户取消') {
        if (settled) return
        settled = true
        clearTimers()
        resolve()
        return
      }
      fail(new ChatRequestError(errMsg || 'WebSocket 请求失败', true))
    })

    const wsAttachments = attachments?.map(a => ({ type: a.type, name: a.name, mime: a.mime, data: a.data }))
    hexclawWS.sendMessage(text, sessionId, chatParams.model, agentRole || undefined, wsAttachments, chatParams.provider, chatParams.temperature, chatParams.maxTokens, metadata)
  })
}

// ─── HTTP 发送 (fallback) ────────────────────────────

export async function sendViaBackend(
  text: string,
  sessionId: string,
  chatParams: { model?: string; provider?: string; temperature?: number; maxTokens?: number },
  agentRole: string,
  attachments?: ChatAttachment[],
): Promise<{ reply: string; metadata?: Record<string, unknown>; tool_calls?: ChatMessage['tool_calls'] }> {
  return withTimeout(
    sendChatViaBackend(text, {
      sessionId,
      role: agentRole || undefined,
      provider: chatParams.provider,
      model: chatParams.model,
      temperature: chatParams.temperature,
      maxTokens: chatParams.maxTokens,
      attachments: attachments?.map(a => ({ type: a.type, name: a.name, mime: a.mime, data: a.data })),
    }),
    BACKEND_REPLY_TIMEOUT_MS,
    '后端长时间未返回结果，已超时并停止等待。',
  )
}

// ─── WebSocket 连接管理 ──────────────────────────────

export async function ensureWebSocketConnected(): Promise<boolean> {
  if (hexclawWS.isConnected()) return true
  try {
    await hexclawWS.connect()
    return true
  } catch (e) {
    logger.warn('WebSocket 连接失败', e)
    return false
  }
}

export function clearWebSocketCallbacks(): void {
  hexclawWS.clearCallbacks()
}

// ─── Outbox 操作 ──────────────────────────────────────

export async function outboxInsert(id: string, sessionId: string, content: string, attachments?: ChatAttachment[]): Promise<void> {
  await dbOutboxInsert({ id, sessionId, content, attachments: attachments?.length ? JSON.stringify(attachments) : '[]' })
}

export async function outboxMarkSending(id: string): Promise<void> { await dbOutboxMarkSending(id) }
export async function outboxMarkSent(id: string): Promise<void> { await dbOutboxMarkSent(id) }
export async function outboxMarkFailed(id: string, error: string): Promise<void> { await dbOutboxMarkFailed(id, error) }

export async function retryPendingOutbox(): Promise<void> {
  try {
    const pending = await dbOutboxGetPending()
    if (pending.length === 0) return
    logger.info(`[outbox] 发现 ${pending.length} 条待发送消息，尝试重试`)
    for (const msg of pending) {
      try {
        await dbOutboxMarkSending(msg.id)
        const result = await sendChatViaBackend(msg.content, { sessionId: msg.sessionId })
        if (result) {
          await dbOutboxMarkSent(msg.id)
          logger.info(`[outbox] 重试成功: ${msg.id}`)
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'retry failed'
        dbOutboxMarkFailed(msg.id, errMsg).catch(() => {})
        logger.warn(`[outbox] 重试失败: ${msg.id}`, e)
      }
    }
  } catch {
    // outbox 表可能不存在（首次运行）
  }
}

export async function cleanupOutbox(): Promise<void> {
  await dbOutboxCleanup().catch(() => {})
}
