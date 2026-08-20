import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../chat'

// ─── 服务层 Mock ──────────────────────────────────────
// chat.ts 现在委托 messageService + chatService，不再直接使用 db/api

const {
  // messageService
  loadAllSessions,
  loadMessages,
  createSession,
  updateSessionTitle,
  suggestSessionTitle,
  touchSession,
  persistMessage,
  loadArtifacts,
  saveArtifact,
  getLastSessionId,
  setLastSessionId,
  // chatService
  ensureWebSocketConnected,
  sendViaWebSocket,
  openWebSocketStream,
  resumeWebSocketStream,
  sendViaBackend,
  clearWebSocketCallbacks,
  onToolApprovalTerminal,
  parseToolApprovalReconciliationAck,
  parseToolApprovalTerminal,
  // api/chat
  updateMessageFeedback,
  listActiveStreams,
  sendRaw,
  triggerError,
  onApprovalRequest,
  approvalListeners,
} = vi.hoisted(() => ({
  loadAllSessions: vi.fn().mockResolvedValue([
    { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 0 },
  ]),
  loadMessages: vi.fn().mockResolvedValue([
    { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01' },
    { id: 'm2', role: 'assistant', content: 'hi', timestamp: '2026-01-01' },
  ]),
  createSession: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  suggestSessionTitle: vi.fn().mockResolvedValue({ id: 's1', title: '周末露营装备准备', updated: true, updated_at: '2026-01-01' }),
  touchSession: vi.fn().mockResolvedValue(undefined),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  loadArtifacts: vi.fn().mockResolvedValue([]),
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  getLastSessionId: vi.fn().mockResolvedValue(null),
  setLastSessionId: vi.fn().mockResolvedValue(undefined),

  ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
  sendViaWebSocket: vi.fn().mockResolvedValue(undefined),
  openWebSocketStream: vi.fn().mockImplementation(() => ({
    cancel: vi.fn(),
    done: Promise.resolve({ content: '你好！' }),
  })),
  resumeWebSocketStream: vi.fn().mockImplementation(() => ({
    cancel: vi.fn(),
    done: Promise.resolve({ content: '恢复完成' }),
  })),
  sendViaBackend: vi.fn().mockResolvedValue({ reply: '你好！', session_id: 's1' }),
  clearWebSocketCallbacks: vi.fn(),
  onToolApprovalTerminal: vi.fn().mockReturnValue(() => {}),
  parseToolApprovalReconciliationAck: vi.fn().mockReturnValue(null),
  parseToolApprovalTerminal: vi.fn().mockReturnValue(null),

  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  sendRaw: vi.fn(),
  triggerError: vi.fn(),
  approvalListeners: [] as Array<(req: {
    requestId: string
    sessionId: string
    ownerId?: string
    invocationId?: string
    toolName: string
    argumentsDigest?: string
    securityScopeDigest?: string
    scopeSchemaVersion?: number
    risk: string
    reason: string
    respondApproval?: (decision: {
      request_id: string
      decision_id: string
      decision: 'approved_once' | 'approved_remember' | 'denied'
      idempotency_key: string
    }) => Promise<{
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
      status: 'accepted'
    }>
  }) => void>,
  onApprovalRequest: vi.fn().mockImplementation((cb) => {
    approvalListeners.push(cb)
    return () => {
      const idx = approvalListeners.indexOf(cb)
      if (idx >= 0) approvalListeners.splice(idx, 1)
    }
  }),
}))

vi.mock('@/services/messageService', () => ({
  loadAllSessions,
  loadMessages,
  createSession,
  updateSessionTitle,
  suggestSessionTitle,
  touchSession,
  deleteSession: vi.fn().mockResolvedValue(undefined),
  persistMessage,
  removeMessage: vi.fn(),
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
    openWebSocketStream,
    resumeWebSocketStream,
    sendViaBackend,
    clearWebSocketCallbacks,
    onToolApprovalTerminal,
    parseToolApprovalReconciliationAck,
    parseToolApprovalTerminal,
    ChatRequestError,
  }
})

vi.mock('@/api/chat', () => ({
  updateMessageFeedback,
  listActiveStreams,
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    sendRaw,
    triggerError,
    onApprovalRequest,
  },
}))

// DB layer removed — all data operations go through services which use the API

async function flushStreamSetup() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useChatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    loadAllSessions.mockResolvedValue([
      { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 0 },
    ])
    loadMessages.mockResolvedValue([
      { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01' },
      { id: 'm2', role: 'assistant', content: 'hi', timestamp: '2026-01-01' },
    ])
    loadArtifacts.mockResolvedValue([])
    getLastSessionId.mockResolvedValue(null)
    sendViaBackend.mockResolvedValue({ reply: '你好！', session_id: 's1' })
    ensureWebSocketConnected.mockResolvedValue(true)
    updateMessageFeedback.mockResolvedValue({ message: 'ok' })
    approvalListeners.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has empty initial state', () => {
    const store = useChatStore()
    expect(store.sessions).toEqual([])
    expect(store.messages).toEqual([])
    expect(store.streaming).toBe(false)
    expect(store.currentSessionId).toBeNull()
    expect(store.agentRole).toBe('')
  })

  it('loads sessions', async () => {
    const store = useChatStore()
    await store.loadSessions()
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0]!.id).toBe('s1')
  })

  it('selects session and loads messages', async () => {
    const store = useChatStore()
    await store.selectSession('s1')
    expect(store.currentSessionId).toBe('s1')
    expect(store.messages).toHaveLength(2)
  })

  it('keeps the original session streaming when switching to another session', async () => {
    let holdStream!: () => void
    loadAllSessions.mockResolvedValueOnce([
      { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 1 },
      { id: 's2', title: 'Session 2', created_at: '2026-01-02', updated_at: '2026-01-02', message_count: 1 },
    ])
    loadMessages.mockImplementation(async (sessionId: string) => (
      sessionId === 's2'
        ? [{ id: 'm-s2', role: 'user', content: 'other', timestamp: '2026-01-02' }]
        : [{ id: 'm-s1', role: 'user', content: 'streaming', timestamp: '2026-01-01' }]
    ))

    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementationOnce(
      (_text, _sid, _params, _role, _att, callbacks) => ({
        cancel: vi.fn(),
        done: new Promise((resolve) => {
          callbacks?.onChunk('正在生成中')
          holdStream = () => resolve({ content: '完成' })
        }),
      }),
    )

    const store = useChatStore()
    await store.loadSessions()
    await store.selectSession('s1')
    void store.sendMessage('继续生成')
    await Promise.resolve()

    await store.selectSession('s2')

    expect(store.currentSessionId).toBe('s2')
    expect(store.streaming).toBe(true)
    expect(store.streamingSessionId).toBe('s1')
    expect(sendRaw).not.toHaveBeenCalled()
    expect(clearWebSocketCallbacks).not.toHaveBeenCalled()
    holdStream()
  })

  it('does not inject a background stream completion into the currently selected session', async () => {
    let completeStream!: () => void

    loadAllSessions.mockResolvedValueOnce([
      { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 1 },
      { id: 's2', title: 'Session 2', created_at: '2026-01-02', updated_at: '2026-01-02', message_count: 1 },
    ])
    loadMessages.mockImplementation(async (sessionId: string) => (
      sessionId === 's2'
        ? [{ id: 'm-s2', role: 'user', content: 'other session', timestamp: '2026-01-02' }]
        : [{ id: 'm-s1', role: 'user', content: 'original session', timestamp: '2026-01-01' }]
    ))
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementation(
      (_text, _sid, _params, _role, _att, callbacks) => ({
        cancel: vi.fn(),
        done: new Promise((resolve) => {
          completeStream = () => {
            callbacks?.onChunk('后台完成的回答')
            resolve({ content: '后台完成的回答' })
          }
        }),
      }),
    )

    const store = useChatStore()
    await store.loadSessions()
    await store.selectSession('s1')

    const sendPromise = store.sendMessage('继续生成')
    await Promise.resolve()
    await store.selectSession('s2')

    completeStream()
    const assistantMsg = await sendPromise

    expect(assistantMsg?.content).toBe('后台完成的回答')
    expect(store.currentSessionId).toBe('s2')
    expect(store.messages.map((m) => m.content)).toEqual(['other session'])
    expect(
      persistMessage.mock.calls.some(
        ([message, sessionId]) =>
          sessionId === 's1' &&
          typeof message === 'object' &&
          message !== null &&
          'role' in message &&
          'content' in message &&
          message.role === 'assistant' &&
          message.content === '后台完成的回答',
      ),
    ).toBe(true)
  })

  it('keeps the latest selected session messages when an earlier selectSession resolves later', async () => {
    let resolveFirstMessages!: (value: Array<{ id: string; role: string; content: string; timestamp: string }>) => void
    let resolveSecondMessages!: (value: Array<{ id: string; role: string; content: string; timestamp: string }>) => void
    let resolveSecondArtifacts!: (value: unknown[]) => void

    loadAllSessions.mockResolvedValueOnce([
      { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 0 },
      { id: 's2', title: 'Session 2', created_at: '2026-01-02', updated_at: '2026-01-02', message_count: 0 },
    ])
    loadMessages.mockImplementation((sessionId: string) => {
      if (sessionId === 's1') {
        return new Promise((resolve) => {
          resolveFirstMessages = resolve as typeof resolveFirstMessages
        })
      }
      if (sessionId === 's2') {
        return new Promise((resolve) => {
          resolveSecondMessages = resolve as typeof resolveSecondMessages
        })
      }
      return Promise.resolve([])
    })
    loadArtifacts.mockImplementation((sessionId: string) => {
      if (sessionId === 's2') {
        return new Promise((resolve) => {
          resolveSecondArtifacts = resolve as typeof resolveSecondArtifacts
        })
      }
      return Promise.resolve([])
    })

    const store = useChatStore()
    await store.loadSessions()

    const firstSelect = store.selectSession('s1')
    const secondSelect = store.selectSession('s2')

    resolveSecondMessages([
      { id: 'm-s2', role: 'assistant', content: 'session-2', timestamp: '2026-01-02' },
    ])
    await Promise.resolve()
    await Promise.resolve()
    resolveSecondArtifacts([])
    await secondSelect

    expect(store.currentSessionId).toBe('s2')
    expect(store.messages.map((m) => m.content)).toEqual(['session-2'])

    resolveFirstMessages([
      { id: 'm-s1', role: 'assistant', content: 'session-1', timestamp: '2026-01-01' },
    ])
    await firstSelect

    expect(store.currentSessionId).toBe('s2')
    expect(store.messages.map((m) => m.content)).toEqual(['session-2'])
  })

  it('rebuilds artifacts from loaded messages when persisted artifact storage is empty', async () => {
    loadMessages.mockResolvedValueOnce([
      {
        id: 'm1',
        role: 'assistant',
        content: '```ts\nconsole.log("artifact")\n```',
        timestamp: '2026-01-01',
      },
    ])
    loadArtifacts.mockResolvedValueOnce([])

    const store = useChatStore()
    await store.selectSession('s1')

    expect(store.artifacts).toHaveLength(1)
    expect(store.artifacts[0]!.language).toBe('ts')
    expect(store.artifacts[0]!.content).toContain('console.log("artifact")')
  })

  it('creates new session', () => {
    const store = useChatStore()
    store.currentSessionId = 's1'
    store.messages = [{ id: 'm1', role: 'user', content: 'test', timestamp: '' }]
    store.newSession()
    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toEqual([])
  })

  it('promotes a new session title from the first user message before backend refresh completes', async () => {
    let resolveTitleUpdate!: () => void
    updateSessionTitle.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveTitleUpdate = resolve }),
    )
    loadAllSessions.mockResolvedValueOnce([
      { id: 'stale-session', title: '旧会话', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 1 },
    ])

    const store = useChatStore()
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementationOnce(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({ content: '收到' }),
    }))

    await store.sendMessage('这是第一条消息，用来生成会话标题')

    expect(store.currentSessionId).toBeTruthy()
    const localSession = store.sessions.find((session) => session.id === store.currentSessionId)
    expect(localSession?.title).toBe('这是第一条消息，用来生成会话标题')
    expect(updateSessionTitle).toHaveBeenCalledTimes(1)
    expect(loadAllSessions).not.toHaveBeenCalled()

    resolveTitleUpdate()
    await vi.waitFor(() => {
      expect(loadAllSessions).toHaveBeenCalledTimes(1)
    })
  })

  it('replaces the temporary first-message title with a suggested summary after the first reply completes', async () => {
    const store = useChatStore()
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementationOnce(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({ content: '可以从帐篷、睡袋、炊具和照明开始准备' }),
    }))

    await store.sendMessage('帮我规划这个周末去杭州露营需要带什么')

    await Promise.resolve()
    await Promise.resolve()

    const localSession = store.sessions.find((session) => session.id === store.currentSessionId)
    expect(updateSessionTitle).toHaveBeenCalledWith(
      expect.any(String),
      '帮我规划这个周末去杭州露营需要带什么',
    )
    // 简化后的标题流程：不再传 expectedTitle，后端直接生成
    expect(suggestSessionTitle).toHaveBeenCalledWith(
      expect.any(String),
      '',
    )
    expect(localSession?.title).toBe('周末露营装备准备')
  })

  it('deletes session', async () => {
    const store = useChatStore()
    await store.loadSessions()
    store.currentSessionId = 's1'
    store.messages = [{ id: 'm1', role: 'user', content: 'test', timestamp: '' }]
    await store.deleteSession('s1')
    expect(store.sessions).toHaveLength(0)
    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toEqual([])
  })

  it('stops streaming and saves content', () => {
    const store = useChatStore()
    store.streaming = true
    store.streamingContent = 'partial response'
    store.stopStreaming()
    expect(store.streaming).toBe(false)
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]!.content).toBe('partial response')
    expect(store.streamingContent).toBe('')
  })

  it('newSession resets stale artifact state but preserves an in-flight stream for background completion', async () => {
    openWebSocketStream.mockImplementationOnce(
      (_text, _sid, _params, _role, _att, callbacks) => ({
        cancel: vi.fn(),
        done: new Promise(() => {
          callbacks?.onChunk('partial')
        }),
      }),
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.messages = [{ id: 'm1', role: 'assistant', content: 'done', timestamp: '' }]
    store.artifacts = [{ id: 'a1', type: 'code', title: 'Snippet', language: 'ts', content: 'console.log(1)', messageId: 'm1', createdAt: '' }]
    store.selectedArtifactId = 'a1'
    store.showArtifacts = true
    ensureWebSocketConnected.mockResolvedValue(true)

    void store.sendMessage('继续生成')
    await flushStreamSetup()

    store.newSession()

    expect(store.currentSessionId).toBeNull()
    expect(store.artifacts).toEqual([])
    expect(store.selectedArtifactId).toBeNull()
    expect(store.showArtifacts).toBe(false)
    expect(store.streaming).toBe(true)
    expect(store.streamingSessionId).toBe('s1')
    expect(store.streamingContent).toBe('partial')
  })

  it('deleteSession clears artifact and streaming state for the active session', async () => {
    const cancel = vi.fn()
    openWebSocketStream.mockImplementationOnce(
      (_text, _sid, _params, _role, _att, callbacks) => ({
        cancel,
        done: new Promise(() => {
          callbacks?.onChunk('partial')
        }),
      }),
    )

    const store = useChatStore()
    await store.loadSessions()
    store.currentSessionId = 's1'
    store.messages = [{ id: 'm1', role: 'assistant', content: 'done', timestamp: '' }]
    store.artifacts = [{ id: 'a1', type: 'code', title: 'Snippet', language: 'ts', content: 'console.log(1)', messageId: 'm1', createdAt: '' }]
    store.selectedArtifactId = 'a1'
    store.showArtifacts = true
    ensureWebSocketConnected.mockResolvedValue(true)
    void store.sendMessage('继续生成')
    await flushStreamSetup()

    await store.deleteSession('s1')

    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.artifacts).toEqual([])
    expect(store.selectedArtifactId).toBeNull()
    expect(store.showArtifacts).toBe(false)
    expect(store.streaming).toBe(false)
    expect(store.streamingSessionId).toBeNull()
    expect(store.streamingContent).toBe('')
    expect(cancel).toHaveBeenCalled()
  })

  it('deleteSession cancels an in-flight stream for the active session', async () => {
    const cancel = vi.fn()
    openWebSocketStream.mockImplementationOnce(
      (_text, _sid, _params, _role, _att, callbacks) => ({
        cancel,
        done: new Promise(() => {
          callbacks?.onChunk('partial')
        }),
      }),
    )

    const store = useChatStore()
    await store.loadSessions()
    store.currentSessionId = 's1'
    ensureWebSocketConnected.mockResolvedValue(true)
    void store.sendMessage('继续生成')
    await flushStreamSetup()

    await store.deleteSession('s1')

    expect(cancel).toHaveBeenCalled()
  })

  it('allows different sessions to generate concurrently without cancelling the earlier stream', async () => {
    let finishFirst!: () => void
    let finishSecond!: () => void
    const firstCancel = vi.fn()
    const secondCancel = vi.fn()

    loadAllSessions.mockResolvedValueOnce([
      { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 1 },
      { id: 's2', title: 'Session 2', created_at: '2026-01-02', updated_at: '2026-01-02', message_count: 1 },
    ])
    loadMessages.mockImplementation(async (sessionId: string) => (
      sessionId === 's2'
        ? [{ id: 'm-s2', role: 'user', content: 'session 2', timestamp: '2026-01-02' }]
        : [{ id: 'm-s1', role: 'user', content: 'session 1', timestamp: '2026-01-01' }]
    ))
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream
      .mockImplementationOnce((_text, _sid, _params, _role, _att, callbacks) => ({
        cancel: firstCancel,
        done: new Promise((resolve) => {
          callbacks?.onChunk('第一条进行中')
          finishFirst = () => resolve({ content: '第一条完成' })
        }),
      }))
      .mockImplementationOnce((_text, _sid, _params, _role, _att, callbacks) => ({
        cancel: secondCancel,
        done: new Promise((resolve) => {
          callbacks?.onChunk('第二条进行中')
          finishSecond = () => resolve({ content: '第二条完成' })
        }),
      }))

    const store = useChatStore()
    await store.loadSessions()
    await store.selectSession('s1')

    const firstPromise = store.sendMessage('会话一问题')
    await flushStreamSetup()

    await store.selectSession('s2')
    const secondPromise = store.sendMessage('会话二问题')
    await flushStreamSetup()

    expect(store.isSessionStreaming('s1')).toBe(true)
    expect(store.isSessionStreaming('s2')).toBe(true)
    expect(firstCancel).not.toHaveBeenCalled()
    expect(secondCancel).not.toHaveBeenCalled()
    expect(openWebSocketStream).toHaveBeenNthCalledWith(
      1,
      '会话一问题',
      's1',
      expect.any(Object),
      '',
      undefined,
      expect.any(Object),
      expect.objectContaining({
        pinned_agent: 'default', user_locale: 'zh-CN', locale: 'zh-CN', producer_kind: 'chat',
      }),
      expect.any(String),
    )
    expect(openWebSocketStream).toHaveBeenNthCalledWith(
      2,
      '会话二问题',
      's2',
      expect.any(Object),
      '',
      undefined,
      expect.any(Object),
      expect.objectContaining({
        pinned_agent: 'default', user_locale: 'zh-CN', locale: 'zh-CN', producer_kind: 'chat',
      }),
      expect.any(String),
    )

    finishFirst()
    finishSecond()
    const [firstMsg, secondMsg] = await Promise.all([firstPromise, secondPromise])

    expect(firstMsg?.content).toBe('第一条完成')
    expect(secondMsg?.content).toBe('第二条完成')
    expect(store.isSessionStreaming('s1')).toBe(false)
    expect(store.isSessionStreaming('s2')).toBe(false)
  })

  it('persists assistant metadata and tool calls from backend responses', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementationOnce(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({
        content: '已完成',
        agentName: 'Coder',
      metadata: {
        provider: 'openai',
        model: 'gpt-4o',
        knowledge_hits: [{ doc_title: 'Spec' }],
      },
        toolCalls: [{ id: 'tool-1', name: 'search', arguments: '{"q":"spec"}' }],
      }),
    }))

    const store = useChatStore()
    await store.sendMessage('hello')

    const assistantMsg = store.messages[store.messages.length - 1]
    expect(assistantMsg?.agent_name).toBe('Coder')
    expect(assistantMsg?.tool_calls).toHaveLength(1)
    expect(assistantMsg?.metadata?.provider).toBe('openai')
    expect(persistMessage).toHaveBeenCalled()
  })

  it('omits role for regular chat websocket requests', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementation(
      () => ({ cancel: vi.fn(), done: Promise.resolve({ content: '已完成' }) }),
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.chatParams.provider = '智谱'
    store.chatParams.model = 'glm-5'

    await store.sendMessage('hello')

    expect(openWebSocketStream).toHaveBeenCalledWith(
      'hello',
      's1',
      { provider: '智谱', model: 'glm-5' },
      '',
      undefined,
      expect.any(Object),
      expect.objectContaining({
        pinned_agent: 'default', user_locale: 'zh-CN', locale: 'zh-CN', producer_kind: 'chat',
      }),
      expect.any(String),
    )
  })

  it('sends explicit agent role to websocket requests when entering a specialist mode', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementation(
      () => ({ cancel: vi.fn(), done: Promise.resolve({ content: '已完成' }) }),
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.chatParams.provider = '智谱'
    store.chatParams.model = 'glm-5'
    store.agentRole = 'coder'

    await store.sendMessage('hello')

    expect(openWebSocketStream).toHaveBeenCalledWith(
      'hello',
      's1',
      { provider: '智谱', model: 'glm-5' },
      'coder',
      undefined,
      expect.any(Object),
      // BUG-20260703：显式 Agent 同时作为 pinned_agent 锁定，后端跳过内容路由
      expect.objectContaining({
        pinned_agent: 'coder', user_locale: 'zh-CN', locale: 'zh-CN', producer_kind: 'chat',
      }),
      expect.any(String),
    )
  })

  it('persists assistant metadata and tool calls from websocket done chunks', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementation(
      (_text, _sid, _params, _role, _att, callbacks) => {
        callbacks?.onChunk('已完成')
        return {
          cancel: vi.fn(),
          done: Promise.resolve({
            content: '已完成',
            metadata: { backend_message_id: 'msg-backend-ws', agent_name: 'Coder' },
            toolCalls: [{ id: 'tool-1', name: 'search', arguments: '{}' }],
            agentName: 'Coder',
          }),
        }
      },
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    const promise = store.sendMessage('hello')
    const assistantMsg = await promise

    expect(assistantMsg?.metadata?.backend_message_id).toBe('msg-backend-ws')
    expect(assistantMsg?.agent_name).toBe('Coder')
    expect(assistantMsg?.tool_calls).toHaveLength(1)
  })

  it('updates an existing message and persists the patch', async () => {
    const store = useChatStore()
    await store.selectSession('s1')

    await store.updateMessage('m2', (current) => ({
      ...current,
      content: 'updated',
      metadata: { user_feedback: 'like' },
    }))

    expect(store.messages[1]?.content).toBe('updated')
    expect(persistMessage).toHaveBeenCalled()
  })

  it('syncs assistant feedback to backend when backend_message_id exists', async () => {
    loadMessages.mockResolvedValueOnce([
      {
        id: 'm2',
        role: 'assistant',
        content: 'hi',
        timestamp: '2026-01-01',
        metadata: { backend_message_id: 'msg-backend-1' },
      },
    ])

    const store = useChatStore()
    await store.selectSession('s1')

    await store.setMessageFeedback('m2', 'like')

    expect(updateMessageFeedback).toHaveBeenCalledWith('msg-backend-1', 'like')
    expect(store.messages[0]?.metadata?.user_feedback).toBe('like')
  })

  it('★AUDIT-20260626 fresh WS reply carries backend_message_id → 点刚生成答案的赞同步后端(不丢)', async () => {
    // 真实后端流式 done chunk 经 engine/react.go buildReplyMetadata/withAssistantMessageID
    // 注入 backend_message_id；前端必须把它接到 fresh 消息上，否则「点刚收到答案的赞」走
    // local-only 分支 → 重载即丢。这是「会话隔离/重载丢」缺口的流式层端到端取证。
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementationOnce(
      (_text: unknown, _sid: unknown, _params: unknown, _role: unknown, _att: unknown, callbacks: any) => {
        callbacks?.onChunk('你好！')
        return {
          cancel: vi.fn(),
          done: Promise.resolve({
            content: '你好！',
            metadata: { backend_message_id: 'ws-fresh-1' },
          }),
        }
      },
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    const assistantMsg = await store.sendMessage('hi')

    // fresh 消息应已带 backend_message_id（来自流式 done chunk metadata）
    expect(assistantMsg?.metadata?.backend_message_id).toBe('ws-fresh-1')

    // 点刚生成答案的赞 → 必须同步后端（否则重载丢）
    await store.setMessageFeedback(assistantMsg!.id, 'like')
    expect(updateMessageFeedback).toHaveBeenCalledWith('ws-fresh-1', 'like')
  })

  it('reverts local feedback when backend sync fails', async () => {
    updateMessageFeedback.mockRejectedValueOnce(new Error('sync failed'))
    loadMessages.mockResolvedValueOnce([
      {
        id: 'm2',
        role: 'assistant',
        content: 'hi',
        timestamp: '2026-01-01',
        metadata: { backend_message_id: 'msg-backend-1', user_feedback: 'dislike' },
      },
    ])

    const store = useChatStore()
    await store.selectSession('s1')

    await expect(store.setMessageFeedback('m2', 'like')).rejects.toThrow('sync failed')
    expect(store.messages[0]?.metadata?.user_feedback).toBe('dislike')
  })

  it('times out stalled websocket requests without falling back to backend', async () => {
    vi.useFakeTimers()
    ensureWebSocketConnected.mockResolvedValue(true)
    const store = useChatStore()

    const { ChatRequestError } = await import('@/services/chatService')
    openWebSocketStream.mockImplementationOnce(() => ({
      cancel: vi.fn(),
      done: Promise.reject(new ChatRequestError('助手长时间未开始回复，已超时并停止等待。', true)),
    }))

    await store.sendMessage('卡住的请求')

    expect(sendViaBackend).not.toHaveBeenCalled()
    expect(store.streaming).toBe(false)
    expect(store.messages[store.messages.length - 1]?.content).toContain('超时')

    vi.useRealTimers()
  })

  it('sends thinking metadata when thinkingEnabled is on', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementation(
      () => ({ cancel: vi.fn(), done: Promise.resolve({ content: '已完成' }) }),
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.thinkingEnabled = true

    await store.sendMessage('think hard')

    expect(openWebSocketStream).toHaveBeenCalledWith(
      'think hard',
      's1',
      expect.any(Object),
      '',
      undefined,
      expect.any(Object),
      expect.objectContaining({
        thinking: 'on', pinned_agent: 'default', user_locale: 'zh-CN', locale: 'zh-CN', producer_kind: 'chat',
      }),
      expect.any(String),
    )
  })

  it('shows the generic empty-answer fallback for unauthorized reasoning-only chunks', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementation(
      (_text, _sid, _params, _role, _att, callbacks) => {
        callbacks?.onChunk('', '只有思考，没有答案')
        return { cancel: vi.fn(), done: Promise.resolve({ content: '' }) }
      },
    )

    const store = useChatStore()
    store.currentSessionId = 's1'

    const msg = await store.sendMessage('去年的今天我们在哪里？')

    expect(msg?.content).toBe('这次没有生成可显示的回答，请重试或换个方式提问。')
    expect(msg?.reasoning).toBeUndefined()
    expect(msg?.metadata).toMatchObject({
      reasoning_visibility: 'not_exposed',
      runtime_events: [],
    })
  })

  it('sanitizes final content and hides leaked closing think-tag reasoning without disclosure', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementation(
      (_text, _sid, _params, _role, _att, callbacks) => {
        callbacks?.onChunk('', '</think>\n用户再次提问')
        return { cancel: vi.fn(), done: Promise.resolve({ content: '好的，我直接回答。' }) }
      },
    )

    const store = useChatStore()
    store.currentSessionId = 's1'

    const msg = await store.sendMessage('你想吃点什么？')

    expect(msg?.content).toBe('好的，我直接回答。')
    expect(msg?.content).not.toContain('</think>')
    expect(msg?.reasoning).toBeUndefined()
  })

  it('sends only the pinned-agent lock when thinkingEnabled is off (default)', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    openWebSocketStream.mockImplementation(
      () => ({ cancel: vi.fn(), done: Promise.resolve({ content: '已完成' }) }),
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    expect(store.thinkingEnabled).toBe(false) // default

    await store.sendMessage('quick reply')

    expect(openWebSocketStream).toHaveBeenCalledWith(
      'quick reply',
      's1',
      expect.any(Object),
      '',
      undefined,
      expect.any(Object),
      // BUG-20260703：聊天请求恒带 pinned_agent（默认助理=default），不再是 undefined
      expect.objectContaining({
        pinned_agent: 'default', user_locale: 'zh-CN', locale: 'zh-CN', producer_kind: 'chat',
      }),
      expect.any(String),
    )
  })

  it('preserves thinking metadata on the sole WebSocket request', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.thinkingEnabled = true

    await store.sendMessage('think hard over websocket')

    expect(openWebSocketStream).toHaveBeenCalledWith(
      'think hard over websocket',
      's1',
      expect.any(Object),
      '',
      undefined,
      expect.any(Object),
      expect.objectContaining({
        thinking: 'on', pinned_agent: 'default', user_locale: 'zh-CN', locale: 'zh-CN', producer_kind: 'chat',
      }),
      expect.any(String),
    )
  })

  it('recovers active streams by request id and finalizes them into the original session', async () => {
    let resolveResume!: (value: { content: string; metadata?: Record<string, unknown> }) => void

    listActiveStreams.mockResolvedValueOnce({
      streams: [{
        request_id: 'req-recover-1',
        session_id: 's1',
        content: '恢复中的回答',
        reasoning: '恢复中的思考',
        done: false,
        status: 'streaming',
      }],
      total: 1,
    })
    loadMessages.mockResolvedValueOnce([])
    loadArtifacts.mockResolvedValueOnce([])
    resumeWebSocketStream.mockImplementationOnce((_sid, _requestId, callbacks) => {
      callbacks?.onSnapshot?.({
        content: '恢复中的回答',
        reasoning: '恢复中的思考',
        metadata: { request_id: 'req-recover-1' },
        done: false,
      })
      return {
        cancel: vi.fn(),
        done: new Promise((resolve) => {
          resolveResume = resolve as typeof resolveResume
        }),
      }
    })

    const store = useChatStore()
    await store.selectSession('s1')
    const recovery = store.recoverActiveStreams()
    await flushStreamSetup()

    expect(listActiveStreams).toHaveBeenCalledTimes(1)
    expect(resumeWebSocketStream).toHaveBeenCalledWith(
      's1',
      'req-recover-1',
      expect.objectContaining({
        onSnapshot: expect.any(Function),
        onChunk: expect.any(Function),
        onApprovalRequest: expect.any(Function),
      }),
      'off',
    )
    expect(store.isSessionStreaming('s1')).toBe(true)
    expect(store.streamingSessionId).toBe('s1')
    expect(store.streamingContent).toBe('恢复中的回答')

    resolveResume({ content: '恢复完成', metadata: { request_id: 'req-recover-1' } })
    await recovery
    await flushStreamSetup()

    expect(store.isSessionStreaming('s1')).toBe(false)
    const finalMessage = store.messages[store.messages.length - 1]
    expect(finalMessage?.role).toBe('assistant')
    expect(finalMessage?.content).toBe('恢复完成')
  })

  it('tracks pending approvals per session and only clears the matching request', async () => {
    const store = useChatStore()
    store.currentSessionId = 's1'
    store.initApprovalListener()
    const createResponder = (identity: {
      sessionId: string
      invocationId: string
      argumentsDigest: string
      securityScopeDigest: string
    }) => vi.fn(async (decision: {
      request_id: string
      decision_id: string
      decision: 'approved_once' | 'approved_remember' | 'denied'
      idempotency_key: string
    }) => ({
      type: 'tool_approval_ack' as const,
      request_id: decision.request_id,
      session_id: identity.sessionId,
      owner_id: 'desktop-user',
      invocation_id: identity.invocationId,
      arguments_digest: identity.argumentsDigest,
      security_scope_digest: identity.securityScopeDigest,
      scope_schema_version: 1,
      decision_id: decision.decision_id,
      decision: decision.decision,
      idempotency_key: decision.idempotency_key,
      status: 'accepted' as const,
    }))
    const respondS1 = createResponder({
      sessionId: 's1',
      invocationId: 'invocation-s1',
      argumentsDigest: 'a'.repeat(64),
      securityScopeDigest: 'b'.repeat(64),
    })
    const respondS2 = createResponder({
      sessionId: 's2',
      invocationId: 'invocation-s2',
      argumentsDigest: 'c'.repeat(64),
      securityScopeDigest: 'd'.repeat(64),
    })

    for (const listener of approvalListeners) {
      listener({
        requestId: 'req-s1',
        sessionId: 's1',
        ownerId: 'desktop-user',
        invocationId: 'invocation-s1',
        toolName: 'tool-a',
        argumentsDigest: 'a'.repeat(64),
        securityScopeDigest: 'b'.repeat(64),
        scopeSchemaVersion: 1,
        risk: 'sensitive',
        reason: 'session 1 approval',
        respondApproval: respondS1,
      })
      listener({
        requestId: 'req-s2',
        sessionId: 's2',
        ownerId: 'desktop-user',
        invocationId: 'invocation-s2',
        toolName: 'tool-b',
        argumentsDigest: 'c'.repeat(64),
        securityScopeDigest: 'd'.repeat(64),
        scopeSchemaVersion: 1,
        risk: 'dangerous',
        reason: 'session 2 approval',
        respondApproval: respondS2,
      })
    }

    expect(store.pendingApproval?.requestId).toBe('req-s1')
    expect(store.hasSessionPendingApproval('s1')).toBe(true)
    expect(store.hasSessionPendingApproval('s2')).toBe(true)

    await store.respondApproval('req-s1', true, false)

    expect(respondS1).toHaveBeenCalledWith(expect.objectContaining({
      request_id: 'req-s1',
      decision: 'approved_once',
      idempotency_key: expect.any(String),
    }))
    expect(respondS2).not.toHaveBeenCalled()
    expect(store.pendingApproval).toBeNull()
    expect(store.hasSessionPendingApproval('s1')).toBe(false)
    expect(store.hasSessionPendingApproval('s2')).toBe(true)

    store.currentSessionId = 's2'
    expect(store.pendingApproval?.requestId).toBe('req-s2')
  })

  it('exposes session-scoped approval projection cleanup through the canonical chat store facade', () => {
    const store = useChatStore()
    store.pendingApprovals = {
      'req-s1': {
        requestId: 'req-s1',
        sessionId: 's1',
        toolName: 'tool-a',
        risk: 'sensitive',
        reason: 'session 1 approval',
        receivedAt: 1,
      },
      'req-s2': {
        requestId: 'req-s2',
        sessionId: 's2',
        toolName: 'tool-b',
        risk: 'dangerous',
        reason: 'session 2 approval',
        receivedAt: 2,
      },
    }

    store.clearPendingApprovalsForSession('s1')

    expect(store.pendingApprovals['req-s1']).toBeUndefined()
    expect(store.pendingApprovals['req-s2']).toMatchObject({ sessionId: 's2' })
  })

  it('sends explicit provider and model to the WebSocket request', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    const store = useChatStore()
    store.chatParams.provider = '智谱'
    store.chatParams.model = 'glm-5'

    await store.sendMessage('走 WebSocket')

    expect(openWebSocketStream).toHaveBeenCalledWith(
      '走 WebSocket',
      expect.any(String),
      { provider: '智谱', model: 'glm-5' },
      '',
      undefined,
      expect.any(Object),
      expect.objectContaining({
        pinned_agent: 'default', user_locale: 'zh-CN', locale: 'zh-CN', producer_kind: 'chat',
      }),
      expect.any(String),
    )
  })

  // BUG-20260704：消息提交后要等 1-2 秒才显示小蟹和回答气泡。
  // 根因：assistant 挂起/流式气泡的渲染门是 `isCurrentStreaming || showAssistantPending`，
  // 而 showAssistantPending 依赖 `chatStore.sending===true`。sendMessage 在乐观 push 用户气泡后
  // 会先 `await backendText()`（Auto-RAG searchKnowledge 网络往返，最长 AUTO_RAG_BUDGET_MS=1200ms），
  // 再进 deliverMessage 才 setSessionPending(true)/upsertStreamState。于是在 Auto-RAG 解析这段时间里
  // sending 仍为 false、也无流式态 → 小蟹气泡迟迟不出现。修复=push 用户气泡后、await Auto-RAG 前就把
  // 本会话置为 pending，让挂起气泡即时上屏。此测试钉死「Auto-RAG 在途时 sending 必须已为 true」。
  it('bug-20260704: assistant 挂起气泡在 Auto-RAG(backendText thunk) 解析期间即就绪，不等 1-2 秒', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    // 流式永不结束：本例只关心「挂起态是否及时出现」，不关心收尾。
    openWebSocketStream.mockImplementation(() => ({ cancel: vi.fn(), done: new Promise<never>(() => {}) }))

    const store = useChatStore()
    await store.selectSession('s1') // 既有会话：draftSending 从一开始就是 false，sending 真从 false 起
    await new Promise((r) => setTimeout(r))

    // 受控的慢 backendText thunk：模拟 Auto-RAG searchKnowledge 网络往返/1.2s 预算，卡住不放。
    let releaseRag!: () => void
    const ragGate = new Promise<void>((r) => { releaseRag = r })
    const backendText = vi.fn(async () => { await ragGate; return undefined })

    void store.sendMessage('你好，帮我看看这个', undefined, { backendText })
    // 让 push(userMessage) + ensureSession 沉淀；此刻执行应停在 `await backendText()`（ragGate 未放）。
    await new Promise((r) => setTimeout(r))
    await new Promise((r) => setTimeout(r))

    // 用户气泡已乐观上屏，且 Auto-RAG 确已在途但未完成
    expect(store.messages.some((m) => m.role === 'user')).toBe(true)
    expect(store.messages[store.messages.length - 1]?.role).toBe('user')
    expect(backendText).toHaveBeenCalled()
    // 请求拥有的 assistant identity 在 backendText 解析前已创建，后续 token/terminal 复用同一状态。
    expect(store.isCurrentStreaming).toBe(true)
    // ★核心：Auto-RAG 在途时就应进入挂起态（sending=true），否则小蟹气泡要等 1-2s。
    expect(store.sending, 'Auto-RAG 解析期间 sending 应已为 true（否则小蟹挂起气泡延迟 1-2s）').toBe(true)

    releaseRag()
  })
})
