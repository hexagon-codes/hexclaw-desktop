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
import { INPUT_LIMITS, inputLimitError } from '@/utils/input-limits'
import { withModelReasoningDefaults } from '@/utils/model-reasoning'
import { DESKTOP_USER_ID, USER_CANCELLED_MESSAGE } from '@/constants'
import type { ChatMessage, ChatAttachment, RuntimeWireFrame, RuntimeWireSnapshot } from '@/types'
import {
  createRuntimeWireSnapshot,
  mergeRuntimeWireFrame,
  mergeReasoningReceipt,
  parseReasoningReceipt,
  normalizeRuntimeSnapshotMetadata,
  type ReasoningRequest,
} from '@/types/chat'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'
import { normalizeMessageAttachmentSources } from '@/utils/chat-compose'
import { backendScopeKey } from './backend-context'
import type { ActiveStreamSnapshot } from '@/api/chat'

// Real cloud models can spend more than two minutes in provider queueing before
// the first chunk or tool approval arrives. Keep the request socket alive long
// enough for that first observable event, otherwise tool approval becomes
// impossible because the UI has already closed the stream.
const WS_FIRST_REPLY_TIMEOUT_MS = 300_000
const WS_INACTIVITY_TIMEOUT_MS = 60_000

export class ChatRequestError extends Error {
  noFallback: boolean
  /** 用户已请求停止后连接中断；此时后台终态未知，不能写成业务失败。 */
  stopRequested: boolean
  readonly result?: WebSocketStreamResult
  readonly data?: StreamWsServerMessage | ActiveStreamSnapshot
  constructor(message: string, noFallback = false, result?: WebSocketStreamResult, data?: StreamWsServerMessage | ActiveStreamSnapshot) {
    super(message)
    this.name = 'ChatRequestError'
    this.noFallback = noFallback
    this.stopRequested = false
    // 回执供请求归约读取，不把正文和文件载荷带入通用错误枚举日志。
    Object.defineProperties(this, {
      result: { value: result, enumerable: false },
      data: { value: data, enumerable: false },
    })
  }
}

export class ChatPayloadLimitError extends ChatRequestError {
  constructor(message: string, readonly sessionId: string) {
    super(message, true)
    this.name = 'ChatPayloadLimitError'
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise
      .then((v) => {
        clearTimeout(timer)
        resolve(v)
      })
      .catch((e) => {
        clearTimeout(timer)
        reject(e)
      })
  })
}

// ─── WebSocket 流式发送 ──────────────────────────────

export interface StreamCallbacks {
  onPayloadRejected?: (error: ChatPayloadLimitError) => void
  onChunk?: (content: string, reasoning?: string, runtimeFrame?: RuntimeWireFrame) => void
  onDone?: (
    content: string,
    metadata?: Record<string, unknown>,
    toolCalls?: ChatMessage['tool_calls'],
    agentName?: string,
    messageContent?: MessageContent,
  ) => void
  onApprovalRequest?: (request: ToolApprovalRequest) => void
  onSnapshot?: (snapshot: {
    content: string
    reasoning?: string
    metadata?: Record<string, unknown>
    done?: boolean
    messageContent?: MessageContent
    renderManifest?: RenderManifest
    runtimeFrame?: RuntimeWireFrame
    blocks?: ChatMessage['blocks']
    toolCalls?: ChatMessage['tool_calls']
  }) => void
  onMemorySaved?: (content: string) => void
}

interface StreamWsServerMessage {
  type:
    | 'chunk'
    | 'reply'
    | 'error'
    | 'pong'
    | 'tool_approval_request'
    | 'tool_permission_request'
    | 'tool_approval_terminal'
    | 'memory_saved'
    | 'stream_snapshot'
  content: string
  message_content?: MessageContent
  render_manifest?: RenderManifest
  reasoning?: string
  done?: boolean
  code?: string
  retryable?: boolean
  status?: string
  session_id?: string
  request_id?: string
  owner_id?: string
  invocation_id?: string
  tool_name?: string
  arguments?: Record<string, unknown>
  arguments_digest?: string
  security_scope_digest?: string
  scope_schema_version?: number
  terminal_result?: string
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
  reasoning_receipt?: unknown
  runtime_event?: unknown
  runtime_events?: unknown
  last_sequence?: number
}

function runtimeMetadata(
  metadata: Record<string, unknown> | undefined,
  snapshot: RuntimeWireSnapshot,
): Record<string, unknown> | undefined {
  const next = { ...metadata }
  delete next.reasoning
  delete next.reasoning_disclosure
  delete next.reasoning_receipt
  delete next.runtime_events
  delete next.last_sequence
  delete next.assistant_message_id
  delete next.message_id
  next.reasoning_visibility = snapshot.reasoningDisclosure?.visibility ?? 'not_exposed'
  next.runtime_events = snapshot.runtimeEvents
  next.last_sequence = snapshot.lastSequence
  next.reasoning_receipt = snapshot.reasoningReceipt
  if (snapshot.reasoningDisclosure) next.reasoning_disclosure = snapshot.reasoningDisclosure
  if (snapshot.assistantMessageId) {
    next.assistant_message_id = snapshot.assistantMessageId
    next.message_id = snapshot.assistantMessageId
  }
  return normalizeMessageAttachmentSources(next)
}

function reasoningRequestFromMetadata(
  metadata: Record<string, string> | undefined,
): ReasoningRequest | null {
  const value = metadata?.thinking ?? metadata?.thinking_enabled
  if (value === 'on' || value === 'true' || value === '1') return 'on'
  if (value === 'off' || value === 'false' || value === '0') return 'off'
  return null
}

/** 缺省控制请求仅由已接纳的完整回执确定，未知占位不能锁定期望。 */
function parseReasoningReceiptWithFacts(value: unknown) {
  const receipt = parseReasoningReceipt(value)
  return receipt && (receipt.reasoning_support !== 'unknown' || receipt.reasoning_execution !== 'unknown')
    ? receipt
    : undefined
}

function mergeRuntimeFrameWithExpectation(
  current: RuntimeWireSnapshot,
  raw: unknown,
  route: { provider?: string; model?: string } | undefined,
  expectedReasoningRequest: ReasoningRequest | null,
) {
  const merged = mergeRuntimeWireFrame(current, raw, route, expectedReasoningRequest)
  const receipt = merged.accepted && merged.frame && merged.frame.sequence > 0 &&
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? parseReasoningReceiptWithFacts((raw as Record<string, unknown>).reasoning_receipt)
    : undefined
  return {
    ...merged,
    expectedReasoningRequest: expectedReasoningRequest ?? receipt?.reasoning_request ?? null,
  }
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
  const kh =
    Array.isArray(source.knowledge_hits) && source.knowledge_hits.length > 0
      ? source.knowledge_hits
      : undefined
  const mh =
    Array.isArray(source.memory_hits) && source.memory_hits.length > 0
      ? source.memory_hits
      : undefined
  if (!kh && !mh) return metadata
  const merged: Record<string, unknown> = { ...metadata }
  if (kh) merged.knowledge_hits = kh
  if (mh) merged.memory_hits = mh
  return merged
}

export interface WebSocketStreamResult {
  content: string
  messageContent?: MessageContent
  renderManifest?: RenderManifest
  metadata?: Record<string, unknown>
  toolCalls?: ChatMessage['tool_calls']
  blocks?: ChatMessage['blocks']
  agentName?: string
  terminalState?: 'completed' | 'failed' | 'cancelled'
}

/** 错误文字属于失败原因，正文与产物只取同次请求的已观察结果。 */
function projectErrorResult(
  msg: StreamWsServerMessage,
  accumulatedContent: string,
  snapshot: RuntimeWireSnapshot,
): WebSocketStreamResult {
  const terminal = snapshot.runtimeEvents[snapshot.runtimeEvents.length - 1]?.terminal_status
  const terminalState = terminal === 'cancelled' || msg.status === 'cancelled'
    || msg.metadata?.thinking_state === 'cancelled' || msg.content === USER_CANCELLED_MESSAGE
    ? 'cancelled' : 'failed'
  return {
    content: msg.message_content?.markdown ?? accumulatedContent,
    messageContent: msg.message_content,
    renderManifest: msg.render_manifest,
    metadata: runtimeMetadata(foldRetrievalHits({
      ...msg.metadata,
      thinking_state: terminalState,
      ...(msg.session_id ? { session_id: msg.session_id } : {}),
      ...(msg.request_id ? { request_id: msg.request_id } : {}),
    }, msg), snapshot),
    toolCalls: msg.tool_calls,
    blocks: msg.blocks,
    agentName: typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
    terminalState,
  }
}

export interface WebSocketStreamHandle {
  cancel: () => void
  /** 结束本地观察，不取消后端已接纳的任务。 */
  dispose?: () => void
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

export interface ToolApprovalResponseIdentity {
  requestId: string
  sessionId: string
  ownerId?: string
  invocationId?: string
  argumentsDigest?: string
  securityScopeDigest?: string
  scopeSchemaVersion?: number
  deadlineAt?: string
}

export function createToolApprovalResponseWire(
  decision: ToolApprovalDecisionWire,
  identity: ToolApprovalResponseIdentity,
): Record<string, unknown> {
  return {
    type: 'tool_approval_response',
    content: decision.decision,
    request_id: identity.requestId,
    session_id: identity.sessionId,
    owner_id: identity.ownerId,
    decision_id: decision.decision_id,
    invocation_id: identity.invocationId,
    arguments_digest: identity.argumentsDigest,
    security_scope_digest: identity.securityScopeDigest,
    scope_schema_version: identity.scopeSchemaVersion,
    deadline_at: identity.deadlineAt,
    metadata: {
      request_id: identity.requestId,
      session_id: identity.sessionId,
      owner_id: identity.ownerId,
      decision_id: decision.decision_id,
      invocation_id: identity.invocationId,
      decision: decision.decision,
      idempotency_key: decision.idempotency_key,
      arguments_digest: identity.argumentsDigest,
      security_scope_digest: identity.securityScopeDigest,
      scope_schema_version: identity.scopeSchemaVersion?.toString(),
      deadline_at: identity.deadlineAt,
    },
  }
}

export interface ToolApprovalAckWire {
  type: 'tool_approval_ack'
  request_id: string
  session_id: string
  owner_id: string
  invocation_id: string
  arguments_digest: string
  security_scope_digest: string
  scope_schema_version: number
  decision_id: string
  decision: 'approved_once' | 'approved_remember' | 'denied'
  idempotency_key: string
  status: 'accepted' | 'already_accepted'
}

export interface ToolApprovalTerminalWire {
  type: 'tool_approval_terminal'
  request_id: string
  session_id: string
  owner_id: string
  invocation_id: string
  arguments_digest: string
  security_scope_digest: string
  scope_schema_version: number
  terminal_result: 'expired' | 'fenced'
  deadline_at?: string
}

export type ToolApprovalReconciliationAckWire = ToolApprovalAckWire

type ToolApprovalTerminalListener = (terminal: ToolApprovalTerminalWire) => void

const toolApprovalTerminalListeners = new Set<ToolApprovalTerminalListener>()

export function onToolApprovalTerminal(listener: ToolApprovalTerminalListener): () => void {
  toolApprovalTerminalListeners.add(listener)
  return () => toolApprovalTerminalListeners.delete(listener)
}

function nonEmptyWireString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function wireMetadata(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = data.metadata
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : undefined
}

function wireString(data: Record<string, unknown>, key: string): string | undefined {
  if (nonEmptyWireString(data[key])) return data[key]
  const metadata = wireMetadata(data)
  return metadata && nonEmptyWireString(metadata[key]) ? metadata[key] : undefined
}

function wirePositiveInteger(data: Record<string, unknown>, key: string): number | undefined {
  const direct = data[key]
  if (Number.isSafeInteger(direct) && Number(direct) > 0) return Number(direct)
  const metadata = wireMetadata(data)
  const value = metadata?.[key]
  return typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0
    ? Number(value)
    : undefined
}

export function parseToolApprovalTerminal(
  data: Record<string, unknown>,
): ToolApprovalTerminalWire | null {
  if (
    data.type !== 'tool_approval_terminal' ||
    !nonEmptyWireString(data.request_id) ||
    !nonEmptyWireString(data.session_id) ||
    !nonEmptyWireString(data.owner_id) ||
    !nonEmptyWireString(data.invocation_id) ||
    !nonEmptyWireString(data.arguments_digest) ||
    !nonEmptyWireString(data.security_scope_digest) ||
    !Number.isSafeInteger(data.scope_schema_version) ||
    Number(data.scope_schema_version) <= 0 ||
    (data.terminal_result !== 'expired' && data.terminal_result !== 'fenced') ||
    'decision_id' in data ||
    'idempotency_key' in data
  ) {
    return null
  }
  return {
    type: 'tool_approval_terminal',
    request_id: data.request_id,
    session_id: data.session_id,
    owner_id: data.owner_id,
    invocation_id: data.invocation_id,
    arguments_digest: data.arguments_digest,
    security_scope_digest: data.security_scope_digest,
    scope_schema_version: Number(data.scope_schema_version),
    terminal_result: data.terminal_result,
    ...(nonEmptyWireString(data.deadline_at) ? { deadline_at: data.deadline_at } : {}),
  }
}

export function parseToolApprovalReconciliationAck(
  data: Record<string, unknown>,
): ToolApprovalReconciliationAckWire | null {
  if (data.type !== 'tool_approval_ack') return null
  const requestID = wireString(data, 'request_id')
  const sessionID = wireString(data, 'session_id')
  const ownerID = wireString(data, 'owner_id')
  const invocationID = wireString(data, 'invocation_id')
  const argumentsDigest = wireString(data, 'arguments_digest')
  const securityScopeDigest = wireString(data, 'security_scope_digest')
  const scopeSchemaVersion = wirePositiveInteger(data, 'scope_schema_version')
  const decisionID = wireString(data, 'decision_id')
  const decision = wireString(data, 'decision')
  const idempotencyKey = wireString(data, 'idempotency_key')
  const status = wireString(data, 'status')
  if (
    !requestID ||
    !sessionID ||
    !ownerID ||
    !invocationID ||
    !argumentsDigest ||
    !securityScopeDigest ||
    !scopeSchemaVersion ||
    !decisionID ||
    !idempotencyKey ||
    (decision !== 'approved_once' && decision !== 'approved_remember' && decision !== 'denied') ||
    (status !== 'accepted' && status !== 'already_accepted')
  ) {
    return null
  }
  return {
    type: 'tool_approval_ack',
    request_id: requestID,
    session_id: sessionID,
    owner_id: ownerID,
    invocation_id: invocationID,
    arguments_digest: argumentsDigest,
    security_scope_digest: securityScopeDigest,
    scope_schema_version: scopeSchemaVersion,
    decision_id: decisionID,
    decision,
    idempotency_key: idempotencyKey,
    status,
  }
}

function consumeToolApprovalTerminal(data: Record<string, unknown>): boolean {
  if (data.type !== 'tool_approval_terminal') return false
  const terminal = parseToolApprovalTerminal(data)
  if (!terminal) {
    logger.warn('Ignoring malformed tool approval terminal frame')
    return true
  }
  for (const listener of toolApprovalTerminalListeners) {
    try {
      listener(terminal)
    } catch (error) {
      logger.warn('Tool approval terminal listener failed', error)
    }
  }
  return true
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
  const acknowledgement = parseToolApprovalReconciliationAck(data)
  if (!acknowledgement) {
    logger.warn('Ignoring malformed tool approval acknowledgement frame')
    return true
  }
  const waiter = approvalAckWaiters.get(acknowledgement.decision_id)
  if (!waiter || waiter.requestId !== acknowledgement.request_id) return true
  approvalAckWaiters.delete(acknowledgement.decision_id)
  waiter.resolve(acknowledgement)
  return true
}

function sendToolApprovalResponse(
  socket: NativeSidecarWebSocket,
  decision: ToolApprovalDecisionWire,
  identity: ToolApprovalResponseIdentity,
): Promise<ToolApprovalAckWire> {
  if (socket.readyState !== NativeSidecarWebSocket.OPEN) {
    return Promise.reject(new Error('Owning approval request socket is not connected'))
  }

  return new Promise<ToolApprovalAckWire>((resolve, reject) => {
    approvalAckWaiters.set(decision.decision_id, {
      socket,
      requestId: identity.requestId,
      resolve,
      reject,
    })
    try {
      socket.send(JSON.stringify(createToolApprovalResponseWire(decision, identity)))
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
    const resolvedMetadata = withModelReasoningDefaults(chatParams.model, metadata)
    let expectedReasoningRequest = reasoningRequestFromMetadata(resolvedMetadata)
    let runtimeSnapshot = createRuntimeWireSnapshot(expectedReasoningRequest ?? undefined)
    let firstReplyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      fail(new ChatRequestError('Assistant reply timed out — no response received.', false))
    }, WS_FIRST_REPLY_TIMEOUT_MS)
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null

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

    function markActivity() {
      if (firstReplyTimer) {
        clearTimeout(firstReplyTimer)
        firstReplyTimer = null
      }
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
      const merged = mergeRuntimeFrameWithExpectation(runtimeSnapshot, chunk, chatParams, expectedReasoningRequest)
      if (!merged.accepted || (chunk.sequence && !merged.frame)) return
      expectedReasoningRequest = merged.expectedReasoningRequest
      if (merged.frame) runtimeSnapshot = merged.snapshot
      markActivity()
      if (chunk.content) accumulatedContent += chunk.content
      const publicReasoning =
        merged.frame?.reasoningDisclosure.visibility === 'visible' ? chunk.reasoning : undefined
      callbacks?.onChunk?.(chunk.content, publicReasoning, merged.frame)
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
      const merged = mergeRuntimeFrameWithExpectation(runtimeSnapshot, reply, chatParams, expectedReasoningRequest)
      if (!merged.accepted || (reply.sequence && !merged.frame)) return
      expectedReasoningRequest = merged.expectedReasoningRequest
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

    hexclawWS.onError((errMsg: string, errorFrame) => {
      if (settled) return
      let result: WebSocketStreamResult | undefined
      if (errorFrame) {
        const merged = mergeRuntimeFrameWithExpectation(runtimeSnapshot, errorFrame, chatParams, expectedReasoningRequest)
        if (!merged.accepted || (errorFrame.sequence && !merged.frame)) return
        expectedReasoningRequest = merged.expectedReasoningRequest
        if (merged.frame) runtimeSnapshot = merged.snapshot
        callbacks?.onChunk?.('', undefined, merged.frame)
        result = projectErrorResult(errorFrame as StreamWsServerMessage, accumulatedContent, runtimeSnapshot)
      }
      // User-initiated cancellation should not trigger fallback or surface as an error.
      if (result?.terminalState === 'cancelled' || errMsg === USER_CANCELLED_MESSAGE) {
        if (settled) return
        settled = true
        clearTimers()
        if (result) callbacks?.onSnapshot?.({ ...result, done: true })
        resolve()
        return
      }
      fail(new ChatRequestError(errMsg || 'WebSocket request failed', true, result, errorFrame as StreamWsServerMessage | undefined))
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
      resolvedMetadata,
      requestId,
      (message) => {
        const error = new ChatPayloadLimitError(message, sessionId)
        try {
          callbacks?.onPayloadRejected?.(error)
        } finally {
          fail(error)
        }
      },
    )
  })
}

function openRequestSocket(
  sessionId: string,
  requestId: string | undefined,
  callbacks: StreamCallbacks | undefined,
  buildPayload: () => Record<string, unknown>,
  route?: { provider?: string; model?: string },
  reasoningRequest: ReasoningRequest | null = null,
): WebSocketStreamHandle {
  const scope = backendScopeKey()
  const ws = new NativeSidecarWebSocket('/ws')

  let settled = false
  let cancelRequested = false
  let accumulatedContent = ''
  let expectedReasoningRequest = reasoningRequest
  let runtimeSnapshot = createRuntimeWireSnapshot(reasoningRequest ?? undefined)
  let firstReplyTimer: ReturnType<typeof setTimeout> | null = null
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null
  let snapshotObserver: WebSocketStreamHandle | undefined
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
    snapshotObserver?.dispose?.()
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
        ws.readyState === NativeSidecarWebSocket.OPEN ||
        ws.readyState === NativeSidecarWebSocket.CONNECTING
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
    // 主动停止后连接异常只结束观察，不能回退成一次新的业务请求；
    // stopRequested 与普通 noFallback 业务错误分开，后者仍应展示真实失败。
    if (cancelRequested && err instanceof ChatRequestError && !err.result?.terminalState) {
      err.noFallback = true
      err.stopRequested = true
    }
    settled = true
    cleanup()
    try {
      if (
        ws.readyState === NativeSidecarWebSocket.OPEN ||
        ws.readyState === NativeSidecarWebSocket.CONNECTING
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
      // 发送失败继续观察原请求，不能把控制失败当作后台终态。
    }
  }

  function observeStoppedRequest(error: ChatRequestError) {
    if (settled || snapshotObserver) return
    if (!cancelRequested || !requestId) { settleReject(error); return }
    if (backendScopeKey() !== scope) { settleResolve(null); return }
    cleanup()
    try { ws.close() } catch { /* 连接已中断，继续只读观察原请求。 */ }
    // 保留当前部分预览，复用快照读取等待真实终态，不重发消息或取消控制。
    snapshotObserver = observeStreamSnapshots(
      sessionId, requestId, (snapshot) => {
        const metadata = normalizeRuntimeSnapshotMetadata(snapshot.metadata, undefined, route, expectedReasoningRequest ?? undefined)
        callbacks?.onSnapshot?.({
          content: snapshot.content || '',
          reasoning: metadata.reasoning_disclosure?.visibility === 'visible' ? snapshot.reasoning : undefined,
          metadata,
          done: snapshot.done,
          messageContent: snapshot.message_content,
          renderManifest: snapshot.render_manifest,
          blocks: snapshot.blocks,
          toolCalls: snapshot.tool_calls,
        })
      }, 'websocket', route, expectedReasoningRequest ?? undefined,
    )
    void snapshotObserver.done.then(settleResolve, (observationError) => {
      settleReject(observationError instanceof ChatRequestError
        ? observationError
        : new ChatRequestError(observationError instanceof Error ? observationError.message : String(observationError), true))
    })
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
      settleReject(
        new ChatRequestError('Assistant reply stalled — no new content received.', false),
      )
    }, WS_INACTIVITY_TIMEOUT_MS)
  }

  firstReplyTimer = setTimeout(() => {
    sendRequestCancel()
    settleReject(new ChatRequestError('Assistant reply timed out — no response received.', false))
  }, WS_FIRST_REPLY_TIMEOUT_MS)

  ws.onopen = () => {
    try {
      const body = JSON.stringify(buildPayload())
      const limitError = inputLimitError(
        body, 'Chat request', INPUT_LIMITS.chatBytes, { unit: 'bytes' },
      )
      if (limitError) {
        const error = new ChatPayloadLimitError(limitError, sessionId)
        try {
          callbacks?.onPayloadRejected?.(error)
        } finally {
          settleReject(error)
        }
        return
      }
      ws.send(body)
      if (cancelRequested) sendRequestCancel()
    } catch (error) {
      settleReject(error)
    }
  }

  ws.onmessage = (event: MessageEvent<string>) => {
    if (settled) return
    if (backendScopeKey() !== scope) { settleResolve(null); return }
    let msg: StreamWsServerMessage
    try {
      msg = JSON.parse(event.data)
    } catch {
      logger.warn('Request WebSocket received non-JSON message', event.data)
      return
    }
    // 私有连接仍核对显式来源，迟到或异源错误不能结束当前请求。
    // 审批消息使用独立审批身份，继续交给已有审批归约校验。
    if (['chunk', 'reply', 'error', 'stream_snapshot'].includes(msg.type)) {
      for (const value of [msg.request_id, msg.metadata?.request_id]) {
        if (requestId && typeof value === 'string' && value && value !== requestId) return
      }
      for (const value of [msg.session_id, msg.metadata?.session_id]) {
        if (sessionId && typeof value === 'string' && value && value !== sessionId) return
      }
    }

    if (consumeToolApprovalAck(msg as unknown as Record<string, unknown>)) {
      markActivity()
      return
    }
    if (consumeToolApprovalTerminal(msg as unknown as Record<string, unknown>)) {
      markActivity()
      return
    }

    switch (msg.type) {
      case 'chunk': {
        const merged = mergeRuntimeFrameWithExpectation(runtimeSnapshot, msg, route, expectedReasoningRequest)
        if (!merged.accepted || (msg.sequence && !merged.frame)) break
        expectedReasoningRequest = merged.expectedReasoningRequest
        if (merged.frame) runtimeSnapshot = merged.snapshot
        markActivity()
        if (msg.content) accumulatedContent += msg.content
        const publicReasoning =
          merged.frame?.reasoningDisclosure.visibility === 'visible' ? msg.reasoning : undefined
        callbacks?.onChunk?.(msg.content, publicReasoning, merged.frame)
        if (msg.done) {
          settleResolve({
            terminalState: 'completed',
            content: accumulatedContent,
            messageContent: msg.message_content,
            metadata: runtimeMetadata(foldRetrievalHits(msg.metadata, msg), runtimeSnapshot),
            toolCalls: msg.tool_calls,
            blocks: msg.blocks,
            agentName:
              typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
          })
        }
        break
      }
      case 'stream_snapshot': {
        const hasAtomicRuntimeSnapshot =
          msg.last_sequence !== undefined ||
          msg.metadata?.last_sequence !== undefined ||
          Array.isArray(msg.runtime_events) ||
          Array.isArray(msg.metadata?.runtime_events)
        let runtimeFrame: RuntimeWireFrame | undefined
        if (hasAtomicRuntimeSnapshot) {
          const snapshotSource = {
            ...msg.metadata,
            assistant_message_id: msg.assistant_message_id ?? msg.metadata?.assistant_message_id,
            message_id: msg.message_id ?? msg.metadata?.message_id,
            reasoning_disclosure: msg.reasoning_disclosure ?? msg.metadata?.reasoning_disclosure,
            reasoning_receipt: msg.reasoning_receipt ?? msg.metadata?.reasoning_receipt,
            runtime_events: msg.runtime_events ?? msg.metadata?.runtime_events,
            last_sequence: msg.last_sequence ?? msg.metadata?.last_sequence,
          }
          const snapshotMetadata = normalizeRuntimeSnapshotMetadata(
            snapshotSource,
            undefined,
            route,
            expectedReasoningRequest ?? undefined,
          )
          const candidateReceipt = parseReasoningReceiptWithFacts(snapshotSource.reasoning_receipt)
          const hasReceiptAuthority = snapshotMetadata.assistant_message_id &&
            (!runtimeSnapshot.assistantMessageId || snapshotMetadata.assistant_message_id === runtimeSnapshot.assistantMessageId) &&
            Number(snapshotMetadata.last_sequence) > 0 &&
            Number(snapshotMetadata.last_sequence) >= runtimeSnapshot.lastSequence
          const reasoningReceipt = candidateReceipt && (expectedReasoningRequest !== null || hasReceiptAuthority)
            ? expectedReasoningRequest === null
              ? candidateReceipt
              : mergeReasoningReceipt(runtimeSnapshot.reasoningReceipt, candidateReceipt)
            : runtimeSnapshot.reasoningReceipt
          if (expectedReasoningRequest === null && hasReceiptAuthority && candidateReceipt) {
            expectedReasoningRequest = candidateReceipt.reasoning_request
          }
          runtimeSnapshot = {
            assistantMessageId: snapshotMetadata.assistant_message_id,
            aliases: snapshotMetadata.assistant_message_aliases ?? [],
            lastSequence: Number(snapshotMetadata.last_sequence) || 0,
            runtimeEvents: snapshotMetadata.runtime_events ?? [],
            reasoningDisclosure: snapshotMetadata.reasoning_disclosure,
            reasoningReceipt,
            acceptedFrames: {},
          }
        } else {
          const merged = mergeRuntimeFrameWithExpectation(runtimeSnapshot, msg, route, expectedReasoningRequest)
          if (!merged.accepted || (msg.sequence && !merged.frame)) break
          expectedReasoningRequest = merged.expectedReasoningRequest
          if (merged.frame) runtimeSnapshot = merged.snapshot
          runtimeFrame = merged.frame
        }
        markActivity()
        const publicReasoning =
          runtimeSnapshot.reasoningDisclosure?.visibility === 'visible' ? msg.reasoning : undefined
        callbacks?.onSnapshot?.({
          content: msg.message_content?.markdown ?? msg.content,
          reasoning: publicReasoning,
          metadata: runtimeMetadata(msg.metadata, runtimeSnapshot),
          done: msg.done,
          messageContent: msg.message_content,
          renderManifest: msg.render_manifest,
          runtimeFrame,
          blocks: msg.blocks,
          toolCalls: msg.tool_calls,
        })
        if (msg.done) {
          const result: WebSocketStreamResult = {
            terminalState: msg.status === 'cancelled' ? 'cancelled' : msg.status === 'errored' ? 'failed' : 'completed',
            content: msg.message_content?.markdown ?? msg.content,
            messageContent: msg.message_content,
            renderManifest: msg.render_manifest,
            metadata: runtimeMetadata(foldRetrievalHits(msg.metadata, msg), runtimeSnapshot),
            toolCalls: msg.tool_calls,
            blocks: msg.blocks,
            agentName:
              typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
          }
          if (result.terminalState === 'failed') {
            settleReject(new ChatRequestError(
              typeof msg.metadata?.error === 'string' && msg.metadata.error
                ? msg.metadata.error : 'WebSocket stream failed',
              true, result, msg,
            ))
          } else settleResolve(result)
        }
        break
      }
      case 'reply': {
        const merged = mergeRuntimeFrameWithExpectation(runtimeSnapshot, msg, route, expectedReasoningRequest)
        if (!merged.accepted || (msg.sequence && !merged.frame)) break
        expectedReasoningRequest = merged.expectedReasoningRequest
        if (merged.frame) runtimeSnapshot = merged.snapshot
        markActivity()
        settleResolve({
          terminalState: 'completed',
          content: msg.content,
          messageContent: msg.message_content,
          metadata: runtimeMetadata(foldRetrievalHits(msg.metadata, msg), runtimeSnapshot),
          toolCalls: msg.tool_calls,
          agentName:
            typeof msg.metadata?.agent_name === 'string' ? msg.metadata.agent_name : undefined,
        })
        break
      }
      case 'error': {
        const merged = mergeRuntimeFrameWithExpectation(runtimeSnapshot, msg, route, expectedReasoningRequest)
        if (!merged.accepted || (msg.sequence && !merged.frame)) break
        expectedReasoningRequest = merged.expectedReasoningRequest
        if (merged.frame) runtimeSnapshot = merged.snapshot
        callbacks?.onChunk?.('', undefined, merged.frame)
        const result = projectErrorResult(msg, accumulatedContent, runtimeSnapshot)
        if (result.terminalState === 'cancelled') {
          settleResolve(result)
          return
        }
        settleReject(new ChatRequestError(msg.content || 'WebSocket request failed', true, result, msg))
        break
      }
      case 'tool_approval_request':
      case 'tool_permission_request': {
        const approvalMessage = msg as unknown as {
          request_id?: unknown
          deadline_at?: unknown
          scope_schema_version?: unknown
          metadata?: Record<string, unknown>
        }
        const approvalRequestId =
          typeof approvalMessage.request_id === 'string'
            ? approvalMessage.request_id
            : typeof approvalMessage.metadata?.request_id === 'string'
              ? approvalMessage.metadata.request_id
              : ''
        const approvalOwnerId =
          typeof msg.owner_id === 'string'
            ? msg.owner_id
            : typeof msg.metadata?.owner_id === 'string'
              ? msg.metadata.owner_id
              : undefined
        const approvalInvocationId =
          typeof msg.invocation_id === 'string'
            ? msg.invocation_id
            : typeof msg.metadata?.invocation_id === 'string'
              ? msg.metadata.invocation_id
              : undefined
        const approvalArgumentsDigest =
          typeof msg.arguments_digest === 'string'
            ? msg.arguments_digest
            : typeof msg.metadata?.arguments_digest === 'string'
              ? msg.metadata.arguments_digest
              : undefined
        const approvalSecurityScopeDigest =
          typeof msg.security_scope_digest === 'string'
            ? msg.security_scope_digest
            : typeof msg.metadata?.security_scope_digest === 'string'
              ? msg.metadata.security_scope_digest
              : undefined
        const approvalScopeSchemaVersion = Number.isSafeInteger(
          approvalMessage.scope_schema_version,
        )
          ? Number(approvalMessage.scope_schema_version)
          : typeof approvalMessage.metadata?.scope_schema_version === 'string' &&
              /^\d+$/.test(approvalMessage.metadata.scope_schema_version)
            ? Number(approvalMessage.metadata.scope_schema_version)
            : undefined
        const approvalSessionId = msg.session_id || sessionId
        const approvalDeadlineAt =
          typeof approvalMessage.deadline_at === 'string'
            ? approvalMessage.deadline_at
            : typeof approvalMessage.metadata?.deadline_at === 'string'
              ? approvalMessage.metadata.deadline_at
              : undefined
        if (
          !approvalRequestId ||
          !approvalOwnerId ||
          !approvalInvocationId ||
          !approvalArgumentsDigest ||
          !approvalSecurityScopeDigest ||
          !approvalScopeSchemaVersion ||
          !approvalSessionId ||
          !approvalDeadlineAt ||
          !Number.isFinite(Date.parse(approvalDeadlineAt))
        ) {
          logger.warn('Ignoring malformed tool approval request frame')
          break
        }
        clearTimers()
        const approvalResponseIdentity: ToolApprovalResponseIdentity = {
          requestId: approvalRequestId,
          sessionId: approvalSessionId,
          ownerId: approvalOwnerId,
          invocationId: approvalInvocationId,
          argumentsDigest: approvalArgumentsDigest,
          securityScopeDigest: approvalSecurityScopeDigest,
          scopeSchemaVersion: approvalScopeSchemaVersion,
          deadlineAt: approvalDeadlineAt,
        }
        const approvalRequest = {
          requestId: approvalRequestId,
          ownerId: approvalOwnerId,
          invocationId: approvalInvocationId,
          toolName:
            typeof msg.tool_name === 'string'
              ? msg.tool_name
              : typeof msg.metadata?.tool_name === 'string'
                ? msg.metadata.tool_name
                : '',
          arguments: msg.arguments,
          argumentsDigest: approvalArgumentsDigest,
          securityScopeDigest: approvalSecurityScopeDigest,
          scopeSchemaVersion: approvalScopeSchemaVersion,
          risk: typeof msg.metadata?.risk === 'string' ? msg.metadata.risk : 'sensitive',
          reason: msg.content || '',
          sessionId: approvalSessionId,
          deadlineAt: approvalDeadlineAt,
          respondApproval: (decision: ToolApprovalDecisionWire) =>
            sendToolApprovalResponse(ws, decision, approvalResponseIdentity),
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
    observeStoppedRequest(new ChatRequestError('WebSocket connection failed', false))
  }

  ws.onclose = () => {
    if (!settled) {
      observeStoppedRequest(new ChatRequestError('WebSocket connection lost', false))
    }
  }

  return {
    cancel() {
      if (settled) return
      if (cancelRequested) return
      cancelRequested = true
      sendRequestCancel()
    },
    dispose() { settleResolve(null) },
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
  return openRequestSocket(
    sessionId,
    requestId,
    callbacks,
    () => ({
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
    }),
    chatParams,
    reasoningRequestFromMetadata(resolvedMetadata),
  )
}

export function resumeWebSocketStream(
  sessionId: string,
  requestId: string,
  callbacks?: StreamCallbacks,
  reasoningRequest: ReasoningRequest = 'off',
): WebSocketStreamHandle {
  return openRequestSocket(
    sessionId,
    requestId,
    callbacks,
    () => ({
      type: 'resume',
      session_id: sessionId,
      request_id: requestId,
      user_id: DESKTOP_USER_ID,
    }),
    undefined,
    reasoningRequest,
  )
}

/** REST 任务复用服务端快照观察；断连只中断读取，取消必须显式请求。 */
export function resumeRestStream(
  sessionId: string,
  requestId: string,
  onSnapshot: (snapshot: ActiveStreamSnapshot) => void,
): WebSocketStreamHandle {
  return observeStreamSnapshots(sessionId, requestId, onSnapshot, 'rest')
}

/** 两种传输共用原请求快照的只读观察、释放与后端归属，保持各自来源身份。 */
function observeStreamSnapshots(
  sessionId: string,
  requestId: string,
  onSnapshot: (snapshot: ActiveStreamSnapshot) => void,
  source: 'rest' | 'websocket',
  route?: { provider?: string; model?: string },
  reasoningRequest?: ReasoningRequest,
): WebSocketStreamHandle {
  const scope = backendScopeKey()
  let settled = false
  let cancelPending = false
  let observationFailed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let reader: AbortController | undefined
  let resolveDone!: (value: WebSocketStreamResult | null) => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<WebSocketStreamResult | null>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  function settle(result: WebSocketStreamResult | null, error?: unknown) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    reader?.abort()
    if (error) rejectDone(error)
    else resolveDone(result)
  }

  function consume(snapshot: ActiveStreamSnapshot) {
    if (settled) return
    if (backendScopeKey() !== scope) { settle(null); return }
    if (snapshot.request_id !== requestId || snapshot.session_id !== sessionId || snapshot.source !== source) {
      throw new ChatRequestError(`${source === 'rest' ? 'REST' : 'WebSocket'} stream snapshot identity mismatch`, true)
    }
    const metadata = normalizeRuntimeSnapshotMetadata({
      ...snapshot.metadata,
      request_id: requestId,
      session_id: sessionId,
      assistant_message_id: snapshot.assistant_message_id ?? snapshot.metadata?.assistant_message_id,
      message_id: snapshot.message_id ?? snapshot.metadata?.message_id,
      reasoning_disclosure: snapshot.reasoning_disclosure ?? snapshot.metadata?.reasoning_disclosure,
      runtime_events: snapshot.runtime_events ?? snapshot.metadata?.runtime_events,
      last_sequence: snapshot.last_sequence ?? snapshot.metadata?.last_sequence,
    }, undefined, route, reasoningRequest)
    const content = snapshot.message_content?.markdown ?? (snapshot.content || '')
    onSnapshot({ ...snapshot, content, metadata })
    if (!snapshot.done) return
    const terminalState = snapshot.status === 'completed'
      ? 'completed'
      : snapshot.status === 'cancelled'
        ? 'cancelled'
        : snapshot.status === 'errored'
          ? 'failed'
          : undefined
    if (!terminalState) throw new ChatRequestError(`${source === 'rest' ? 'REST' : 'WebSocket'} stream terminal status is missing`, true)
    const result: WebSocketStreamResult = {
      content,
      messageContent: snapshot.message_content,
      renderManifest: snapshot.render_manifest,
      metadata,
      toolCalls: snapshot.tool_calls,
      blocks: snapshot.blocks,
      agentName: typeof metadata.agent_name === 'string' ? metadata.agent_name : undefined,
      terminalState,
    }
    if (terminalState === 'failed') {
      settle(null, new ChatRequestError(
        typeof metadata.error === 'string' && metadata.error
          ? metadata.error : `${source === 'rest' ? 'REST' : 'WebSocket'} stream failed`,
        true, result, snapshot,
      ))
    } else settle(result)
  }

  async function poll() {
    if (settled) return
    if (backendScopeKey() !== scope) { settle(null); return }
    reader = new AbortController()
    let received = false
    try {
      const { getActiveStreamSnapshot } = await import('@/api/chat')
      if (settled || backendScopeKey() !== scope) { settle(null); return }
      const snapshot = await getActiveStreamSnapshot(requestId, { source, signal: reader.signal })
      received = true
      consume(snapshot)
      observationFailed = false
    } catch (error) {
      if (settled) return
      if (backendScopeKey() !== scope) { settle(null); return }
      const status = (error as { status?: number })?.status
      if (source === 'rest' && (received || (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429))) {
        settle(null, error)
        return
      }
      if (!observationFailed) logger.warn(`${source === 'rest' ? 'REST' : 'WebSocket'} stream observation interrupted`, error)
      observationFailed = true
    } finally {
      reader = undefined
      if (!settled) timer = setTimeout(() => { void poll() }, observationFailed ? 5_000 : 1_000)
    }
  }

  void poll()
  return {
    cancel() {
      if (settled || cancelPending) return
      if (backendScopeKey() !== scope) { settle(null); return }
      cancelPending = true
      void (async () => {
        const { cancelActiveStream } = await import('@/api/chat')
        // 已明确发起的取消独立于观察释放；删除会话不能吞掉排队中的控制请求。
        if (backendScopeKey() !== scope) { settle(null); return }
        const response = await cancelActiveStream(requestId)
        if (response.request_id !== requestId) throw new ChatRequestError('REST cancellation identity mismatch', true)
        // 接纳响应不覆盖正在推进的只读快照；仅不可变终态可以直接收口。
        if (response.snapshot.done) consume(response.snapshot)
      })().catch((error) => {
        if (!settled) logger.warn('REST stream cancellation request failed', error)
      }).finally(() => { cancelPending = false })
    },
    dispose() { settle(null) },
    done,
  }
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
