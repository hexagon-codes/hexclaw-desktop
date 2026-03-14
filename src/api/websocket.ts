import { logger } from '@/utils/logger'

type ChunkCallback = (content: string, done: boolean) => void
type ReplyCallback = (content: string, sessionId: string) => void
type ErrorCallback = (error: string) => void

interface WsMessage {
  type: 'message'
  content: string
  session_id?: string
}

interface WsServerMessage {
  type: 'chunk' | 'reply' | 'error' | 'pong'
  content: string
  done?: boolean
  session_id?: string
}

class HexClawWS {
  private ws: WebSocket | null = null
  private url = 'ws://localhost:16060/ws'

  private chunkCallbacks: ChunkCallback[] = []
  private replyCallbacks: ReplyCallback[] = []
  private errorCallbacks: ErrorCallback[] = []

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
        this.reconnectAttempts = 0
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

  sendMessage(content: string, sessionId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.errorCallbacks.forEach((cb) => cb('WebSocket is not connected'))
      return
    }

    const msg: WsMessage = {
      type: 'message',
      content,
      session_id: sessionId,
    }

    this.ws.send(JSON.stringify(msg))
    logger.debug(`→ ws: ${content.slice(0, 50)}...`)
  }

  onChunk(callback: ChunkCallback): void {
    this.chunkCallbacks.push(callback)
  }

  onReply(callback: ReplyCallback): void {
    this.replyCallbacks.push(callback)
  }

  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback)
  }

  /** Remove all registered callbacks (useful for re-registering) */
  clearCallbacks(): void {
    this.chunkCallbacks = []
    this.replyCallbacks = []
    this.errorCallbacks = []
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
        this.chunkCallbacks.forEach((cb) => cb(msg.content, !!msg.done))
        break
      case 'reply':
        this.replyCallbacks.forEach((cb) => cb(msg.content, msg.session_id || ''))
        break
      case 'error':
        this.errorCallbacks.forEach((cb) => cb(msg.content))
        break
      case 'pong':
        this.lastPongTime = Date.now()
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
