/**
 * 聊天发送编排服务
 *
 * 从 ChatStore 提取的 WebSocket/HTTP 发送逻辑。
 * 负责 WebSocket 优先 → HTTP 回退的完整发送管线。
 * Store 调用本服务发送消息，不直接操作 WebSocket/HTTP。
 *
 * 数据库迁移后：Outbox 改为纯内存实现（sidecar 是本地进程，无需离线队列）。
 */

import { sendChatViaBackend } from '@/api/chat'
import { hexclawWS } from '@/api/websocket'
import { logger } from '@/utils/logger'
import { USER_CANCELLED_MESSAGE } from '@/constants'
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
    hexclawWS.clearStreamCallbacks()

    let settled = false
    let firstReplyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      fail(new ChatRequestError('Assistant reply timed out — no response received.', false))
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
        fail(new ChatRequestError('Assistant reply stalled — no new content received.', false))
      }, WS_INACTIVITY_TIMEOUT_MS)
    }

    function fail(err: unknown) {
      if (settled) return
      settled = true
      clearTimers()
      hexclawWS.clearStreamCallbacks()
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
      // User-initiated cancellation should not trigger fallback or surface as an error.
      if (errMsg === USER_CANCELLED_MESSAGE) {
        if (settled) return
        settled = true
        clearTimers()
        resolve()
        return
      }
      fail(new ChatRequestError(errMsg || 'WebSocket request failed', true))
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
    'Backend request timed out — no response received.',
  )
}

// ─── WebSocket 连接管理 ──────────────────────────────

export async function ensureWebSocketConnected(): Promise<boolean> {
  if (hexclawWS.isConnected()) return true
  try {
    await hexclawWS.connect()
    return true
  } catch (e) {
    logger.warn('WebSocket connect failed', e)
    return false
  }
}

export function clearWebSocketCallbacks(): void {
  hexclawWS.clearStreamCallbacks()
}
