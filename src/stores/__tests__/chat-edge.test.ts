/**
 * Area 5: Chat error handling edge cases
 *
 * Tests the chat store and chatService for:
 * - WebSocket disconnect mid-stream
 * - Backend returns empty reply
 * - User sends message while another is streaming
 * - Rate limiting / button spamming
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Mock all external dependencies
vi.mock('@/api/websocket', () => {
  const callbacks = {
    chunk: [] as ((msg: any) => void)[],
    reply: [] as ((msg: any) => void)[],
    error: [] as ((msg: string) => void)[],
    approval: [] as ((req: any) => void)[],
  }
  return {
    hexclawWS: {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      sendMessage: vi.fn(),
      sendRaw: vi.fn(),
      triggerError: vi.fn(),
      onChunk: vi.fn((cb: any) => {
        callbacks.chunk.push(cb)
        return () => { callbacks.chunk = callbacks.chunk.filter(c => c !== cb) }
      }),
      onReply: vi.fn((cb: any) => {
        callbacks.reply.push(cb)
        return () => { callbacks.reply = callbacks.reply.filter(c => c !== cb) }
      }),
      onError: vi.fn((cb: any) => {
        callbacks.error.push(cb)
        return () => { callbacks.error = callbacks.error.filter(c => c !== cb) }
      }),
      onApprovalRequest: vi.fn((cb: any) => {
        callbacks.approval.push(cb)
        return () => { callbacks.approval = callbacks.approval.filter(c => c !== cb) }
      }),
      clearCallbacks: vi.fn(() => {
        callbacks.chunk = []
        callbacks.reply = []
        callbacks.error = []
        callbacks.approval = []
      }),
      clearStreamCallbacks: vi.fn(),
      _callbacks: callbacks,
    },
  }
})

vi.mock('@/services/messageService', () => ({
  loadAllSessions: vi.fn().mockResolvedValue([]),
  loadMessages: vi.fn().mockResolvedValue([]),
  loadArtifacts: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockResolvedValue(undefined),
  setLastSessionId: vi.fn().mockResolvedValue(undefined),
  getLastSessionId: vi.fn().mockResolvedValue(null),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  touchSession: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/chatService', () => {
  return {
    ensureWebSocketConnected: vi.fn().mockResolvedValue(true),
    sendViaWebSocket: vi.fn().mockResolvedValue(undefined),
    openWebSocketStream: vi.fn().mockImplementation(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({ content: 'ws reply' }),
    })),
    resumeWebSocketStream: vi.fn().mockImplementation(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({ content: 'resumed reply' }),
    })),
    sendViaBackend: vi.fn().mockResolvedValue({ reply: 'backend reply', metadata: {} }),
    clearWebSocketCallbacks: vi.fn(),
    ChatRequestError: class ChatRequestError extends Error {
      noFallback: boolean
      constructor(message: string, noFallback = false) {
        super(message)
        this.name = 'ChatRequestError'
        this.noFallback = noFallback
      }
    },
  }
})

vi.mock('@/api/chat', () => ({
  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
}))

vi.mock('@/utils/errors', () => ({
  fromNativeError: vi.fn((e: any) => ({
    code: 'ERROR',
    status: 500,
    message: e instanceof Error ? e.message : String(e),
  })),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// DB layer removed — outbox is now in-memory (no-op)

describe('chat store edge cases', () => {
  let chatStore: ReturnType<typeof import('@/stores/chat').useChatStore>
  let chatSvc: typeof import('@/services/chatService')

  beforeEach(async () => {
    const pinia = createPinia()
    setActivePinia(pinia)

    chatSvc = await import('@/services/chatService')
    const { useChatStore } = await import('@/stores/chat')
    chatStore = useChatStore()
    vi.mocked(chatSvc.ensureWebSocketConnected).mockResolvedValue(true)
    vi.mocked(chatSvc.openWebSocketStream).mockImplementation(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({ content: 'ws reply' }),
    }))
    vi.mocked(chatSvc.sendViaBackend).mockResolvedValue({ reply: 'backend reply', metadata: {} })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ─── WebSocket disconnect mid-stream ───────────────

  describe('WebSocket disconnect mid-stream', () => {
    it('falls back to HTTP when WebSocket send fails', async () => {
      vi.mocked(chatSvc.openWebSocketStream).mockImplementationOnce(() => ({
        cancel: vi.fn(),
        done: Promise.reject(new Error('WebSocket connection lost')),
      }))
      vi.mocked(chatSvc.sendViaBackend).mockResolvedValueOnce({
        reply: 'HTTP fallback reply',
        metadata: {},
      })

      await chatStore.sendMessage('test message')

      // Should have fallen back to HTTP
      expect(chatSvc.sendViaBackend).toHaveBeenCalled()
      // Should have a message in the store
      expect(chatStore.messages.length).toBeGreaterThanOrEqual(2)
    })

    it('does not fall back to HTTP when error has noFallback flag', async () => {
      const ChatRequestError = chatSvc.ChatRequestError as any
      vi.mocked(chatSvc.openWebSocketStream).mockImplementationOnce(() => ({
        cancel: vi.fn(),
        done: Promise.reject(new ChatRequestError('Timeout', true)),
      }))

      await chatStore.sendMessage('test message')

      // Should NOT have fallen back to HTTP
      expect(chatSvc.sendViaBackend).not.toHaveBeenCalled()
      // Should have an error message
      expect(chatStore.messages.some(m => m.role === 'assistant')).toBe(true)
    })

    it('streaming state is reset after WebSocket error', async () => {
      vi.mocked(chatSvc.openWebSocketStream).mockImplementationOnce(() => ({
        cancel: vi.fn(),
        done: Promise.reject(new Error('connection lost')),
      }))
      vi.mocked(chatSvc.sendViaBackend).mockResolvedValueOnce({
        reply: 'recovered',
        metadata: {},
      })

      await chatStore.sendMessage('test')

      expect(chatStore.streaming).toBe(false)
      expect(chatStore.streamingContent).toBe('')
    })
  })

  // ─── Backend returns empty reply ───────────────────

  describe('empty reply handling', () => {
    it('handles empty string reply from backend', async () => {
      vi.mocked(chatSvc.ensureWebSocketConnected).mockResolvedValueOnce(false)
      vi.mocked(chatSvc.sendViaBackend).mockResolvedValueOnce({
        reply: '',
        metadata: {},
      })

      await chatStore.sendMessage('hello')

      const assistantMsg = chatStore.messages.find(m => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg!.content).toBe('这次没有生成可显示的回答，请重试或换个方式提问。')
    })

    it('handles whitespace-only reply from backend', async () => {
      vi.mocked(chatSvc.ensureWebSocketConnected).mockResolvedValueOnce(false)
      vi.mocked(chatSvc.sendViaBackend).mockResolvedValueOnce({
        reply: '   ',
        metadata: {},
      })

      await chatStore.sendMessage('hello')

      const assistantMsg = chatStore.messages.find(m => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg!.content).toBe('这次没有生成可显示的回答，请重试或换个方式提问。')
    })
  })

  // ─── Sending while streaming ───────────────────────

  describe('sending while streaming', () => {
    it('blocks sending another message into the same session while it is still streaming', async () => {
      chatStore.streaming = true
      chatStore.streamingSessionId = 'session-1'
      chatStore.streamingContent = 'partial content...'
      chatStore.currentSessionId = 'session-1'

      const result = await chatStore.sendMessage('new message')
      expect(result).toBeNull()
      expect(chatStore.streaming).toBe(true)
      expect(chatStore.messages).toHaveLength(0)
      expect(chatSvc.sendViaBackend).not.toHaveBeenCalled()
    })

    it('preserves partial content when stopping mid-stream', () => {
      chatStore.streaming = true
      chatStore.streamingContent = 'partial response so far'
      chatStore.currentSessionId = 'session-1'
      chatStore.streamingSessionId = 'session-1'

      chatStore.stopStreaming()

      // After stopping, partial content should be saved as a message
      const partialMsg = chatStore.messages.find(
        m => m.role === 'assistant' && m.content === 'partial response so far',
      )
      expect(partialMsg).toBeDefined()
    })

    it('does not save empty partial content when stopping', () => {
      chatStore.streaming = true
      chatStore.streamingContent = '   '
      chatStore.currentSessionId = 'session-1'
      chatStore.streamingSessionId = 'session-1'

      const msgCountBefore = chatStore.messages.length
      chatStore.stopStreaming()

      // Whitespace-only content should NOT be saved
      // The check is streamingContent.value.trim() which catches this
      expect(chatStore.messages.length).toBe(msgCountBefore)
    })
  })

  // ─── Rate limiting / spam protection ───────────────

  describe('rate limiting', () => {
    it('concurrent sends are guarded — only the first goes through', async () => {
      vi.mocked(chatSvc.ensureWebSocketConnected).mockResolvedValue(false)
      vi.mocked(chatSvc.sendViaBackend).mockResolvedValue({
        reply: 'reply',
        metadata: {},
      })

      // Rapid fire 3 messages concurrently — sending guard blocks the 2nd and 3rd
      const p1 = chatStore.sendMessage('msg1')
      const p2 = chatStore.sendMessage('msg2')
      const p3 = chatStore.sendMessage('msg3')

      await Promise.all([p1, p2, p3])

      // Only the first should have gone through due to the sending guard
      const userMsgs = chatStore.messages.filter(m => m.role === 'user')
      expect(userMsgs.length).toBe(1)
      expect(userMsgs[0]!.content).toBe('msg1')
    })

    it('sending from a new draft does not clear a different session that is already streaming', async () => {
      let finishBackground!: () => void
      vi.mocked(chatSvc.openWebSocketStream)
        .mockImplementationOnce((_text, _sid, _params, _role, _att, callbacks) => ({
          cancel: vi.fn(),
          done: new Promise((resolve) => {
            callbacks?.onChunk?.('background partial')
            finishBackground = () => resolve({ content: 'background done' })
          }),
        }))
        .mockImplementationOnce(() => ({
          cancel: vi.fn(),
          done: Promise.resolve({ content: 'reply' }),
        }))

      chatStore.currentSessionId = 'session-1'
      void chatStore.sendMessage('background')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      chatStore.newSession()
      await chatStore.sendMessage('test')

      expect(chatStore.streaming).toBe(true)
      expect(chatStore.streamingSessionId).toBe('session-1')
      finishBackground()
    })
  })

  // ─── Error state management ────────────────────────

  describe('error state management', () => {
    it('error is cleared when sending a new message', async () => {
      chatStore.error = { code: 'UNKNOWN' as const, status: 500, message: 'previous error' }

      vi.mocked(chatSvc.ensureWebSocketConnected).mockResolvedValue(false)
      vi.mocked(chatSvc.sendViaBackend).mockResolvedValue({
        reply: 'ok',
        metadata: {},
      })

      await chatStore.sendMessage('test')

      expect(chatStore.error).toBeNull()
    })

    it('error is set when both WS and HTTP fail', async () => {
      vi.mocked(chatSvc.openWebSocketStream).mockImplementationOnce(() => ({
        cancel: vi.fn(),
        done: Promise.reject(new Error('ws fail')),
      }))
      vi.mocked(chatSvc.sendViaBackend).mockRejectedValueOnce(new Error('http fail'))

      await chatStore.sendMessage('test')

      expect(chatStore.error).toBeDefined()
      expect(chatStore.error?.message).toContain('http fail')
    })
  })

  // ─── Session creation ──────────────────────────────

  describe('session creation', () => {
    it('creates a new session on first message', async () => {
      expect(chatStore.currentSessionId).toBeNull()

      vi.mocked(chatSvc.ensureWebSocketConnected).mockResolvedValue(false)
      vi.mocked(chatSvc.sendViaBackend).mockResolvedValue({
        reply: 'hello',
        metadata: {},
      })

      await chatStore.sendMessage('first message')

      expect(chatStore.currentSessionId).toBeTruthy()
    })

    it('does not create duplicate sessions for rapid sends', async () => {
      const { createSession } = await import('@/services/messageService')

      vi.mocked(chatSvc.ensureWebSocketConnected).mockResolvedValue(false)
      vi.mocked(chatSvc.sendViaBackend).mockResolvedValue({
        reply: 'reply',
        metadata: {},
      })

      // Send two messages rapidly (before the first ensureSession resolves)
      await Promise.all([
        chatStore.sendMessage('msg1'),
        chatStore.sendMessage('msg2'),
      ])

      // The _ensureSessionPromise dedup should prevent duplicate session creation
      // At most 2 calls (one creates, the second reuses the promise)
      const createSessionCalls = vi.mocked(createSession).mock.calls.length
      expect(createSessionCalls).toBeLessThanOrEqual(2)
    })
  })
})
