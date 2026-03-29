/**
 * Chain A: Chat -> Backend -> Response
 *
 * Tests the full chat message lifecycle from the frontend perspective:
 * user message creation, backend API dispatch, streaming, error handling,
 * session management, and title derivation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// ── Hoisted mocks ──────────────────────────────────────────────────

const {
  loadAllSessions,
  loadMessages,
  createSession,
  updateSessionTitle,
  touchSession,
  deleteSvcSession,
  persistMessage,
  removeMessage,
  loadArtifacts,
  saveArtifact,
  getLastSessionId,
  setLastSessionId,
  ensureWebSocketConnected,
  sendViaWebSocket,
  sendViaBackend,
  clearWebSocketCallbacks,
  outboxInsert,
  outboxMarkSending,
  outboxMarkSent,
  outboxMarkFailed,
  retryPendingOutbox,
  cleanupOutbox,
} = vi.hoisted(() => ({
  loadAllSessions: vi.fn().mockResolvedValue([]),
  loadMessages: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  touchSession: vi.fn().mockResolvedValue(undefined),
  deleteSvcSession: vi.fn().mockResolvedValue(undefined),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  removeMessage: vi.fn().mockResolvedValue(undefined),
  loadArtifacts: vi.fn().mockResolvedValue([]),
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  getLastSessionId: vi.fn().mockResolvedValue(null),
  setLastSessionId: vi.fn().mockResolvedValue(undefined),
  ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
  sendViaWebSocket: vi.fn().mockResolvedValue(undefined),
  sendViaBackend: vi.fn().mockResolvedValue({ reply: 'Hello!', session_id: 's1' }),
  clearWebSocketCallbacks: vi.fn(),
  outboxInsert: vi.fn().mockResolvedValue(undefined),
  outboxMarkSending: vi.fn().mockResolvedValue(undefined),
  outboxMarkSent: vi.fn().mockResolvedValue(undefined),
  outboxMarkFailed: vi.fn().mockResolvedValue(undefined),
  retryPendingOutbox: vi.fn(),
  cleanupOutbox: vi.fn(),
}))

// ── Module mocks ───────────────────────────────────────────────────

vi.mock('@/services/messageService', () => ({
  loadAllSessions,
  loadMessages,
  createSession,
  updateSessionTitle,
  touchSession,
  deleteSession: deleteSvcSession,
  persistMessage,
  removeMessage,
  loadArtifacts,
  saveArtifact,
  getLastSessionId,
  setLastSessionId,
  parseMessageMetadata: vi.fn(),
  normalizeLoadedMessage: vi.fn(),
  serializeMessageMetadata: vi.fn(),
}))

vi.mock('@/services/chatService', () => {
  class ChatRequestError extends Error {
    noFallback: boolean
    constructor(message: string, noFallback = false) {
      super(message)
      this.name = 'ChatRequestError'
      this.noFallback = noFallback
    }
  }
  return {
    ensureWebSocketConnected,
    sendViaWebSocket,
    sendViaBackend,
    clearWebSocketCallbacks,
    outboxInsert,
    outboxMarkSending,
    outboxMarkSent,
    outboxMarkFailed,
    retryPendingOutbox,
    cleanupOutbox,
    ChatRequestError,
    withTimeout: vi.fn((p: Promise<unknown>) => p),
  }
})

vi.mock('@/api/messages', () => ({
  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    onApprovalRequest: vi.fn(() => () => {}),
    sendApprovalResponse: vi.fn(),
    sendRaw: vi.fn(),
    disconnect: vi.fn(),
  },
}))

vi.mock('@/db/chat', () => ({
  dbGetSessions: vi.fn().mockResolvedValue([]),
  dbGetMessages: vi.fn().mockResolvedValue([]),
  dbCreateSession: vi.fn(),
  dbUpdateSessionTitle: vi.fn(),
  dbTouchSession: vi.fn(),
  dbDeleteSession: vi.fn(),
  dbSaveMessage: vi.fn(),
  dbDeleteMessage: vi.fn(),
}))

vi.mock('@/db/artifacts', () => ({
  dbGetArtifacts: vi.fn().mockResolvedValue([]),
  dbSaveArtifact: vi.fn(),
  dbDeleteSessionArtifacts: vi.fn(),
}))

vi.mock('@/db/connection', () => ({
  dbGetAppState: vi.fn().mockResolvedValue(null),
  dbSetAppState: vi.fn(),
  getDB: vi.fn(),
}))

vi.mock('@/db/outbox', () => ({
  dbOutboxInsert: vi.fn(),
  dbOutboxMarkSending: vi.fn(),
  dbOutboxMarkSent: vi.fn(),
  dbOutboxMarkFailed: vi.fn(),
  dbOutboxGetPending: vi.fn().mockResolvedValue([]),
  dbOutboxCleanup: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  const store = new Map()
  return {
    load: vi.fn().mockResolvedValue({
      get: vi.fn((key: string) => Promise.resolve(store.get(key))),
      set: vi.fn((key: string, val: unknown) => { store.set(key, val); return Promise.resolve() }),
      save: vi.fn().mockResolvedValue(undefined),
    }),
    LazyStore: class {
      private _data = new Map()
      async get(key: string) { return this._data.get(key) ?? null }
      async set(key: string, val: unknown) { this._data.set(key, val) }
      async save() {}
    },
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('{}'),
}))

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  ensureWebSocketConnected.mockResolvedValue(false)
  sendViaBackend.mockResolvedValue({ reply: 'Hello!', session_id: 's1' })
  loadAllSessions.mockResolvedValue([
    { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 0 },
  ])
  loadMessages.mockResolvedValue([])
  loadArtifacts.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Chain A: Chat -> Backend -> Response', () => {
  it('A1: sendMessage creates a user message in the store immediately', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Use a slow backend to observe user message appears before reply
    let resolveBackend: ((v: unknown) => void) | null = null
    sendViaBackend.mockImplementation(() => new Promise((resolve) => { resolveBackend = resolve }))

    const promise = store.sendMessage('What is AI?')

    // Allow microtasks to flush so sendMessage reaches the await point
    await new Promise((r) => setTimeout(r, 10))

    // User message should already be in the store before backend responds
    expect(store.messages.length).toBe(1)
    expect(store.messages[0]!.role).toBe('user')
    expect(store.messages[0]!.content).toBe('What is AI?')

    // Resolve backend and complete
    resolveBackend!({ reply: 'AI is...', session_id: 's1' })
    await promise
  })

  it('A2: sendMessage calls the backend chat API with correct payload shape', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.chatParams = { provider: 'openai', model: 'gpt-4o', temperature: 0.8, maxTokens: 2048 }
    store.agentRole = 'coder'

    await store.sendMessage('Write code')

    expect(sendViaBackend).toHaveBeenCalledWith(
      'Write code',           // text
      expect.any(String),     // sessionId
      { provider: 'openai', model: 'gpt-4o', temperature: 0.8, maxTokens: 2048 },
      'coder',                // agentRole
      undefined,              // attachments
    )
  })

  it('A3: streaming response chunks append to assistant message', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    sendViaWebSocket.mockImplementation(
      (_text: string, _sid: string, _params: unknown, _role: string, _att: unknown, callbacks: Record<string, (...args: unknown[]) => unknown>) => {
        callbacks.onChunk?.('Part 1 ')
        callbacks.onChunk?.('Part 2 ')
        callbacks.onChunk?.('Part 3')
        callbacks.onDone?.('Part 1 Part 2 Part 3', { model: 'gpt-4o' })
        return Promise.resolve()
      },
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.currentSessionId = 's1'

    const result = await store.sendMessage('Stream test')

    expect(result).not.toBeNull()
    const assistantMsg = store.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.content).toBe('Part 1 Part 2 Part 3')
  })

  it('A4: error during chat sets error state on the message', async () => {
    sendViaBackend.mockRejectedValueOnce(new Error('Backend unavailable'))

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const result = await store.sendMessage('This will fail')

    // sendMessage returns null on error
    expect(result).toBeNull()
    // An error assistant message is added to store
    expect(store.error).not.toBeNull()
    const errorMsg = store.messages.find((m) => m.role === 'assistant' && m.content.includes('Backend unavailable'))
    expect(errorMsg).toBeDefined()
  })

  it('A5: stopStreaming aborts the current request', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    // Simulate a WS send that never completes naturally
    sendViaWebSocket.mockImplementation(
      (_text: string, _sid: string, _params: unknown, _role: string, _att: unknown, callbacks: Record<string, (...args: unknown[]) => unknown>) => {
        callbacks.onChunk?.('Partial content')
        // Never calls onDone - simulating long-running stream
        return Promise.resolve()
      },
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.currentSessionId = 's1'

    await store.sendMessage('Long stream')

    // Now manually start streaming state and stop
    store.streaming = true
    store.streamingContent = 'Some partial content'
    store.streamingSessionId = 's1'

    store.stopStreaming()

    expect(store.streaming).toBe(false)
    expect(store.streamingContent).toBe('')
    expect(store.streamingSessionId).toBeNull()
    expect(clearWebSocketCallbacks).toHaveBeenCalled()
  })

  it('A6: chat history is loaded from backend on mount (loadSessions)', async () => {
    const sessions = [
      { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 2 },
      { id: 's2', title: 'Session 2', created_at: '2026-01-02', updated_at: '2026-01-02', message_count: 5 },
    ]
    loadAllSessions.mockResolvedValueOnce(sessions)

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.loadSessions()

    expect(loadAllSessions).toHaveBeenCalled()
    expect(store.sessions).toHaveLength(2)
    expect(store.sessions[0]!.id).toBe('s1')
    expect(store.sessions[1]!.id).toBe('s2')
    expect(retryPendingOutbox).toHaveBeenCalled()
    expect(cleanupOutbox).toHaveBeenCalled()
  })

  it('A7: delete session calls correct backend endpoint', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.sessions = [
      { id: 's1', title: 'Test', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 1 },
    ]
    store.currentSessionId = 's1'
    store.messages = [
      { id: 'm1', role: 'user', content: 'hi', timestamp: '2026-01-01' },
    ]

    await store.deleteSession('s1')

    expect(deleteSvcSession).toHaveBeenCalledWith('s1')
    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.sessions.find((s) => s.id === 's1')).toBeUndefined()
  })

  it('A8: session title is derived from first user message', async () => {
    sendViaBackend.mockResolvedValueOnce({ reply: 'Sure, let me explain.', session_id: 's-new' })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.newSession()

    await store.sendMessage('Explain quantum computing in simple terms')

    // updateSessionTitle should be called with truncated user text
    expect(updateSessionTitle).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Explain quantum computing'),
    )
  })

  it('A8b: session title is NOT derived if a custom title was given via newSession(title)', async () => {
    sendViaBackend.mockResolvedValueOnce({ reply: 'Sure.', session_id: 's-new' })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.newSession('My Custom Title')

    await store.sendMessage('Some message')

    // updateSessionTitle should NOT be called when hasCustomTitle is true
    expect(updateSessionTitle).not.toHaveBeenCalled()
  })
})
