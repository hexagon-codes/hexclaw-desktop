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
import { hexclawWS, type ToolApprovalRequest } from '@/api/websocket'
import { env } from '@/config/env'
import { logger } from '@/utils/logger'
import { withModelReasoningDefaults } from '@/utils/model-reasoning'
import { DESKTOP_USER_ID, USER_CANCELLED_MESSAGE } from '@/constants'
import type { ChatMessage, ChatAttachment } from '@/types'

// Real cloud models can spend more than two minutes in provider queueing before
// the first chunk or tool approval arrives. Keep the request socket alive long
// enough for that first observable event, otherwise tool approval becomes
// impossible because the UI has already closed the stream.
const WS_FIRST_REPLY_TIMEOUT_MS = 300_000
const WS_INACTIVITY_TIMEOUT_MS = 300_000
const BACKEND_REPLY_TIMEOUT_MS = 300_000

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
  onChunk?: (content: string, reasoning?: string) => void
  onDone?: (content: string, metadata?: Record<string, unknown>, toolCalls?: ChatMessage['tool_calls'], agentName?: string) => void
  onApprovalRequest?: (request: ToolApprovalRequest) => void
  onSnapshot?: (snapshot: { content: string; reasoning?: string; metadata?: Record<string, unknown>; done?: boolean }) => void
  onMemorySaved?: (content: string) => void
}

interface StreamWsServerMessage {
  type: 'chunk' | 'reply' | 'error' | 'pong' | 'tool_approval_request' | 'memory_saved' | 'stream_snapshot'
  content: string
  reasoning?: string
  done?: boolean
  session_id?: string
  request_id?: string
  usage?: unknown
  tool_calls?: ChatMessage['tool_calls']
  blocks?: ChatMessage['blocks']
  metadata?: Record<string, unknown>
  // U9：后端结构化 RAG/记忆命中（顶层字段，非 metadata 内——后端 Metadata 是 string map）。
  knowledge_hits?: Record<string, unknown>[]
  memory_hits?: Record<string, unknown>[]
}

// U9 契约对齐：后端把 RAG/记忆命中作为 done chunk / reply 的**顶层**结构化数组回传
// （knowledge_hits / memory_hits），因为后端 Metadata 是 map[string]string、无法承载
// 对象数组。前端 ChatView 从 msg.metadata.knowledge_hits 消费（normalizeHitList 要对象
// 数组渲染标签+详情）。这里在 service 层把顶层命中折叠进 metadata，让既有 ChatView 与
// chat-* store 无需改动即可透传——契约锚点：字段名/形状两端一致（doc_title/source/content）。
function foldRetrievalHits(
  metadata: Record<string, unknown> | undefined,
  source: { knowledge_hits?: unknown; memory_hits?: unknown },
): Record<string, unknown> | undefined {
  const kh = Array.isArray(source.knowledge_hits) && source.knowledge_hits.length > 0 ? source.knowledge_hits : undefined
  const mh = Array.isArray(source.memory_hits) && source.memory_hits.length > 0 ? source.memory_hits : undefined
  if (!kh && !mh) return metadata
  const merged: Record<string, unknown> = { ...(metadata ?? {}) }
  if (kh) merged.knowledge_hits = kh
  if (mh) merged.memory_hits = mh
  return merged
}

export interface WebSocketStreamResult {
  content: string
  metadata?: Record<string, unknown>
  toolCalls?: ChatMessage['tool_calls']
  blocks?: ChatMessage['blocks']
  agentName?: string
}

export interface WebSocketStreamHandle {
  cancel: () => void
  done: Promise<WebSocketStreamResult | null>
}

export function sendViaWebSocket(
  text: string,
  sessionId: string,
  chatParams: { model?: string; provider?: string; temperature?: number; maxTokens?: number },
  agentRole: string,
  attachments?: ChatAttachment[],
  callbacks?: StreamCallbacks,
  metadata?: Record<string, string>,
  requestId?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    hexclawWS.clearStreamCallbacks()

    let settled = false
    let accumulatedContent = ''
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
      if (chunk.content) accumulatedContent += chunk.content
      callbacks?.onChunk?.(chunk.content, chunk.reasoning)
      if (chunk.done && !settled) {
        settled = true
        clearTimers()
        callbacks?.onDone?.(
          accumulatedContent,
          foldRetrievalHits(chunk.metadata, chunk),
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
      callbacks?.onDone?.(
        reply.content,
        foldRetrievalHits(reply.metadata, reply),
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
    hexclawWS.sendMessage(
      text,
      sessionId,
      chatParams.model,
      agentRole || undefined,
      wsAttachments,
      chatParams.provider,
      chatParams.temperature,
      chatParams.maxTokens,
      withModelReasoningDefaults(chatParams.model, metadata),
      requestId,
    )
  })
}

function openRequestSocket(
  sessionId: string,
  requestId: string | undefined,
  callbacks: StreamCallbacks | undefined,
  buildPayload: () => Record<string, unknown>,
): WebSocketStreamHandle {
  const url = `${env.wsBase}/ws`
  const ws = new WebSocket(url)

  let settled = false
  let accumulatedContent = ''
  let firstReplyTimer: ReturnType<typeof setTimeout> | null = null
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null
  let resolveDone!: (value: WebSocketStreamResult | null) => void
  let rejectDone!: (reason?: unknown) => void

  const done = new Promise<WebSocketStreamResult | null>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  function clearTimers() {
    if (firstReplyTimer) {
      clearTimeout(firstReplyTimer)
      firstReplyTimer = null
    }
    if (inactivityTimer) {
      clearTimeout(inactivityTimer)
      inactivityTimer = null
    }
  }

  function cleanup() {
    clearTimers()
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
  }

  function settleResolve(value: WebSocketStreamResult | null) {
    if (settled) return
    settled = true
    cleanup()
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    } catch {
      // ignore close failures
    }
    resolveDone(value)
  }

  function settleReject(err: unknown) {
    if (settled) return
    settled = true
    cleanup()
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    } catch {
      // ignore close failures
    }
    rejectDone(err)
  }

  function markActivity() {
    if (firstReplyTimer) {
      clearTimeout(firstReplyTimer)
      firstReplyTimer = null
    }
    if (inactivityTimer) {
      clearTimeout(inactivityTimer)
    }
    inactivityTimer = setTimeout(() => {
      settleReject(new ChatRequestError('Assistant reply stalled — no new content received.', false))
    }, WS_INACTIVITY_TIMEOUT_MS)
  }

  firstReplyTimer = setTimeout(() => {
    settleReject(new ChatRequestError('Assistant reply timed out — no response received.', false))
  }, WS_FIRST_REPLY_TIMEOUT_MS)

  ws.onopen = () => {
    ws.send(JSON.stringify(buildPayload()))
  }

  ws.onmessage = (event: MessageEvent<string>) => {
    let msg: StreamWsServerMessage
    try {
      msg = JSON.parse(event.data)
    } catch {
      logger.warn('Request WebSocket received non-JSON message', event.data)
      return
    }

    switch (msg.type) {
      case 'chunk':
        markActivity()
        if (msg.content) accumulatedContent += msg.content
        callbacks?.onChunk?.(msg.content, msg.reasoning)
        if (msg.done) {
          settleResolve({
            content: accumulatedContent,
            metadata: foldRetrievalHits(msg.metadata, msg),
            toolCalls: msg.tool_calls,
            blocks: msg.blocks,
            agentName: typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
          })
        }
        break
      case 'stream_snapshot':
        markActivity()
        callbacks?.onSnapshot?.({
          content: msg.content,
          reasoning: msg.reasoning,
          metadata: msg.metadata,
          done: msg.done,
        })
        if (msg.done) {
          settleResolve({
            content: msg.content,
            metadata: foldRetrievalHits(msg.metadata, msg),
            toolCalls: msg.tool_calls,
            agentName: typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
          })
        }
        break
      case 'reply':
        markActivity()
        settleResolve({
          content: msg.content,
          metadata: foldRetrievalHits(msg.metadata, msg),
          toolCalls: msg.tool_calls,
          agentName: typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
        })
        break
      case 'error':
        if (msg.content === USER_CANCELLED_MESSAGE) {
          settleResolve(null)
          return
        }
        settleReject(new ChatRequestError(msg.content || 'WebSocket request failed', true))
        break
      case 'tool_approval_request':
        callbacks?.onApprovalRequest?.({
          requestId: typeof msg.request_id === 'string'
            ? msg.request_id
            : (typeof msg.metadata?.request_id === 'string' ? msg.metadata.request_id : ''),
          toolName: typeof msg.metadata?.tool_name === 'string' ? msg.metadata.tool_name : '',
          risk: typeof msg.metadata?.risk === 'string' ? msg.metadata.risk : 'sensitive',
          reason: msg.content || '',
          sessionId: msg.session_id || sessionId,
        })
        break
      case 'memory_saved':
        callbacks?.onMemorySaved?.(msg.content)
        break
      case 'pong':
        break
      default:
        logger.warn('Request WebSocket unknown message type', msg)
    }
  }

  ws.onerror = () => {
    settleReject(new ChatRequestError('WebSocket connection failed', false))
  }

  ws.onclose = () => {
    if (!settled) {
      settleReject(new ChatRequestError('WebSocket connection lost', false))
    }
  }

  return {
    cancel() {
      if (settled) return
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'cancel', session_id: sessionId, request_id: requestId }))
        }
      } catch {
        // ignore best-effort cancel failures
      }
      settleResolve(null)
    },
    done,
  }
}

export function openWebSocketStream(
  text: string,
  sessionId: string,
  chatParams: { model?: string; provider?: string; temperature?: number; maxTokens?: number },
  agentRole: string,
  attachments?: ChatAttachment[],
  callbacks?: StreamCallbacks,
  metadata?: Record<string, string>,
  requestId?: string,
): WebSocketStreamHandle {
  const wsAttachments = attachments?.map((a) => ({ type: a.type, name: a.name, mime: a.mime, data: a.data }))
  const resolvedMetadata = withModelReasoningDefaults(chatParams.model, metadata)
  return openRequestSocket(sessionId, requestId, callbacks, () => ({
    type: 'message',
    content: text,
    request_id: requestId,
    session_id: sessionId,
    user_id: DESKTOP_USER_ID,
    provider: chatParams.provider,
    model: chatParams.model,
    role: agentRole || undefined,
    attachments: wsAttachments,
    temperature: chatParams.temperature,
    max_tokens: chatParams.maxTokens,
    metadata: resolvedMetadata,
  }))
}

export function resumeWebSocketStream(
  sessionId: string,
  requestId: string,
  callbacks?: StreamCallbacks,
): WebSocketStreamHandle {
  return openRequestSocket(sessionId, requestId, callbacks, () => ({
    type: 'resume',
    session_id: sessionId,
    request_id: requestId,
    user_id: DESKTOP_USER_ID,
  }))
}

// ─── HTTP 发送 (fallback) ────────────────────────────

export async function sendViaBackend(
  text: string,
  sessionId: string,
  chatParams: { model?: string; provider?: string; temperature?: number; maxTokens?: number },
  agentRole: string,
  attachments?: ChatAttachment[],
  metadata?: Record<string, string>,
  requestId?: string,
): Promise<{ reply: string; metadata?: Record<string, unknown>; tool_calls?: ChatMessage['tool_calls']; blocks?: ChatMessage['blocks'] }> {
  return withTimeout(
    sendChatViaBackend(text, {
      sessionId,
      role: agentRole || undefined,
      provider: chatParams.provider,
      model: chatParams.model,
      temperature: chatParams.temperature,
      maxTokens: chatParams.maxTokens,
      requestId,
      metadata: withModelReasoningDefaults(chatParams.model, metadata),
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
