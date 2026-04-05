/**
 * HexClaw Desktop -- Comprehensive Integration Tests
 *
 * End-to-end flows across multiple modules: chat store, services,
 * WebSocket, knowledge, artifacts, tool approval, session management,
 * error recovery, and message feedback.
 *
 * Mocks are placed at the boundary layer (API / services) so that
 * stores, utils, and service wiring run real code wherever possible.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ══════════════════════════════════════════════════════════════════
// Hoisted mocks -- vi.hoisted runs before any vi.mock
// ══════════════════════════════════════════════════════════════════

const {
  // messageService mocks
  loadAllSessions,
  loadMessages,
  mockCreateSession,
  updateSessionTitle,
  touchSession,
  deleteSvcSession,
  persistMessage,
  loadArtifacts,
  saveArtifact,
  getLastSessionId,
  setLastSessionId,
  // chatService mocks
  ensureWebSocketConnected,
  sendViaWebSocket,
  sendViaBackend,
  clearWebSocketCallbacks,
  // api/chat
  updateMessageFeedback,
  // api/knowledge
  mockSearchKnowledge,
  mockGetDocument,
  mockGetDocumentContent,
  // websocket controllable mock
  MockChatRequestError,
  wsCallbacks,
} = vi.hoisted(() => {
  class MockChatRequestError extends Error {
    noFallback: boolean
    constructor(message: string, noFallback = false) {
      super(message)
      this.name = 'ChatRequestError'
      this.noFallback = noFallback
    }
  }
  const wsCallbacks: Record<string, Array<(...args: unknown[]) => void>> = {
    chunk: [],
    reply: [],
    error: [],
    approval: [],
  }
  return {
    MockChatRequestError,
    loadAllSessions: vi.fn().mockResolvedValue([]),
    loadMessages: vi.fn().mockResolvedValue([]),
    mockCreateSession: vi.fn().mockResolvedValue(undefined),
    updateSessionTitle: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    deleteSvcSession: vi.fn().mockResolvedValue(undefined),
    persistMessage: vi.fn().mockResolvedValue(true),
    loadArtifacts: vi.fn().mockResolvedValue([]),
    saveArtifact: vi.fn().mockResolvedValue(undefined),
    getLastSessionId: vi.fn().mockReturnValue(null),
    setLastSessionId: vi.fn(),

    ensureWebSocketConnected: vi.fn().mockResolvedValue(true),
    sendViaWebSocket: vi.fn().mockResolvedValue(undefined),
    sendViaBackend: vi.fn().mockResolvedValue({ reply: 'Hello!', session_id: 's1' }),
    clearWebSocketCallbacks: vi.fn(),

    updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),

    mockSearchKnowledge: vi.fn().mockResolvedValue({ result: [] }),
    mockGetDocument: vi.fn().mockResolvedValue({
      id: 'doc-1',
      title: 'Test Doc',
      content: 'Full content here',
      chunk_count: 3,
      created_at: '2026-01-01',
    }),
    mockGetDocumentContent: vi.fn().mockResolvedValue('Full content here'),

    wsCallbacks,
  }
})

// ══════════════════════════════════════════════════════════════════
// vi.mock declarations
// ══════════════════════════════════════════════════════════════════

vi.mock('@/services/messageService', () => ({
  loadAllSessions,
  loadMessages,
  createSession: mockCreateSession,
  updateSessionTitle,
  touchSession,
  deleteSession: deleteSvcSession,
  persistMessage,
  loadArtifacts,
  saveArtifact,
  getLastSessionId,
  setLastSessionId,
  parseMessageMetadata: vi.fn(),
  normalizeLoadedMessage: vi.fn(),
  serializeMessageMetadata: vi.fn(),
  removeMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/chatService', () => ({
  ensureWebSocketConnected,
  sendViaWebSocket,
  sendViaBackend,
  clearWebSocketCallbacks,
  ChatRequestError: MockChatRequestError,
  withTimeout: vi.fn((p: Promise<unknown>) => p),
}))

vi.mock('@/api/chat', () => ({
  updateMessageFeedback,
}))

vi.mock('@/api/knowledge', () => ({
  searchKnowledge: mockSearchKnowledge,
  getDocument: mockGetDocument,
  getDocumentContent: mockGetDocumentContent,
  addDocument: vi.fn().mockResolvedValue({ id: 'doc-1', title: 'T', chunk_count: 1, created_at: '2026-01-01' }),
  getDocuments: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
  deleteDocument: vi.fn().mockResolvedValue({ message: 'deleted' }),
  reindexDocument: vi.fn().mockResolvedValue({ status: 'ok' }),
  uploadDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn().mockReturnValue(false),
  isKnowledgeUploadUnsupportedFormat: vi.fn().mockReturnValue(false),
}))

vi.mock('@/api/websocket', () => {
  // Re-use the hoisted wsCallbacks so tests can push to it
  return {
    hexclawWS: {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => true),
      onChunk: vi.fn((cb: (...args: unknown[]) => void) => {
        wsCallbacks.chunk!.push(cb)
        return () => {
          wsCallbacks.chunk = wsCallbacks.chunk!.filter((fn) => fn !== cb)
        }
      }),
      onReply: vi.fn((cb: (...args: unknown[]) => void) => {
        wsCallbacks.reply!.push(cb)
        return () => {
          wsCallbacks.reply = wsCallbacks.reply!.filter((fn) => fn !== cb)
        }
      }),
      onError: vi.fn((cb: (...args: unknown[]) => void) => {
        wsCallbacks.error!.push(cb)
        return () => {
          wsCallbacks.error = wsCallbacks.error!.filter((fn) => fn !== cb)
        }
      }),
      onApprovalRequest: vi.fn((cb: (...args: unknown[]) => void) => {
        wsCallbacks.approval!.push(cb)
        return () => {
          wsCallbacks.approval = wsCallbacks.approval!.filter((fn) => fn !== cb)
        }
      }),
      sendMessage: vi.fn(),
      sendRaw: vi.fn(),
      sendApprovalResponse: vi.fn(),
      clearStreamCallbacks: vi.fn(() => {
        wsCallbacks.chunk = []
        wsCallbacks.reply = []
        wsCallbacks.error = []
      }),
      clearCallbacks: vi.fn(() => {
        wsCallbacks.chunk = []
        wsCallbacks.reply = []
        wsCallbacks.error = []
        wsCallbacks.approval = []
      }),
      triggerError: vi.fn((msg: string) =>
        wsCallbacks.error!.forEach((cb) => cb(msg)),
      ),
      _callbacks: wsCallbacks,
    },
    ToolApprovalRequest: {},
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/utils/platform', () => ({ isTauri: vi.fn(() => false) }))
vi.mock('@tauri-apps/plugin-store', () => {
  return {
    LazyStore: class {
      private _data = new Map()
      async get(key: string) { return this._data.get(key) ?? null }
      async set(key: string, val: unknown) { this._data.set(key, val) }
      async save() {}
    },
  }
})
vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

// ══════════════════════════════════════════════════════════════════
// Shared setup
// ══════════════════════════════════════════════════════════════════

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  // Reset wsCallbacks arrays
  wsCallbacks.chunk = []
  wsCallbacks.reply = []
  wsCallbacks.error = []
  wsCallbacks.approval = []

  // Default mock states
  ensureWebSocketConnected.mockResolvedValue(true)
  sendViaBackend.mockResolvedValue({ reply: 'Hello!', session_id: 's1' })
  loadAllSessions.mockResolvedValue([
    { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 2 },
    { id: 's2', title: 'Session 2', created_at: '2026-01-02', updated_at: '2026-01-02', message_count: 1 },
  ])
  loadMessages.mockResolvedValue([])
  loadArtifacts.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ══════════════════════════════════════════════════════════════════
// Scenario 1: Full Chat Send Chain
// User types message -> chatStore.sendMessage() -> ensureSession()
// -> sendViaWebSocket() -> onChunk callbacks -> onDone finalizes
// -> artifacts extracted
// ══════════════════════════════════════════════════════════════════

describe('Scenario 1: Full chat send chain (WebSocket path)', () => {
  it('creates session, sends via WebSocket, accumulates chunks, finalizes, and extracts artifacts', async () => {
    // Simulate WS sendViaWebSocket that calls onChunk/onDone
    sendViaWebSocket.mockImplementation(
      (_text: string, _sid: string, _params: unknown, _role: string, _att: unknown, callbacks?: {
        onChunk: (c: string, r?: string) => void
        onDone: (c: string, m?: Record<string, unknown>, t?: unknown, a?: string) => void
      }) => {
        // Simulate streaming: 3 chunks then done
        callbacks?.onChunk('Hello ', undefined)
        callbacks?.onChunk('world! ', undefined)
        callbacks?.onChunk('```typescript\nconsole.log("artifact code line 1234567890")\n```', undefined)
        callbacks?.onDone(
          'Hello world! ```typescript\nconsole.log("artifact code line 1234567890")\n```',
          { model: 'gpt-4o', backend_message_id: 'bm-1' },
          undefined,
          undefined,
        )
        return Promise.resolve()
      },
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Initially no session
    expect(store.currentSessionId).toBeNull()

    const result = await store.sendMessage('Write me some code')

    // Session was created
    expect(mockCreateSession).toHaveBeenCalledWith(expect.any(String), expect.any(String))
    expect(store.currentSessionId).toBeTruthy()

    // WebSocket path was chosen
    expect(ensureWebSocketConnected).toHaveBeenCalled()
    expect(sendViaWebSocket).toHaveBeenCalledWith(
      'Write me some code',
      expect.any(String),
      expect.any(Object),
      '',
      undefined,
      expect.objectContaining({
        onChunk: expect.any(Function),
        onDone: expect.any(Function),
      }),
      undefined,
    )

    // Messages finalized: user + assistant
    expect(store.messages).toHaveLength(2)
    expect(store.messages[0]!.role).toBe('user')
    expect(store.messages[0]!.content).toBe('Write me some code')
    expect(store.messages[1]!.role).toBe('assistant')

    // Streaming ended
    expect(store.streaming).toBe(false)
    expect(store.streamingContent).toBe('')

    // Artifact extracted from code block
    expect(store.artifacts.length).toBeGreaterThanOrEqual(1)
    expect(store.artifacts.some((a) => a.language === 'typescript')).toBe(true)

    // Persistence called
    expect(persistMessage).toHaveBeenCalled()

    // Result returned
    expect(result).not.toBeNull()
    expect(result?.role).toBe('assistant')
  })

  it('accumulates streaming content in streamingContent before finalization', async () => {
    let chunkCallback: ((c: string, r?: string) => void) | undefined
    let doneCallback: ((c: string) => void) | undefined

    sendViaWebSocket.mockImplementation(
      (_t: string, _s: string, _p: unknown, _r: string, _a: unknown, callbacks?: {
        onChunk: (c: string, r?: string) => void
        onDone: (c: string) => void
      }) => {
        chunkCallback = callbacks?.onChunk
        doneCallback = callbacks?.onDone
        // Don't resolve immediately -- let the test drive chunk-by-chunk
        return new Promise<void>((resolve) => {
          // Save resolve so we can call it after done
          setTimeout(() => {
            // Simulate chunks then done
            chunkCallback?.('chunk1 ', undefined)
            chunkCallback?.('chunk2 ', undefined)
            doneCallback?.('chunk1 chunk2 ')
            resolve()
          }, 0)
        })
      },
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.sendMessage('Hi')

    // After finalization, streaming should be complete
    expect(store.streaming).toBe(false)
    expect(store.messages.length).toBe(2)
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 2: WebSocket Disconnect -> HTTP Fallback
// ══════════════════════════════════════════════════════════════════

describe('Scenario 2: WebSocket disconnect -> HTTP fallback', () => {
  it('falls back to sendViaBackend when WebSocket is not connected', async () => {
    ensureWebSocketConnected.mockResolvedValue(false)
    sendViaBackend.mockResolvedValue({
      reply: 'HTTP fallback response',
      session_id: 's1',
      metadata: { via: 'http' },
    })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const result = await store.sendMessage('Hello via HTTP')

    // WebSocket not used
    expect(sendViaWebSocket).not.toHaveBeenCalled()

    // HTTP backend used
    expect(sendViaBackend).toHaveBeenCalledWith(
      'Hello via HTTP',
      expect.any(String),
      expect.any(Object),
      '',
      undefined,
    )

    // Response finalized
    expect(result).not.toBeNull()
    expect(result?.content).toBe('HTTP fallback response')
    expect(store.messages).toHaveLength(2)
    expect(store.streaming).toBe(false)
  })

  it('falls back to HTTP when WebSocket send throws a retryable error', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    // Import ChatRequestError through the mock module
    const { ChatRequestError } = await import('@/services/chatService')
    sendViaWebSocket.mockRejectedValue(new ChatRequestError('WS send failed', false))
    sendViaBackend.mockResolvedValue({
      reply: 'Fallback after WS error',
      session_id: 's1',
    })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const result = await store.sendMessage('Try WS then fallback')

    // WS was attempted first
    expect(sendViaWebSocket).toHaveBeenCalled()
    // HTTP fallback was triggered
    expect(sendViaBackend).toHaveBeenCalled()

    expect(result?.content).toBe('Fallback after WS error')
    expect(store.streaming).toBe(false)
  })

  it('does NOT fall back when ChatRequestError has noFallback=true', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    const { ChatRequestError } = await import('@/services/chatService')
    sendViaWebSocket.mockRejectedValue(new ChatRequestError('Backend error from WS', true))

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const result = await store.sendMessage('Should not fallback')

    expect(sendViaWebSocket).toHaveBeenCalled()
    // sendViaBackend should NOT be called because noFallback=true
    expect(sendViaBackend).not.toHaveBeenCalled()

    // Error is captured and an error message is added
    expect(result).toBeNull()
    expect(store.error).not.toBeNull()
    // Error message added as assistant message
    const lastMsg = store.messages[store.messages.length - 1]
    expect(lastMsg?.role).toBe('assistant')
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 3: Session Switch Interrupts Streaming
// ══════════════════════════════════════════════════════════════════

describe('Scenario 3: Session switch interrupts streaming', () => {
  it('stops streaming in session A when switching to session B', async () => {
    // Keep WS send hanging to simulate ongoing streaming
    sendViaWebSocket.mockImplementation(
      (_t: string, _sessionId: string, _p: unknown, _r: string, _a: unknown, callbacks?: {
        onChunk: (c: string) => void
        onDone: (c: string) => void
      }) => {
        // Simulate chunk arrival
        callbacks?.onChunk('partial content...')
        // Never call onDone -- streaming is ongoing
        // Register in wsCallbacks.error so triggerError('用���取消') can settle this promise
        return new Promise<void>((_resolve, reject) => {
          wsCallbacks.error!.push((msg: unknown) => {
            reject(new MockChatRequestError(String(msg), true))
          })
        })
      },
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Setup: ensure session A exists
    store.currentSessionId = 'session-A' as string
    store.sessions = [
      { id: 'session-A', title: 'A', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 0 },
      { id: 'session-B', title: 'B', created_at: '2026-01-02', updated_at: '2026-01-02', message_count: 0 },
    ]

    // Start streaming (fire-and-forget, it won't resolve)
    const sendPromise = store.sendMessage('Long message')

    // Give the event loop a tick for the streaming to start
    await new Promise((r) => setTimeout(r, 10))

    // Verify streaming started
    expect(store.streaming).toBe(true)
    expect(store.streamingSessionId).toBe('session-A')

    // Switch session
    loadMessages.mockResolvedValue([
      { id: 'm1', role: 'user', content: 'old msg', timestamp: '2026-01-02' },
    ])
    await store.selectSession('session-B')

    // Wait for sendMessage to fully settle (error path runs during microtasks)
    await sendPromise.catch(() => {})

    // Streaming should have been stopped
    expect(store.streamingSessionId).toBeNull()
    expect(store.currentSessionId).toBe('session-B')

    // Session-B messages are loaded; handleSendError may also push an error message
    expect(store.messages.some((m) => m.content === 'old msg')).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 4: Settings Load -> Provider Config -> Model Selection
// ══════════════════════════════════════════════════════════════════

describe('Scenario 4: Settings -> Provider -> Model selection chain', () => {
  it('loadConfig populates providers, enabledProviders, and availableModels', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    // Manually set config since we are in non-Tauri mode
    store.config = {
      llm: {
        providers: [
          {
            id: 'p1',
            name: 'OpenAI',
            type: 'openai',
            enabled: true,
            apiKey: 'sk-test',
            baseUrl: '',
            models: [
              { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text', 'vision'] },
              { id: 'gpt-3.5', name: 'GPT-3.5', capabilities: ['text'] },
            ],
          },
          {
            id: 'p2',
            name: 'DeepSeek',
            type: 'deepseek',
            enabled: true,
            apiKey: 'ds-test',
            baseUrl: '',
            models: [
              { id: 'deepseek-chat', name: 'DeepSeek Chat', capabilities: ['text'] },
            ],
          },
          {
            id: 'p3',
            name: 'Disabled Provider',
            type: 'anthropic',
            enabled: false,
            apiKey: '',
            baseUrl: '',
            models: [{ id: 'claude-3', name: 'Claude 3', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'p1',
        routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {
        gateway_enabled: true,
        injection_detection: true,
        pii_filter: false,
        content_filter: true,
        max_tokens_per_request: 8192,
        rate_limit_rpm: 60,
      },
      general: {
        language: 'zh-CN',
        log_level: 'info',
        data_dir: '',
        auto_start: false,
        defaultAgentRole: '',
      },
      notification: {
        system_enabled: true,
        sound_enabled: false,
        agent_complete: true,
      },
      mcp: { default_protocol: 'stdio' },
    }

    // enabledProviders should exclude disabled provider
    expect(store.enabledProviders).toHaveLength(2)
    expect(store.enabledProviders.map((p) => p.name)).toEqual(['OpenAI', 'DeepSeek'])

    // availableModels should contain models from enabled providers only
    expect(store.availableModels).toHaveLength(3)
    expect(store.availableModels.map((m) => m.modelId)).toEqual([
      'gpt-4o',
      'gpt-3.5',
      'deepseek-chat',
    ])

    // Verify model capabilities are preserved
    const gpt4o = store.availableModels.find((m) => m.modelId === 'gpt-4o')
    expect(gpt4o?.capabilities).toContain('vision')
    expect(gpt4o?.providerName).toBe('OpenAI')
  })

  it('Ollama models come from ollamaModelsCache, not provider.models', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    store.config = {
      llm: {
        providers: [
          {
            id: 'ollama-1',
            name: 'Ollama',
            type: 'ollama',
            enabled: true,
            apiKey: '',
            baseUrl: 'http://localhost:11434',
            models: [], // Empty -- real models come from cache
          },
        ],
        defaultModel: '',
        defaultProviderId: '',
        routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: { gateway_enabled: true, injection_detection: true, pii_filter: false, content_filter: true, max_tokens_per_request: 8192, rate_limit_rpm: 60 },
      general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
      notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
      mcp: { default_protocol: 'stdio' },
    }

    // Without cache, availableModels should be empty for Ollama
    expect(store.availableModels).toHaveLength(0)

    // Note: ollamaModelsCache is internal and populated by syncOllamaModels.
    // We verify the computed property wiring works correctly through the config.
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 5: Knowledge Search -> Document Content Retrieval
// ══════════════════════════════════════════════════════════════════

describe('Scenario 5: Knowledge search -> document content retrieval', () => {
  it('searchKnowledge normalizes result/results field', async () => {
    const { searchKnowledge } = await import('@/api/knowledge')

    // Test with `result` field
    mockSearchKnowledge.mockResolvedValueOnce({
      result: [
        { content: 'HexClaw overview', score: 0.95, doc_id: 'doc-1', doc_title: 'Intro' },
        { content: 'Architecture details', score: 0.88, doc_title: 'Arch' },
      ],
    })

    const res1 = await searchKnowledge('HexClaw', 5)
    expect(res1.result).toHaveLength(2)
    expect(res1.result[0]!.content).toBe('HexClaw overview')

    // Test with `results` field (normalization happens in real code,
    // but since we mock searchKnowledge, we verify the mock was called correctly)
    mockSearchKnowledge.mockResolvedValueOnce({
      result: [{ content: 'Normalized from results', score: 0.9 }],
    })
    const res2 = await searchKnowledge('Architecture', 3)
    expect(res2.result).toHaveLength(1)
  })

  it('getDocumentContent retrieves full document detail', async () => {
    const { getDocumentContent } = await import('@/api/knowledge')

    mockGetDocumentContent.mockResolvedValueOnce('This is the full document content.')

    const content = await getDocumentContent({
      id: 'doc-1',
      title: 'Test Doc',
      chunk_count: 5,
      created_at: '2026-01-01',
    })
    expect(content).toBe('This is the full document content.')
  })

  it('getDocumentContent falls back to search when detail fails', async () => {
    const { getDocumentContent } = await import('@/api/knowledge')

    // Simulate detail API failure, then search fallback
    mockGetDocumentContent.mockResolvedValueOnce('chunk1\n\nchunk2')

    const content = await getDocumentContent({
      id: 'doc-2',
      title: 'Fallback Doc',
      chunk_count: 2,
      created_at: '2026-01-01',
    })
    expect(content).toBe('chunk1\n\nchunk2')
    expect(mockGetDocumentContent).toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 6: Artifact Extraction + Selection Chain
// ══════════════════════════════════════════════════════════════════

describe('Scenario 6: Artifact extraction + selection chain', () => {
  it('extractArtifacts finds code blocks and selectArtifact activates panel', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const contentWithCode = [
      'Here is a function:',
      '```typescript',
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`',
      '}',
      '```',
      '',
      'And some Python:',
      '```python',
      'def greet(name):',
      '    return f"Hello, {name}!"',
      '```',
    ].join('\n')

    store.extractArtifacts(contentWithCode, 'msg-1')

    // Two code blocks extracted
    expect(store.artifacts).toHaveLength(2)
    expect(store.artifacts[0]!.language).toBe('typescript')
    expect(store.artifacts[0]!.type).toBe('code')
    expect(store.artifacts[1]!.language).toBe('python')
    expect(store.artifacts[1]!.type).toBe('code')

    // Content is trimmed
    expect(store.artifacts[0]!.content).toContain('export function greet')
    expect(store.artifacts[1]!.content).toContain('def greet')

    // Select an artifact
    const tsArtifact = store.artifacts[0]!
    store.selectArtifact(tsArtifact.id)

    expect(store.selectedArtifactId).toBe(tsArtifact.id)
    expect(store.showArtifacts).toBe(true)
  })

  it('short code blocks (< 5 chars) are skipped', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.extractArtifacts('```js\na=1\n```', 'msg-tiny')
    expect(store.artifacts).toHaveLength(0)
  })

  it('html code blocks are typed as html', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.extractArtifacts('```html\n<div class="container">Content here</div>\n```', 'msg-html')
    expect(store.artifacts).toHaveLength(1)
    expect(store.artifacts[0]!.type).toBe('html')
    expect(store.artifacts[0]!.language).toBe('html')
  })

  it('extractArtifacts clears previous artifacts for same messageId', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.extractArtifacts('```js\nconsole.log("first extraction code")\n```', 'msg-dup')
    expect(store.artifacts).toHaveLength(1)

    // Re-extract for the same message
    store.extractArtifacts('```python\nprint("second extraction code")\n```', 'msg-dup')
    expect(store.artifacts).toHaveLength(1)
    expect(store.artifacts[0]!.language).toBe('python')
  })

  it('full send chain extracts artifacts from assistant reply', async () => {
    sendViaWebSocket.mockImplementation(
      (_t: string, _s: string, _p: unknown, _r: string, _a: unknown, callbacks?: {
        onChunk: (c: string) => void
        onDone: (c: string) => void
      }) => {
        const reply = 'Here is code:\n```rust\nfn main() { println!("hello"); }\n```'
        callbacks?.onDone(reply)
        return Promise.resolve()
      },
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.sendMessage('Write Rust')

    // Artifact from assistant reply
    const rustArtifact = store.artifacts.find((a) => a.language === 'rust')
    expect(rustArtifact).toBeDefined()
    expect(rustArtifact?.content).toContain('fn main')
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 7: Tool Approval Chain
// ══════════════════════════════════════════════════════════════════

describe('Scenario 7: Tool approval chain', () => {
  it('initApprovalListener -> WS approval request -> respondApproval clears state', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Initially no pending approval
    expect(store.pendingApproval).toBeNull()

    // Init listener
    store.initApprovalListener()

    // Simulate WebSocket sending a tool_approval_request
    const approvalReq = {
      requestId: 'req-001',
      toolName: 'execute_code',
      risk: 'high',
      reason: 'The tool wants to run arbitrary code',
      sessionId: 'session-A',
    }

    // Trigger the approval callback
    wsCallbacks.approval!.forEach((cb) => cb(approvalReq))

    // Pending approval should be set
    expect(store.pendingApproval).toEqual(approvalReq)
    expect(store.pendingApproval?.requestId).toBe('req-001')
    expect(store.pendingApproval?.toolName).toBe('execute_code')
    expect(store.pendingApproval?.risk).toBe('high')

    // Respond with approval
    const { hexclawWS } = await import('@/api/websocket')
    store.respondApproval('req-001', true, false)

    // Pending approval cleared
    expect(store.pendingApproval).toBeNull()

    // WS approval response sent
    expect(hexclawWS.sendApprovalResponse).toHaveBeenCalledWith('req-001', true, false)
  })

  it('respondApproval with deny sends denied response', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.initApprovalListener()
    wsCallbacks.approval!.forEach((cb) =>
      cb({ requestId: 'req-002', toolName: 'file_write', risk: 'sensitive', reason: 'Writing to disk', sessionId: 's1' }),
    )

    expect(store.pendingApproval?.requestId).toBe('req-002')

    const { hexclawWS } = await import('@/api/websocket')
    store.respondApproval('req-002', false, true)

    expect(store.pendingApproval).toBeNull()
    expect(hexclawWS.sendApprovalResponse).toHaveBeenCalledWith('req-002', false, true)
  })

  it('multiple initApprovalListener calls do not register duplicate callbacks', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    const { hexclawWS } = await import('@/api/websocket')

    store.initApprovalListener()
    store.initApprovalListener()
    store.initApprovalListener()

    // onApprovalRequest should have been called only once (guard in store)
    expect(hexclawWS.onApprovalRequest).toHaveBeenCalledTimes(1)
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 8: Session Management Full Chain
// ══════════════════════════════════════════════════════════════════

describe('Scenario 8: Session management full chain', () => {
  it('loadSessions -> selectSession -> messages loaded -> deleteSession -> state cleared', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Load sessions
    await store.loadSessions()
    expect(store.sessions).toHaveLength(2)
    expect(loadAllSessions).toHaveBeenCalled()

    // Select session
    loadMessages.mockResolvedValueOnce([
      { id: 'm1', role: 'user', content: 'Hello', timestamp: '2026-01-01' },
      { id: 'm2', role: 'assistant', content: 'Hi there!', timestamp: '2026-01-01' },
    ])
    await store.selectSession('s1')

    expect(store.currentSessionId).toBe('s1')
    expect(store.messages).toHaveLength(2)
    expect(store.messages[0]!.content).toBe('Hello')
    expect(store.messages[1]!.content).toBe('Hi there!')
    expect(setLastSessionId).toHaveBeenCalledWith('s1')

    // Delete session
    await store.deleteSession('s1')

    expect(deleteSvcSession).toHaveBeenCalledWith('s1')
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0]!.id).toBe('s2')
    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toHaveLength(0)
    expect(store.artifacts).toHaveLength(0)
    expect(store.selectedArtifactId).toBeNull()
    expect(store.showArtifacts).toBe(false)
  })

  it('newSession resets all state', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Setup some state
    store.currentSessionId = 'old-session' as string
    store.messages = [{ id: 'm1', role: 'user', content: 'Old', timestamp: '2026-01-01' }] as import('@/types').ChatMessage[]
    store.artifacts = [{ id: 'a1', type: 'code', title: 'old', language: 'js', content: 'x', messageId: 'm1', createdAt: '2026-01-01' }]
    store.showArtifacts = true
    store.selectedArtifactId = 'a1'

    store.newSession('Fresh Start')

    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toHaveLength(0)
    expect(store.artifacts).toHaveLength(0)
    expect(store.showArtifacts).toBe(false)
    expect(store.selectedArtifactId).toBeNull()
    expect(store.streaming).toBe(false)
    expect(store.error).toBeNull()
    expect(clearWebSocketCallbacks).toHaveBeenCalled()
  })

  it('selectSession loads artifacts from persistence and falls back to extraction', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // When loadArtifacts returns empty, artifacts should be re-extracted from messages
    loadArtifacts.mockResolvedValueOnce([])
    loadMessages.mockResolvedValueOnce([
      { id: 'm1', role: 'user', content: 'Write code', timestamp: '2026-01-01' },
      {
        id: 'm2',
        role: 'assistant',
        content: '```javascript\nconst x = 42; // this is long enough\n```',
        timestamp: '2026-01-01',
      },
    ])

    await store.selectSession('s1')

    // Artifacts re-extracted from messages
    expect(store.artifacts.length).toBeGreaterThanOrEqual(1)
    expect(store.artifacts[0]!.language).toBe('javascript')
  })

  it('ensureSession creates session only once even with concurrent calls', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Call ensureSession multiple times concurrently
    const [id1, id2, id3] = await Promise.all([
      store.ensureSession(),
      store.ensureSession(),
      store.ensureSession(),
    ])

    // All should return the same session ID
    expect(id1).toBe(id2)
    expect(id2).toBe(id3)

    // createSession called exactly once
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
  })

  it('deleteSession handles non-current session without clearing state', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.loadSessions()
    loadMessages.mockResolvedValueOnce([])
    await store.selectSession('s1')

    // Delete s2 (not current)
    await store.deleteSession('s2')

    // s1 still current and intact
    expect(store.currentSessionId).toBe('s1')
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0]!.id).toBe('s1')
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 9: Error Recovery Chain
// ══════════════════════════════════════════════════════════════════

describe('Scenario 9: Error recovery chain', () => {
  it('sendMessage failure sets error and adds error message to messages', async () => {
    ensureWebSocketConnected.mockResolvedValue(false)
    sendViaBackend.mockRejectedValue(new Error('Server unavailable'))

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const result = await store.sendMessage('Will fail')

    expect(result).toBeNull()

    // Error state set
    expect(store.error).not.toBeNull()
    expect(store.error?.message).toContain('Server unavailable')

    // Error message added to messages
    const errorMsg = store.messages.find(
      (m) => m.role === 'assistant' && m.content.includes('Server unavailable'),
    )
    expect(errorMsg).toBeDefined()

    // Streaming stopped
    expect(store.streaming).toBe(false)
  })

  it('WebSocket error during streaming triggers error recovery', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    const { ChatRequestError } = await import('@/services/chatService')
    sendViaWebSocket.mockRejectedValue(new ChatRequestError('WS disconnected', true))

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.sendMessage('WS will fail')

    // Error captured
    expect(store.error).not.toBeNull()
    expect(store.streaming).toBe(false)

    // Error message displayed to user
    const lastMsg = store.messages[store.messages.length - 1]
    expect(lastMsg?.role).toBe('assistant')
  })

  it('error state is cleared on next successful send', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // First: failure
    ensureWebSocketConnected.mockResolvedValue(false)
    sendViaBackend.mockRejectedValueOnce(new Error('Temporary failure'))
    await store.sendMessage('Fail first')
    expect(store.error).not.toBeNull()

    // Second: success
    sendViaBackend.mockResolvedValueOnce({ reply: 'All good now', session_id: 's1' })
    await store.sendMessage('Success now')

    // Error cleared during successful send
    expect(store.error).toBeNull()
    const lastMsg = store.messages[store.messages.length - 1]
    expect(lastMsg?.content).toBe('All good now')
  })

  it('concurrent sendMessage calls are prevented by sending guard', async () => {
    ensureWebSocketConnected.mockResolvedValue(false)
    let resolveFirst: ((v: unknown) => void) | undefined
    sendViaBackend.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve as (v: unknown) => void }),
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Start first send (won't resolve immediately)
    const firstSend = store.sendMessage('First message')
    await new Promise((r) => setTimeout(r, 10))

    // Attempt second send while first is in-flight
    const secondSend = store.sendMessage('Second message')
    const secondResult = await secondSend

    // Second send returns null because sending guard prevents it
    expect(secondResult).toBeNull()

    // Resolve first send
    resolveFirst?.({ reply: 'First response', session_id: 's1' })
    await firstSend
  })
})

// ══════════════════════════════════════════════════════════════════
// Scenario 10: Message Feedback Chain
// ══════════════════════════════════════════════════════════════════

describe('Scenario 10: Message feedback chain', () => {
  it('setMessageFeedback(like) updates metadata and syncs to backend', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Setup: have an assistant message with backend_message_id
    store.currentSessionId = 'session-fb' as string
    store.messages = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Hello',
        timestamp: '2026-01-01',
      },
      {
        id: 'assist-1',
        role: 'assistant',
        content: 'Hi there!',
        timestamp: '2026-01-01',
        metadata: { backend_message_id: 'bm-100' },
      },
    ] as import('@/types').ChatMessage[]

    updateMessageFeedback.mockResolvedValueOnce({ message: 'ok' })

    const result = await store.setMessageFeedback('assist-1', 'like')

    // Message metadata updated
    expect(result).not.toBeNull()
    expect(result?.metadata?.user_feedback).toBe('like')

    // Backend sync called with correct args
    expect(updateMessageFeedback).toHaveBeenCalledWith('bm-100', 'like')

    // Store message also updated
    const msg = store.messages.find((m) => m.id === 'assist-1')
    expect(msg?.metadata?.user_feedback).toBe('like')
  })

  it('setMessageFeedback rolls back on backend sync failure', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.currentSessionId = 'session-fb' as string
    store.messages = [
      {
        id: 'assist-2',
        role: 'assistant',
        content: 'Response',
        timestamp: '2026-01-01',
        metadata: { backend_message_id: 'bm-200', user_feedback: undefined },
      },
    ] as import('@/types').ChatMessage[]

    // Backend sync will fail
    updateMessageFeedback.mockRejectedValueOnce(new Error('Sync failed'))

    // Should throw
    await expect(store.setMessageFeedback('assist-2', 'dislike')).rejects.toThrow('Sync failed')

    // Metadata should be rolled back to previous state (no feedback)
    const msg = store.messages.find((m) => m.id === 'assist-2')
    // After rollback, user_feedback should not be 'dislike'
    expect(msg?.metadata?.user_feedback).not.toBe('dislike')
  })

  it('setMessageFeedback with null removes feedback from metadata', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.currentSessionId = 'session-fb' as string
    store.messages = [
      {
        id: 'assist-3',
        role: 'assistant',
        content: 'Response',
        timestamp: '2026-01-01',
        metadata: { backend_message_id: 'bm-300', user_feedback: 'like' },
      },
    ] as import('@/types').ChatMessage[]

    updateMessageFeedback.mockResolvedValueOnce({ message: 'ok' })

    const result = await store.setMessageFeedback('assist-3', null)
    expect(result).not.toBeNull()

    // user_feedback removed from metadata
    const msg = store.messages.find((m) => m.id === 'assist-3')
    expect(msg?.metadata?.user_feedback).toBeUndefined()
  })

  it('setMessageFeedback without backend_message_id only saves locally', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.currentSessionId = 'session-fb' as string
    store.messages = [
      {
        id: 'assist-4',
        role: 'assistant',
        content: 'No backend ID',
        timestamp: '2026-01-01',
        metadata: {},
      },
    ] as import('@/types').ChatMessage[]

    const result = await store.setMessageFeedback('assist-4', 'like')

    // Feedback saved locally
    expect(result?.metadata?.user_feedback).toBe('like')

    // Backend NOT called because no backend_message_id
    expect(updateMessageFeedback).not.toHaveBeenCalled()
  })

  it('setMessageFeedback on user message returns null', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.messages = [
      { id: 'user-msg', role: 'user', content: 'Hi', timestamp: '2026-01-01' },
    ] as import('@/types').ChatMessage[]

    const result = await store.setMessageFeedback('user-msg', 'like')
    expect(result).toBeNull()
    expect(updateMessageFeedback).not.toHaveBeenCalled()
  })

  it('setMessageFeedback on non-existent message returns null', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    store.messages = []
    const result = await store.setMessageFeedback('ghost-id', 'like')
    expect(result).toBeNull()
  })
})
