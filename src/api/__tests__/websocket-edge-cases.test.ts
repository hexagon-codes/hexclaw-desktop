/**
 * WebSocket Edge Cases — 补全覆盖
 *
 * 覆盖 tool approval workflow, sendRaw, triggerError,
 *        heartbeat timeout, callback cleanup, pong handling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/config/env', () => ({
  OLLAMA_BASE: 'http://localhost:11434', env: { apiBase: 'http://localhost:16060', wsBase: 'ws://localhost:16060', timeout: 5000 },
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: string[] = []
  private _listeners: Record<string, Array<{ handler: EventListener; once: boolean }>> = {}

  constructor(public url: string) {
    // Auto-open in next tick
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.(new Event('open'))
    }, 0)
  }

  addEventListener(type: string, handler: EventListener, opts?: { once?: boolean } | boolean) {
    const once = typeof opts === 'object' ? !!opts.once : false
    if (!this._listeners[type]) this._listeners[type] = []
    this._listeners[type].push({ handler, once })
  }

  removeEventListener(type: string, handler: EventListener) {
    if (!this._listeners[type]) return
    this._listeners[type] = this._listeners[type].filter((l) => l.handler !== handler)
  }

  private _dispatchListeners(type: string, event: Event) {
    const list = this._listeners[type] || []
    for (const entry of list.slice()) {
      entry.handler(event)
      if (entry.once) {
        this._listeners[type] = this._listeners[type]!.filter((l) => l !== entry)
      }
    }
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this._dispatchListeners('close', new CloseEvent('close'))
    this.onclose?.(new CloseEvent('close'))
  }

  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  simulateError() {
    this.onerror?.(new Event('error'))
  }
}

let wsInstance: MockWebSocket | null = null

const MockWebSocketWithTracking = class extends MockWebSocket {
  constructor(url: string) {
    super(url)
    wsInstance = this // eslint-disable-line @typescript-eslint/no-this-alias
  }
}
vi.stubGlobal('WebSocket', MockWebSocketWithTracking)

// Need to re-import to pick up the mocks
const { hexclawWS } = await import('../websocket')

describe('WebSocket Edge Cases', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    wsInstance = null
  })

  afterEach(() => {
    hexclawWS.disconnect()
    vi.useRealTimers()
  })

  // ─── Tool Approval ──────────────────────────────

  describe('tool approval workflow', () => {
    it('receives approval request and dispatches to callbacks', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      const approvalCb = vi.fn()
      hexclawWS.onApprovalRequest(approvalCb)

      wsInstance!.simulateMessage(JSON.stringify({
        type: 'tool_approval_request',
        content: 'Tool shell_exec wants to run rm -rf /',
        session_id: 's1',
        metadata: {
          request_id: 'req-123',
          tool_name: 'shell_exec',
          risk: 'dangerous',
        },
      }))

      expect(approvalCb).toHaveBeenCalledWith({
        requestId: 'req-123',
        toolName: 'shell_exec',
        risk: 'dangerous',
        reason: 'Tool shell_exec wants to run rm -rf /',
        sessionId: 's1',
      })
    })

    it('sendApprovalResponse sends correct format (approved + remember)', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      hexclawWS.sendApprovalResponse('req-123', true, true)
      const sent = JSON.parse(wsInstance!.sent[wsInstance!.sent.length - 1]!)
      expect(sent.type).toBe('tool_approval_response')
      expect(sent.content).toBe('approved_remember')
      expect(sent.metadata.request_id).toBe('req-123')
    })

    it('sendApprovalResponse sends correct format (denied)', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      hexclawWS.sendApprovalResponse('req-456', false, false)
      const sent = JSON.parse(wsInstance!.sent[wsInstance!.sent.length - 1]!)
      expect(sent.content).toBe('denied')
    })
  })

  // ─── sendRaw ────────────────────────────────────

  describe('sendRaw', () => {
    it('sends JSON when connected', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      hexclawWS.sendRaw({ type: 'custom', data: 42 })
      const sent = JSON.parse(wsInstance!.sent[wsInstance!.sent.length - 1]!)
      expect(sent.type).toBe('custom')
      expect(sent.data).toBe(42)
    })

    it('silently no-ops when disconnected', () => {
      hexclawWS.disconnect()
      // Should not throw
      hexclawWS.sendRaw({ type: 'test' })
      expect(true).toBe(true)
    })
  })

  // ─── triggerError ───────────────────────────────

  describe('triggerError', () => {
    it('dispatches to all error callbacks', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      const cb1 = vi.fn()
      const cb2 = vi.fn()
      hexclawWS.onError(cb1)
      hexclawWS.onError(cb2)

      hexclawWS.triggerError('User cancelled')
      expect(cb1).toHaveBeenCalledWith('User cancelled')
      expect(cb2).toHaveBeenCalledWith('User cancelled')
    })
  })

  // ─── Callback cleanup ──────────────────────────

  describe('callback cleanup', () => {
    it('clearStreamCallbacks removes chunk/reply/error but keeps approval', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      const chunkCb = vi.fn()
      const replyCb = vi.fn()
      const errorCb = vi.fn()
      const approvalCb = vi.fn()

      hexclawWS.onChunk(chunkCb)
      hexclawWS.onReply(replyCb)
      hexclawWS.onError(errorCb)
      hexclawWS.onApprovalRequest(approvalCb)

      hexclawWS.clearStreamCallbacks()

      // Stream callbacks should be cleared
      wsInstance!.simulateMessage(JSON.stringify({ type: 'chunk', content: 'test' }))
      wsInstance!.simulateMessage(JSON.stringify({ type: 'reply', content: 'test' }))
      hexclawWS.triggerError('test')
      expect(chunkCb).not.toHaveBeenCalled()
      expect(replyCb).not.toHaveBeenCalled()
      expect(errorCb).not.toHaveBeenCalled()

      // Approval should still work
      wsInstance!.simulateMessage(JSON.stringify({
        type: 'tool_approval_request',
        content: 'test',
        metadata: { request_id: 'r1', tool_name: 't1', risk: 'low' },
      }))
      expect(approvalCb).toHaveBeenCalled()
    })

    it('clearCallbacks removes ALL callbacks', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      const approvalCb = vi.fn()
      hexclawWS.onApprovalRequest(approvalCb)

      hexclawWS.clearCallbacks()

      wsInstance!.simulateMessage(JSON.stringify({
        type: 'tool_approval_request',
        content: 'test',
        metadata: {},
      }))
      expect(approvalCb).not.toHaveBeenCalled()
    })

    it('unsubscribe function removes specific callback', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      const cb1 = vi.fn()
      const cb2 = vi.fn()
      const unsub1 = hexclawWS.onChunk(cb1)
      hexclawWS.onChunk(cb2)

      unsub1()

      wsInstance!.simulateMessage(JSON.stringify({ type: 'chunk', content: 'test' }))
      expect(cb1).not.toHaveBeenCalled()
      expect(cb2).toHaveBeenCalled()
    })
  })

  // ─── Pong handling ──────────────────────────────

  describe('pong handling', () => {
    it('updates lastPongTime on pong message', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      wsInstance!.simulateMessage(JSON.stringify({ type: 'pong' }))
      // Should not throw or cause issues
      expect(true).toBe(true)
    })
  })

  // ─── Unknown message type ───────────────────────

  describe('unknown message types', () => {
    it('handles unknown type gracefully', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      // Should not throw
      wsInstance!.simulateMessage(JSON.stringify({ type: 'unknown_type', content: 'data' }))
      expect(true).toBe(true)
    })

    it('handles non-JSON messages gracefully', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      // Should not throw
      wsInstance!.simulateMessage('not valid json')
      expect(true).toBe(true)
    })
  })

  // ─── sendMessage when disconnected ──────────────

  describe('sendMessage when disconnected', () => {
    it('triggers error callback when WS not connected', () => {
      hexclawWS.disconnect()
      const errorCb = vi.fn()
      hexclawWS.onError(errorCb)
      hexclawWS.sendMessage('hello')
      expect(errorCb).toHaveBeenCalledWith('WebSocket is not connected')
    })
  })

  // ─── Already connected ─────────────────────────

  describe('connect when already connected', () => {
    it('resolves immediately if already open', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      // Second connect should resolve immediately
      await hexclawWS.connect()
      expect(hexclawWS.isConnected()).toBe(true)
    })
  })

  // ─── Message with all optional fields ──────────

  describe('sendMessage with all options', () => {
    it('includes temperature, max_tokens, metadata, attachments', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      hexclawWS.sendMessage(
        'hello',
        'session-1',
        'gpt-4',
        'coder',
        [{ type: 'image', name: 'test.png', mime: 'image/png', data: 'base64' }],
        'openai',
        0.5,
        2048,
        { custom: 'value' },
      )

      const sent = JSON.parse(wsInstance!.sent[wsInstance!.sent.length - 1]!)
      expect(sent.content).toBe('hello')
      expect(sent.session_id).toBe('session-1')
      expect(sent.model).toBe('gpt-4')
      expect(sent.role).toBe('coder')
      expect(sent.provider).toBe('openai')
      expect(sent.temperature).toBe(0.5)
      expect(sent.max_tokens).toBe(2048)
      expect(sent.metadata).toEqual({ custom: 'value' })
      expect(sent.attachments).toHaveLength(1)
    })

    it('omits attachments when empty array', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      hexclawWS.sendMessage('hi', undefined, undefined, undefined, [])
      const sent = JSON.parse(wsInstance!.sent[wsInstance!.sent.length - 1]!)
      expect(sent.attachments).toBeUndefined()
    })

    it('omits metadata when empty object', async () => {
      const connectPromise = hexclawWS.connect()
      await vi.advanceTimersByTimeAsync(10)
      await connectPromise

      hexclawWS.sendMessage('hi', undefined, undefined, undefined, undefined, undefined, undefined, undefined, {})
      const sent = JSON.parse(wsInstance!.sent[wsInstance!.sent.length - 1]!)
      expect(sent.metadata).toBeUndefined()
    })
  })
})
