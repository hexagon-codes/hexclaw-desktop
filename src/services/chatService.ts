/**
 * 聊天发送编排服务
 *
 * 从 ChatStore 提取的 WebSocket/HTTP 发送逻辑。
 * 负责 WebSocket 优先 → HTTP 回退的完整发送管线。
 * Store 调用本服务发送消息，不直接操作 WebSocket/HTTP。
 *
 * 数据库迁移后：Outbox 改为纯内存实现（sidecar 是本地进程，无需离线队列）。
 */

import { hexclawWS, type ToolApprovalRequest } from '@/api/websocket'
import { NativeSidecarWebSocket } from '@/api/native-sidecar-websocket'
import { logger } from '@/utils/logger'
import { withModelReasoningDefaults } from '@/utils/model-reasoning'
import { DESKTOP_USER_ID, USER_CANCELLED_MESSAGE } from '@/constants'
import type { ChatMessage, ChatAttachment, RuntimeWireFrame, RuntimeWireSnapshot } from '@/types'
import {
  createRuntimeWireSnapshot,
  mergeRuntimeWireFrame,
  normalizeRuntimeSnapshotMetadata,
} from '@/types/chat'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'

// Real cloud models can spend more than two minutes in provider queueing before
// the first chunk or tool approval arrives. Keep the request socket alive long
// enough for that first observable event, otherwise tool approval becomes
// impossible because the UI has already closed the stream.
const WS_FIRST_REPLY_TIMEOUT_MS = 300_000
const WS_INACTIVITY_TIMEOUT_MS = 60_000

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
  onChunk?: (content: string, reasoning?: string, runtimeFrame?: RuntimeWireFrame) => void
  onDone?: (content: string, metadata?: Record<string, unknown>, toolCalls?: ChatMessage['tool_calls'], agentName?: string, messageContent?: MessageContent) => void
  onApprovalRequest?: (request: ToolApprovalRequest) => void
  onSnapshot?: (snapshot: { content: string; reasoning?: string; metadata?: Record<string, unknown>; done?: boolean; messageContent?: MessageContent; runtimeFrame?: RuntimeWireFrame }) => void
  onMemorySaved?: (content: string) => void
}

interface StreamWsServerMessage {
  type: 'chunk' | 'reply' | 'error' | 'pong' | 'tool_approval_request' | 'tool_permission_request' | 'memory_saved' | 'stream_snapshot'
  content: string
  message_content?: MessageContent
  render_manifest?: RenderManifest
  reasoning?: string
  done?: boolean
  session_id?: string
  request_id?: string
  owner_id?: string
  invocation_id?: string
  tool_name?: string
  arguments?: Record<string, unknown>
  arguments_digest?: string
  security_scope_digest?: string
  deadline_at?: string
  usage?: unknown
  tool_calls?: ChatMessage['tool_calls']
  blocks?: ChatMessage['blocks']
  metadata?: Record<string, unknown>
  // U9：后端结构化 RAG/记忆命中（顶层字段，非 metadata 内——后端 Metadata 是 string map）。
  knowledge_hits?: Record<string, unknown>[]
  memory_hits?: Record<string, unknown>[]
  assistant_message_id?: string
  message_id?: string
  sequence?: number
  reasoning_disclosure?: unknown
  runtime_event?: unknown
  runtime_events?: unknown
  last_sequence?: number
}

function runtimeMetadata(
  metadata: Record<string, unknown> | undefined,
  snapshot: RuntimeWireSnapshot,
): Record<string, unknown> | undefined {
  if (
    snapshot.lastSequence === 0
    && !snapshot.assistantMessageId
    && !snapshot.reasoningDisclosure
    && snapshot.runtimeEvents.length === 0
  ) {
    if (!metadata) return undefined
    const legacyMetadata = { ...metadata }
    delete legacyMetadata.reasoning
    delete legacyMetadata.reasoning_disclosure
    return legacyMetadata
  }
  const next = { ...metadata }
  delete next.reasoning
  delete next.reasoning_disclosure
  delete next.runtime_events
  delete next.last_sequence
  delete next.assistant_message_id
  delete next.message_id
  next.reasoning_visibility = snapshot.reasoningDisclosure?.visibility ?? 'not_exposed'
  next.runtime_events = snapshot.runtimeEvents
  next.last_sequence = snapshot.lastSequence
  if (snapshot.reasoningDisclosure) next.reasoning_disclosure = snapshot.reasoningDisclosure
  if (snapshot.assistantMessageId) {
    next.assistant_message_id = snapshot.assistantMessageId
    next.message_id = snapshot.assistantMessageId
  }
  return next
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
  const merged: Record<string, unknown> = { ...metadata }
  if (kh) merged.knowledge_hits = kh
  if (mh) merged.memory_hits = mh
  return merged
}

export interface WebSocketStreamResult {
  content: string
  messageContent?: MessageContent
  metadata?: Record<string, unknown>
  toolCalls?: ChatMessage['tool_calls']
  blocks?: ChatMessage['blocks']
  agentName?: string
}

export interface WebSocketStreamHandle {
  cancel: () => void
  done: Promise<WebSocketStreamResult | null>
}

export interface ToolApprovalDecisionWire {
  request_id: string
  decision_id: string
  invocation_id?: string
  arguments_digest?: string
  security_scope_digest?: string
  decision: 'approved_once' | 'approved_remember' | 'denied'
  idempotency_key: string
  reason?: string
}

export interface ToolApprovalAckWire {
  type: 'tool_approval_ack'
  request_id: string
  decision_id: string
  status: 'accepted' | 'already_accepted' | 'expired' | 'rejected'
}

interface ApprovalAckWaiter {
  socket: NativeSidecarWebSocket
  requestId: string
  resolve: (ack: ToolApprovalAckWire) => void
  reject: (error: Error) => void
}

const approvalAckWaiters = new Map<string, ApprovalAckWaiter>()

function releaseApprovalSocket(socket: NativeSidecarWebSocket, reason: string) {
  for (const [decisionId, waiter] of approvalAckWaiters) {
    if (waiter.socket !== socket) continue
    approvalAckWaiters.delete(decisionId)
    waiter.reject(new Error(reason))
  }
}

function consumeToolApprovalAck(data: Record<string, unknown>): boolean {
  if (data.type !== 'tool_approval_ack') return false
  const decisionId = String(data.decision_id || '')
  const requestId = String(data.request_id || '')
  const status = String(data.status || '')
  const waiter = approvalAckWaiters.get(decisionId)
  if (!waiter || waiter.requestId !== requestId) return true
  if (!['accepted', 'already_accepted', 'expired', 'rejected'].includes(status)) return true
  approvalAckWaiters.delete(decisionId)
  waiter.resolve({
    type: 'tool_approval_ack',
    request_id: requestId,
    decision_id: decisionId,
    status: status as ToolApprovalAckWire['status'],
  })
  return true
}

function sendToolApprovalResponse(
  socket: NativeSidecarWebSocket,
  decision: ToolApprovalDecisionWire,
): Promise<ToolApprovalAckWire> {
  if (socket.readyState !== NativeSidecarWebSocket.OPEN) {
    return Promise.reject(new Error('Owning approval request socket is not connected'))
  }

  return new Promise<ToolApprovalAckWire>((resolve, reject) => {
    approvalAckWaiters.set(decision.decision_id, {
      socket,
      requestId: decision.request_id,
      resolve,
      reject,
    })
    try {
      socket.send(JSON.stringify({
        type: 'tool_approval_response',
        content: decision.decision,
        request_id: decision.request_id,
        decision_id: decision.decision_id,
        invocation_id: decision.invocation_id,
        metadata: {
          request_id: decision.request_id,
          decision_id: decision.decision_id,
          invocation_id: decision.invocation_id,
          decision: decision.decision,
          idempotency_key: decision.idempotency_key,
          arguments_digest: decision.arguments_digest,
          security_scope_digest: decision.security_scope_digest,
        },
      }))
    } catch (error) {
      approvalAckWaiters.delete(decision.decision_id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
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
    let runtimeSnapshot = createRuntimeWireSnapshot()
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

    // BUG-20260718（§15）：按 requestId 分流防串——后端若回填 request_id，则丢弃明确
    // 异源（其它请求）的迟到 chunk/reply；未回填时一律投递（零回归）。
    const streamScope = requestId ? { requestId } : undefined
    hexclawWS.onChunk((chunk) => {
      const merged = mergeRuntimeWireFrame(runtimeSnapshot, chunk, chatParams)
      if (!merged.accepted || (chunk.sequence && !merged.frame)) return
      if (merged.frame) runtimeSnapshot = merged.snapshot
      markActivity()
      if (chunk.content) accumulatedContent += chunk.content
      const publicReasoning = merged.frame?.reasoningDisclosure.visibility === 'visible'
        ? chunk.reasoning
        : undefined
      if (merged.frame?.sequence) callbacks?.onChunk?.(chunk.content, publicReasoning, merged.frame)
      else callbacks?.onChunk?.(chunk.content, publicReasoning)
      if (chunk.done && !settled) {
        settled = true
        clearTimers()
        callbacks?.onDone?.(
          accumulatedContent,
          runtimeMetadata(foldRetrievalHits(chunk.metadata, chunk), runtimeSnapshot),
          chunk.tool_calls,
          typeof chunk.metadata?.agent_name === 'string' ? chunk.metadata.agent_name : undefined,
          chunk.message_content,
        )
        resolve()
      }
    }, streamScope)

    hexclawWS.onReply((reply) => {
      if (settled) return
      const merged = mergeRuntimeWireFrame(runtimeSnapshot, reply, chatParams)
      if (!merged.accepted || (reply.sequence && !merged.frame)) return
      if (merged.frame) runtimeSnapshot = merged.snapshot
      markActivity()
      settled = true
      clearTimers()
      callbacks?.onDone?.(
        reply.content,
        runtimeMetadata(foldRetrievalHits(reply.metadata, reply), runtimeSnapshot),
        reply.tool_calls,
        typeof reply.metadata?.agent_name === 'string' ? reply.metadata.agent_name : undefined,
        reply.message_content,
      )
      resolve()
    }, streamScope)

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
    }, streamScope)

    const wsAttachments = attachments?.map((attachment) => {
      if (!attachment.attachmentId?.trim()) {
        throw new ChatRequestError('Chat attachment is missing its upload receipt', false)
      }
      return { attachment_id: attachment.attachmentId }
    })
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
  route?: { provider?: string; model?: string },
): WebSocketStreamHandle {
  const ws = new NativeSidecarWebSocket('/ws')

  let settled = false
  let accumulatedContent = ''
  let runtimeSnapshot = createRuntimeWireSnapshot()
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
    releaseApprovalSocket(ws, 'Approval request socket closed')
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
      if (
        ws.readyState === NativeSidecarWebSocket.OPEN
        || ws.readyState === NativeSidecarWebSocket.CONNECTING
      ) {
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
      if (
        ws.readyState === NativeSidecarWebSocket.OPEN
        || ws.readyState === NativeSidecarWebSocket.CONNECTING
      ) {
        ws.close()
      }
    } catch {
      // ignore close failures
    }
    rejectDone(err)
  }

  function sendRequestCancel() {
    if (!requestId || ws.readyState !== NativeSidecarWebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'cancel', session_id: sessionId, request_id: requestId }))
    } catch {
      // 取消为尽力而为；发送失败仍须继续收敛本地流状态。
    }
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
      sendRequestCancel()
      settleReject(new ChatRequestError('Assistant reply stalled — no new content received.', false))
    }, WS_INACTIVITY_TIMEOUT_MS)
  }

  firstReplyTimer = setTimeout(() => {
    sendRequestCancel()
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

    if (consumeToolApprovalAck(msg as unknown as Record<string, unknown>)) {
      markActivity()
      return
    }

    switch (msg.type) {
      case 'chunk':
        {
        const merged = mergeRuntimeWireFrame(runtimeSnapshot, msg, route)
        if (!merged.accepted || (msg.sequence && !merged.frame)) break
        if (merged.frame) runtimeSnapshot = merged.snapshot
        markActivity()
        if (msg.content) accumulatedContent += msg.content
        const publicReasoning = merged.frame?.reasoningDisclosure.visibility === 'visible'
          ? msg.reasoning
          : undefined
        if (merged.frame?.sequence) callbacks?.onChunk?.(msg.content, publicReasoning, merged.frame)
        else callbacks?.onChunk?.(msg.content, publicReasoning)
        if (msg.done) {
          settleResolve({
            content: accumulatedContent,
            messageContent: msg.message_content,
            metadata: runtimeMetadata(foldRetrievalHits(msg.metadata, msg), runtimeSnapshot),
            toolCalls: msg.tool_calls,
            blocks: msg.blocks,
            agentName: typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
          })
        }
        break
        }
      case 'stream_snapshot':
        {
        const hasAtomicRuntimeSnapshot = msg.last_sequence !== undefined
          || msg.metadata?.last_sequence !== undefined
          || Array.isArray(msg.runtime_events)
          || Array.isArray(msg.metadata?.runtime_events)
        let runtimeFrame: RuntimeWireFrame | undefined
        if (hasAtomicRuntimeSnapshot) {
          const snapshotMetadata = normalizeRuntimeSnapshotMetadata({
            ...msg.metadata,
            assistant_message_id: msg.assistant_message_id ?? msg.metadata?.assistant_message_id,
            message_id: msg.message_id ?? msg.metadata?.message_id,
            reasoning_disclosure: msg.reasoning_disclosure ?? msg.metadata?.reasoning_disclosure,
            runtime_events: msg.runtime_events ?? msg.metadata?.runtime_events,
            last_sequence: msg.last_sequence ?? msg.metadata?.last_sequence,
          }, undefined, route)
          runtimeSnapshot = {
            assistantMessageId: snapshotMetadata.assistant_message_id,
            aliases: snapshotMetadata.assistant_message_aliases ?? [],
            lastSequence: Number(snapshotMetadata.last_sequence) || 0,
            runtimeEvents: snapshotMetadata.runtime_events ?? [],
            reasoningDisclosure: snapshotMetadata.reasoning_disclosure,
            acceptedFrames: {},
          }
        } else {
          const merged = mergeRuntimeWireFrame(runtimeSnapshot, msg, route)
          if (!merged.accepted || (msg.sequence && !merged.frame)) break
          if (merged.frame) runtimeSnapshot = merged.snapshot
          runtimeFrame = merged.frame
        }
        markActivity()
        const publicReasoning = runtimeSnapshot.reasoningDisclosure?.visibility === 'visible'
          ? msg.reasoning
          : undefined
        callbacks?.onSnapshot?.({
          content: msg.content,
          reasoning: publicReasoning,
          metadata: runtimeMetadata(msg.metadata, runtimeSnapshot),
          done: msg.done,
          messageContent: msg.message_content,
          runtimeFrame,
        })
        if (msg.done) {
          settleResolve({
            content: msg.content,
            messageContent: msg.message_content,
            metadata: runtimeMetadata(foldRetrievalHits(msg.metadata, msg), runtimeSnapshot),
            toolCalls: msg.tool_calls,
            agentName: typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
          })
        }
        break
        }
      case 'reply':
        {
        const merged = mergeRuntimeWireFrame(runtimeSnapshot, msg, route)
        if (!merged.accepted || (msg.sequence && !merged.frame)) break
        if (merged.frame) runtimeSnapshot = merged.snapshot
        markActivity()
        settleResolve({
          content: msg.content,
          messageContent: msg.message_content,
          metadata: runtimeMetadata(foldRetrievalHits(msg.metadata, msg), runtimeSnapshot),
          toolCalls: msg.tool_calls,
          agentName: typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
        })
        break
        }
      case 'error':
        if (msg.content === USER_CANCELLED_MESSAGE) {
          settleResolve(null)
          return
        }
        settleReject(new ChatRequestError(msg.content || 'WebSocket request failed', true))
        break
      case 'tool_approval_request':
      case 'tool_permission_request':
        {
        clearTimers()
        const approvalMessage = msg as unknown as {
          request_id?: unknown
          deadline_at?: unknown
          metadata?: Record<string, unknown>
        }
        const approvalRequestId = typeof approvalMessage.request_id === 'string'
          ? approvalMessage.request_id
          : (typeof approvalMessage.metadata?.request_id === 'string'
              ? approvalMessage.metadata.request_id
              : '')
        const approvalRequest = {
          requestId: approvalRequestId,
          ownerId: typeof msg.owner_id === 'string'
            ? msg.owner_id
            : (typeof msg.metadata?.owner_id === 'string' ? msg.metadata.owner_id : undefined),
          invocationId: typeof msg.invocation_id === 'string'
            ? msg.invocation_id
            : (typeof msg.metadata?.invocation_id === 'string' ? msg.metadata.invocation_id : undefined),
          toolName: typeof msg.tool_name === 'string'
            ? msg.tool_name
            : (typeof msg.metadata?.tool_name === 'string' ? msg.metadata.tool_name : ''),
          arguments: msg.arguments,
          argumentsDigest: typeof msg.arguments_digest === 'string'
            ? msg.arguments_digest
            : (typeof msg.metadata?.arguments_digest === 'string'
                ? msg.metadata.arguments_digest
                : undefined),
          securityScopeDigest: typeof msg.security_scope_digest === 'string'
            ? msg.security_scope_digest
            : (typeof msg.metadata?.security_scope_digest === 'string'
                ? msg.metadata.security_scope_digest
                : undefined),
          risk: typeof msg.metadata?.risk === 'string' ? msg.metadata.risk : 'sensitive',
          reason: msg.content || '',
          sessionId: msg.session_id || sessionId,
          deadlineAt: typeof approvalMessage.deadline_at === 'string'
            ? approvalMessage.deadline_at
            : (typeof approvalMessage.metadata?.deadline_at === 'string'
                ? approvalMessage.metadata.deadline_at
                : undefined),
          respondApproval: (decision: ToolApprovalDecisionWire) =>
            sendToolApprovalResponse(ws, decision),
        }
        callbacks?.onApprovalRequest?.(approvalRequest)
        break
        }
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
      sendRequestCancel()
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
  const wsAttachments = attachments?.map((attachment) => {
    if (!attachment.attachmentId?.trim()) {
      throw new ChatRequestError('Chat attachment is missing its upload receipt', false)
    }
    return { attachment_id: attachment.attachmentId }
  })
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
  }), chatParams)
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

export * from './chat-service-compat'
