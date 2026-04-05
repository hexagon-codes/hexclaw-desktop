import { env } from '@/config/env'
import { logger } from '@/utils/logger'
import { DESKTOP_USER_ID } from '@/constants'
import type { ToolCall } from '@/types'

type ChunkCallback = (message: WsServerMessage) => void
type ReplyCallback = (message: WsServerMessage) => void
type ErrorCallback = (error: string) => void

interface WsAttachment {
  type: string
  name: string
  mime: string
  data?: string
  url?: string
}

interface WsMessage {
  type: 'message'
  content: string
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
  type: 'chunk' | 'reply' | 'error' | 'pong' | 'tool_approval_request'
  content: string
  reasoning?: string
  done?: boolean
  session_id?: string
  usage?: WsUsage
  tool_calls?: ToolCall[]
  metadata?: Record<string, unknown>
}

export interface ToolApprovalRequest {
  requestId: string
  toolName: string
  risk: string
  reason: string
  sessionId: string
}

type ApprovalCallback = (req: ToolApprovalRequest) => void

class HexClawWS {
  private ws: WebSocket | null = null
  private url = `${env.wsBase}/ws`

  private chunkCallbacks: ChunkCallback[] = []
  private replyCallbacks: ReplyCallback[] = []
  private errorCallbacks: ErrorCallback[] = []
  private approvalCallbacks: ApprovalCallback[] = []

  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectInterval = 2000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatInterval = 30000
  private lastPongTime = 0
  private pongTimeoutMs = 10000

  private intentionalClose = false
  private connectResolved = false

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve()
        return
      }

      // Clean up any existing connection
      this.cleanupConnection()

      this.intentionalClose = false
      this.connectResolved = false

      try {
        this.ws = new WebSocket(this.url)
      } catch (e) {
        reject(e)
        return
      }

      this.ws.onopen = () => {
        logger.info('WebSocket connected')
        // Only reset reconnect counter after connection stays stable for 10s
        // This prevents infinite reconnect loops when the server immediately closes
        const stableTimer = setTimeout(() => { this.reconnectAttempts = 0 }, 10_000)
        this.ws!.addEventListener('close', () => clearTimeout(stableTimer), { once: true })
        this.lastPongTime = Date.now()
        this.startHeartbeat()
        this.connectResolved = true
        resolve()
      }

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data)
      }

      this.ws.onclose = () => {
        logger.info('WebSocket disconnected')
        this.stopHeartbeat()
        // Notify active streaming callbacks so they don't wait for the inactivity timeout
        if (!this.intentionalClose && this.errorCallbacks.length > 0) {
          this.errorCallbacks.forEach((cb) => cb('WebSocket connection lost'))
        }
        if (!this.intentionalClose) {
          this.attemptReconnect()
        }
      }

      this.ws.onerror = (event) => {
        logger.error('WebSocket error', event)
        if (!this.connectResolved) {
          this.connectResolved = true
          reject(new Error('WebSocket connection failed'))
        }
      }
    })
  }

  disconnect(): void {
    this.intentionalClose = true
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
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
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
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.errorCallbacks.forEach((cb) => cb('WebSocket is not connected'))
      return
    }

    const msg: WsMessage = {
      type: 'message',
      content,
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

  onChunk(callback: ChunkCallback): () => void {
    this.chunkCallbacks.push(callback)
    return () => { this.chunkCallbacks = this.chunkCallbacks.filter((cb) => cb !== callback) }
  }

  onReply(callback: ReplyCallback): () => void {
    this.replyCallbacks.push(callback)
    return () => { this.replyCallbacks = this.replyCallbacks.filter((cb) => cb !== callback) }
  }

  onError(callback: ErrorCallback): () => void {
    this.errorCallbacks.push(callback)
    return () => { this.errorCallbacks = this.errorCallbacks.filter((cb) => cb !== callback) }
  }

  onApprovalRequest(callback: ApprovalCallback): () => void {
    this.approvalCallbacks.push(callback)
    return () => { this.approvalCallbacks = this.approvalCallbacks.filter((cb) => cb !== callback) }
  }

  /** Send tool approval response back to backend */
  sendApprovalResponse(requestId: string, approved: boolean, remember: boolean): void {
    const base = approved ? 'approved' : 'denied'
    const content = remember ? `${base}_remember` : base
    this.sendRaw({
      type: 'tool_approval_response',
      content,
      metadata: { request_id: requestId },
    })
  }

  /** Send a raw JSON message to the backend */
  sendRaw(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(data))
  }

  /** Trigger error callbacks to settle pending promises (e.g., on user cancel) */
  triggerError(msg: string): void {
    this.errorCallbacks.forEach((cb) => cb(msg))
  }

  /** Remove only streaming callbacks (chunk/reply/error), preserve approval listeners */
  clearStreamCallbacks(): void {
    this.chunkCallbacks = []
    this.replyCallbacks = []
    this.errorCallbacks = []
  }

  /** Remove all registered callbacks including approval (used on disconnect/session reset) */
  clearCallbacks(): void {
    this.chunkCallbacks = []
    this.replyCallbacks = []
    this.errorCallbacks = []
    this.approvalCallbacks = []
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
        this.chunkCallbacks.forEach((cb) => cb(msg))
        break
      case 'reply':
        this.replyCallbacks.forEach((cb) => cb(msg))
        break
      case 'error':
        this.errorCallbacks.forEach((cb) => cb(msg.content))
        break
      case 'pong':
        this.lastPongTime = Date.now()
        break
      case 'tool_approval_request':
        this.approvalCallbacks.forEach((cb) => cb({
          requestId: (msg.metadata?.request_id as string) || '',
          toolName: (msg.metadata?.tool_name as string) || '',
          risk: (msg.metadata?.risk as string) || 'sensitive',
          reason: msg.content || '',
          sessionId: msg.session_id || '',
        }))
        break
      default:
        logger.warn('WebSocket unknown message type:', msg)
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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
      this.errorCallbacks.forEach((cb) => cb('WebSocket reconnection failed'))
      return
    }

    this.reconnectAttempts++
    logger.info(`WebSocket reconnecting... attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
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

  private cleanupConnection(): void {
    this.stopHeartbeat()
    this.stopReconnect()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
  }
}

export const hexclawWS = new HexClawWS()
