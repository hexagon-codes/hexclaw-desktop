import { logger } from '@/utils/logger'
import { NativeSidecarWebSocket } from './native-sidecar-websocket'
import { DESKTOP_USER_ID } from '@/constants'
import type { ToolCall, ContentBlock, ReasoningDisclosure, RuntimeEvent } from '@/types'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'

type ChunkCallback = (message: WsServerMessage) => void
type ReplyCallback = (message: WsServerMessage) => void
type ErrorCallback = (error: string) => void

/**
 * 回调分流范围（BUG-20260718 §15 防串）：把回调限定到某个 request/session。
 * 分发时"只丢弃明确异源"的消息——消息带非空且不同的 request_id/session_id 才丢弃；
 * 后端未回填该字段时一律投递（零回归）。
 */
export interface CallbackScope {
  sessionId?: string
  requestId?: string
}

type ScopedCallback<T> = { cb: T; scope?: CallbackScope }

/** 消息是否落入回调 scope：只在字段存在且明确不同的情况下拒绝。 */
function scopeAllows(msg: WsServerMessage, scope?: CallbackScope): boolean {
  if (!scope) return true
  if (
    scope.requestId &&
    typeof msg.request_id === 'string' &&
    msg.request_id.length > 0 &&
    msg.request_id !== scope.requestId
  ) {
    return false
  }
  if (
    scope.sessionId &&
    typeof msg.session_id === 'string' &&
    msg.session_id.length > 0 &&
    msg.session_id !== scope.sessionId
  ) {
    return false
  }
  return true
}

interface WsAttachment {
  attachment_id: string
}

interface WsMessage {
  type: 'message'
  content: string
  request_id?: string
  session_id?: string
  user_id?: string
  provider?: string
  model?: string
  role?: string
  attachments?: WsAttachment[]
  temperature?: number
  max_tokens?: number
  metadata?: Record<string, string>
}

interface WsUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  provider: string
  model: string
  cost?: number
}

interface WsServerMessage {
  type: 'chunk' | 'reply' | 'error' | 'pong' | 'tool_approval_request' | 'tool_permission_request' | 'tool_approval_ack' | 'tool_approval_terminal' | 'memory_saved' | 'desktop_notification'
  content: string
  message_content?: MessageContent
  render_manifest?: RenderManifest
  reasoning?: string
  done?: boolean
  session_id?: string
  /** 后端若回填请求 ID，可据此把回调按 request 分流防串（BUG-20260718）。 */
  request_id?: string
  owner_id?: string
  invocation_id?: string
  decision_id?: string
  status?: string
  tool_name?: string
  arguments?: Record<string, unknown>
  arguments_digest?: string
  security_scope_digest?: string
  scope_schema_version?: number
  terminal_result?: string
  deadline_at?: string
  usage?: WsUsage
  tool_calls?: ToolCall[]
  blocks?: ContentBlock[]
  metadata?: Record<string, unknown>
  // U9：后端结构化 RAG/记忆命中（顶层字段，Metadata 是 string map 无法承载对象数组）。
  knowledge_hits?: Record<string, unknown>[]
  memory_hits?: Record<string, unknown>[]
  assistant_message_id?: string
  message_id?: string
  sequence?: number
  reasoning_disclosure?: ReasoningDisclosure
  runtime_event?: Omit<RuntimeEvent, 'sequence'>
}

export type ToolApprovalWireMessage = Omit<WsServerMessage, 'type'> & {
  type: 'tool_approval_request' | 'tool_permission_request' | 'tool_approval_ack' | 'tool_approval_terminal'
}

export interface ToolApprovalRequest {
  requestId: string
  ownerId: string
  invocationId: string
  toolName: string
  arguments?: Record<string, unknown>
  argumentsDigest: string
  securityScopeDigest: string
  scopeSchemaVersion: number
  risk: string
  reason: string
  sessionId: string
  deadlineAt: string
}

type ApprovalCallback = (req: ToolApprovalRequest) => void
type ApprovalWireCallback = (message: ToolApprovalWireMessage) => void

function isToolApprovalWireMessage(message: WsServerMessage): message is ToolApprovalWireMessage {
  return message.type === 'tool_approval_request'
    || message.type === 'tool_permission_request'
    || message.type === 'tool_approval_ack'
    || message.type === 'tool_approval_terminal'
}

function approvalWireString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

function approvalScopeSchemaVersion(message: WsServerMessage): number | undefined {
  if (Number.isSafeInteger(message.scope_schema_version) && Number(message.scope_schema_version) > 0) {
    return Number(message.scope_schema_version)
  }
  const metadataVersion = message.metadata?.scope_schema_version
  if (
    typeof metadataVersion === 'string' &&
    /^\d+$/.test(metadataVersion) &&
    Number(metadataVersion) > 0
  ) {
    return Number(metadataVersion)
  }
  return undefined
}

function parseToolApprovalRequest(message: WsServerMessage): ToolApprovalRequest | null {
  const requestId = approvalWireString(message.request_id, message.metadata?.request_id)
  const ownerId = approvalWireString(message.owner_id, message.metadata?.owner_id)
  const invocationId = approvalWireString(message.invocation_id, message.metadata?.invocation_id)
  const toolName = approvalWireString(message.tool_name, message.metadata?.tool_name)
  const argumentsDigest = approvalWireString(
    message.arguments_digest,
    message.metadata?.arguments_digest,
  )
  const securityScopeDigest = approvalWireString(
    message.security_scope_digest,
    message.metadata?.security_scope_digest,
  )
  const scopeSchemaVersion = approvalScopeSchemaVersion(message)
  const sessionId = approvalWireString(message.session_id, message.metadata?.session_id)
  const deadlineAt = approvalWireString(message.deadline_at, message.metadata?.deadline_at)
  if (
    !requestId ||
    !ownerId ||
    !invocationId ||
    !toolName ||
    !argumentsDigest ||
    !securityScopeDigest ||
    !scopeSchemaVersion ||
    !sessionId ||
    !deadlineAt ||
    !Number.isFinite(Date.parse(deadlineAt))
  ) {
    return null
  }
  return {
    requestId,
    ownerId,
    invocationId,
    toolName,
    arguments: message.arguments,
    argumentsDigest,
    securityScopeDigest,
    scopeSchemaVersion,
    risk: approvalWireString(message.metadata?.risk) ?? 'sensitive',
    reason: message.content || '',
    sessionId,
    deadlineAt,
  }
}

/** 后端 desktop.Service 推送的通知（cron 完成/失败、IM 入站、heal 等）。 */
export interface DesktopNotificationEvent {
  id: string
  title: string
  body: string
  /** info | success | warning | error */
  level: string
  /** 来源标识："cron" | "im" | "" */
  source: string
}

type DesktopNotificationCallback = (n: DesktopNotificationEvent) => void

class HexClawWS {
  private ws: NativeSidecarWebSocket | null = null

  private chunkCallbacks: ScopedCallback<ChunkCallback>[] = []
  private replyCallbacks: ScopedCallback<ReplyCallback>[] = []
  private errorCallbacks: ScopedCallback<ErrorCallback>[] = []
  private approvalCallbacks: ApprovalCallback[] = []
  private approvalWireCallbacks: ApprovalWireCallback[] = []
  private memorySavedCallbacks: ((content: string) => void)[] = []
  private desktopNotificationCallbacks: DesktopNotificationCallback[] = []
  private reconnectCallbacks: (() => void)[] = []

  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectInterval = 2000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatInterval = 30000
  private lastPongTime = 0
  private pongTimeoutMs = 10000

  private intentionalClose = false
  private connectPromise: Promise<void> | null = null
  private connectResolve: (() => void) | null = null
  private connectReject: ((error: Error) => void) | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly connectionTimeoutMs = 30_000

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === NativeSidecarWebSocket.OPEN) {
      return Promise.resolve()
    }
    if (
      this.connectPromise &&
      this.ws &&
      this.ws.readyState === NativeSidecarWebSocket.CONNECTING
    ) {
      return this.connectPromise
    }

    this.cleanupConnection()
    this.intentionalClose = false

    const promise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
    })
    this.connectPromise = promise

    let socket: NativeSidecarWebSocket
    try {
      socket = new NativeSidecarWebSocket('/ws')
      this.ws = socket
    } catch (error) {
      this.settleConnect(promise, error instanceof Error ? error : new Error(String(error)))
      return promise
    }

    this.connectTimer = setTimeout(() => {
      if (this.connectPromise !== promise) return
      this.settleConnect(promise, new Error('WebSocket connection timed out'))
      if (this.ws === socket && socket.readyState === NativeSidecarWebSocket.CONNECTING) {
        socket.close()
      }
    }, this.connectionTimeoutMs)

    socket.onopen = () => {
      if (this.ws !== socket || this.connectPromise !== promise) return
      logger.info('WebSocket connected')
      // 连接稳定十秒后再重置重连计数，避免服务端立即断开引发无限重连。
      const stableTimer = setTimeout(() => {
        this.reconnectAttempts = 0
      }, 10_000)
      socket.addEventListener('close', () => clearTimeout(stableTimer), { once: true })
      this.lastPongTime = Date.now()
      this.startHeartbeat()
      this.settleConnect(promise)
    }

    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data)
    }

    socket.onclose = () => {
      logger.info('WebSocket disconnected')
      this.stopHeartbeat()
      this.settleConnect(promise, new Error('WebSocket connection closed before opening'))
      if (!this.intentionalClose) {
        // 先尝试重连 + 恢复流，不立即触发 errorCallbacks
        // 避免产生"错误助手消息" + "恢复助手消息"重复
        this.attemptReconnect()
      }
    }

    socket.onerror = (event) => {
      logger.error('WebSocket error', event)
      this.settleConnect(promise, new Error('WebSocket connection failed'))
    }

    return promise
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.connectPromise) {
      this.settleConnect(this.connectPromise, new Error('WebSocket connection cancelled'))
    }
    this.stopHeartbeat()
    this.stopReconnect()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.chunkCallbacks = []
    this.replyCallbacks = []
    this.errorCallbacks = []
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === NativeSidecarWebSocket.OPEN
  }

  sendMessage(
    content: string,
    sessionId?: string,
    model?: string,
    role?: string,
    attachments?: WsAttachment[],
    provider?: string,
    temperature?: number,
    maxTokens?: number,
    metadata?: Record<string, string>,
    requestId?: string,
  ): void {
    if (!this.ws || this.ws.readyState !== NativeSidecarWebSocket.OPEN) {
      this.errorCallbacks.forEach((c) => c.cb('WebSocket is not connected'))
      return
    }

    const msg: WsMessage = {
      type: 'message',
      content,
      request_id: requestId,
      session_id: sessionId,
      user_id: DESKTOP_USER_ID,
      provider,
      model,
      role,
    }
    if (attachments?.length) {
      msg.attachments = attachments
    }
    if (temperature !== undefined) {
      msg.temperature = temperature
    }
    if (maxTokens !== undefined) {
      msg.max_tokens = maxTokens
    }
    if (metadata && Object.keys(metadata).length > 0) {
      msg.metadata = metadata
    }

    this.ws.send(JSON.stringify(msg))
    logger.debug(`→ ws: ${content.slice(0, 50)}... (${attachments?.length ?? 0} attachments)`)
  }

  onChunk(callback: ChunkCallback, scope?: CallbackScope): () => void {
    this.chunkCallbacks.push({ cb: callback, scope })
    return () => { this.chunkCallbacks = this.chunkCallbacks.filter((c) => c.cb !== callback) }
  }

  onReply(callback: ReplyCallback, scope?: CallbackScope): () => void {
    this.replyCallbacks.push({ cb: callback, scope })
    return () => { this.replyCallbacks = this.replyCallbacks.filter((c) => c.cb !== callback) }
  }

  onError(callback: ErrorCallback, scope?: CallbackScope): () => void {
    this.errorCallbacks.push({ cb: callback, scope })
    return () => { this.errorCallbacks = this.errorCallbacks.filter((c) => c.cb !== callback) }
  }

  onApprovalRequest(callback: ApprovalCallback): () => void {
    this.approvalCallbacks.push(callback)
    return () => { this.approvalCallbacks = this.approvalCallbacks.filter((cb) => cb !== callback) }
  }

  /** 审批重连对账使用的原始审批协议帧监听器。 */
  onApprovalWire(callback: ApprovalWireCallback): () => void {
    this.approvalWireCallbacks.push(callback)
    return () => { this.approvalWireCallbacks = this.approvalWireCallbacks.filter((cb) => cb !== callback) }
  }

  /** Listen for backend auto-memory extraction notifications */
  onMemorySaved(callback: (content: string) => void): () => void {
    this.memorySavedCallbacks.push(callback)
    return () => { this.memorySavedCallbacks = this.memorySavedCallbacks.filter((cb) => cb !== callback) }
  }

  /** Listen for backend desktop.Service notifications (cron / IM inbound / heal …).
   *  Structural listener — preserved across stream resets, like onReconnect. */
  onDesktopNotification(callback: DesktopNotificationCallback): () => void {
    this.desktopNotificationCallbacks.push(callback)
    return () => { this.desktopNotificationCallbacks = this.desktopNotificationCallbacks.filter((cb) => cb !== callback) }
  }

  /** Listen for successful reconnection (not initial connect) */
  onReconnect(callback: () => void): () => void {
    this.reconnectCallbacks.push(callback)
    return () => { this.reconnectCallbacks = this.reconnectCallbacks.filter((cb) => cb !== callback) }
  }

  /** Send a raw JSON message to the backend */
  sendRaw(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== NativeSidecarWebSocket.OPEN) return
    this.ws.send(JSON.stringify(data))
  }

  /** Trigger error callbacks to settle pending promises (e.g., on user cancel) */
  triggerError(msg: string): void {
    this.errorCallbacks.forEach((c) => c.cb(msg))
  }

  /** Remove only streaming callbacks (chunk/reply/error), preserve approval listeners */
  clearStreamCallbacks(): void {
    this.chunkCallbacks = []
    this.replyCallbacks = []
    this.errorCallbacks = []
  }

  /** Remove all registered callbacks including approval (used on disconnect/session reset).
   *  reconnectCallbacks are preserved — they are structural listeners, not per-stream. */
  clearCallbacks(): void {
    this.chunkCallbacks = []
    this.replyCallbacks = []
    this.errorCallbacks = []
    this.approvalCallbacks = []
    this.approvalWireCallbacks = []
    this.memorySavedCallbacks = []
  }

  private handleMessage(data: string): void {
    let msg: WsServerMessage
    try {
      msg = JSON.parse(data)
    } catch {
      logger.warn('WebSocket received non-JSON message:', data)
      return
    }

    switch (msg.type) {
      case 'chunk':
        this.chunkCallbacks.forEach((c) => { if (scopeAllows(msg, c.scope)) c.cb(msg) })
        break
      case 'reply':
        this.replyCallbacks.forEach((c) => { if (scopeAllows(msg, c.scope)) c.cb(msg) })
        break
      case 'error':
        this.errorCallbacks.forEach((c) => { if (scopeAllows(msg, c.scope)) c.cb(msg.content) })
        break
      case 'pong':
        this.lastPongTime = Date.now()
        break
      case 'tool_approval_request':
      case 'tool_permission_request':
        if (isToolApprovalWireMessage(msg)) {
          this.approvalWireCallbacks.forEach((cb) => cb(msg))
        }
        const approvalRequest = parseToolApprovalRequest(msg)
        if (approvalRequest) this.approvalCallbacks.forEach((cb) => cb(approvalRequest))
        break
      case 'tool_approval_ack':
      case 'tool_approval_terminal':
        if (isToolApprovalWireMessage(msg)) {
          this.approvalWireCallbacks.forEach((cb) => cb(msg))
        }
        break
      case 'memory_saved':
        this.memorySavedCallbacks.forEach((cb) => cb(msg.content))
        break
      case 'desktop_notification':
        this.desktopNotificationCallbacks.forEach((cb) => cb({
          id: (msg.metadata?.id as string) || '',
          title: (msg.metadata?.title as string) || '',
          body: msg.content || '',
          level: (msg.metadata?.type as string) || 'info',
          source: (msg.metadata?.source as string) || '',
        }))
        break
      default:
        logger.warn('WebSocket unknown message type:', msg)
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === NativeSidecarWebSocket.OPEN) {
        // 检查 pong 超时：如果上次 pong 距今超过阈值，认为连接已死
        if (this.lastPongTime > 0 && Date.now() - this.lastPongTime > this.heartbeatInterval + this.pongTimeoutMs) {
          logger.warn('WebSocket pong timeout, closing connection')
          this.ws.close()
          return
        }
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, this.heartbeatInterval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.warn(`WebSocket max reconnect attempts (${this.maxReconnectAttempts}) reached`)
      this.errorCallbacks.forEach((c) => c.cb('WebSocket reconnection failed'))
      return
    }

    this.reconnectAttempts++
    logger.info(`WebSocket reconnecting... attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)

    this.reconnectTimer = setTimeout(() => {
      this.connect()
        .then(() => {
          logger.info('WebSocket reconnected, notifying listeners')
          this.reconnectCallbacks.forEach((cb) => cb())
        })
        .catch((err) => {
          logger.warn('WebSocket reconnect failed', err)
        })
    }, this.reconnectInterval)
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = 0
  }

  private settleConnect(promise: Promise<void>, error?: Error): void {
    if (this.connectPromise !== promise) return
    const resolve = this.connectResolve
    const reject = this.connectReject
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    this.connectPromise = null
    this.connectResolve = null
    this.connectReject = null
    if (error) reject?.(error)
    else resolve?.()
  }

  private cleanupConnection(): void {
    this.stopHeartbeat()
    this.stopReconnect()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      if (
        this.ws.readyState === NativeSidecarWebSocket.OPEN
        || this.ws.readyState === NativeSidecarWebSocket.CONNECTING
      ) {
        this.ws.close()
      }
      this.ws = null
    }
  }
}

export const hexclawWS = new HexClawWS()
