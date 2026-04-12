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
  // api/chat
  updateMessageFeedback,
  listActiveStreams,
  sendRaw,
  triggerError,
  onApprovalRequest,
  sendApprovalResponse,
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

  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
  sendRaw: vi.fn(),
  triggerError: vi.fn(),
  approvalListeners: [] as Array<(req: { requestId: string; sessionId: string; toolName: string; risk: string; reason: string }) => void>,
  onApprovalRequest: vi.fn().mockImplementation((cb) => {
    approvalListeners.push(cb)
    return () => {
      const idx = approvalListeners.indexOf(cb)
      if (idx >= 0) approvalListeners.splice(idx, 1)
    }
  }),
  sendApprovalResponse: vi.fn(),
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
    sendApprovalResponse,
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
    ensureWebSocketConnected.mockResolvedValue(false)
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
    ensureWebSocketConnected.mockResolvedValue(false)
    sendViaBackend.mockResolvedValueOnce({ reply: '收到', metadata: {} })

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
    ensureWebSocketConnected.mockResolvedValue(false)
    sendViaBackend.mockResolvedValueOnce({ reply: '可以从帐篷、睡袋、炊具和照明开始准备', metadata: {} })

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
      undefined,
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
      undefined,
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
    sendViaBackend.mockResolvedValueOnce({
      reply: '已完成',
      session_id: 's1',
      metadata: {
        provider: 'openai',
        model: 'gpt-4o',
        agent_name: 'Coder',
        knowledge_hits: [{ doc_title: 'Spec' }],
      },
      tool_calls: [{ id: 'tool-1', name: 'search', arguments: '{"q":"spec"}' }],
    })

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
      undefined,
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
      undefined,
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
      { thinking: 'on' },
      expect.any(String),
    )
  })

  it('shows a fallback message when websocket returns reasoning only', async () => {
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

    expect(msg?.content).toBe('模型只完成了思考，没有输出最终回答，请重试一次。')
    expect(msg?.reasoning).toBe('只有思考，没有答案')
  })

  it('strips leaked closing think tags from websocket reasoning chunks', async () => {
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
    expect(msg?.reasoning).toBe('用户再次提问')
  })

  it('sends undefined metadata when thinkingEnabled is off (default)', async () => {
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
      undefined,
      expect.any(String),
    )
  })

  it('preserves thinking metadata when falling back to backend', async () => {
    ensureWebSocketConnected.mockResolvedValue(false)

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.thinkingEnabled = true

    await store.sendMessage('think hard over http')

    expect(sendViaBackend).toHaveBeenCalledWith(
      'think hard over http',
      's1',
      expect.any(Object),
      '',
      undefined,
      { thinking: 'on' },
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
      }),
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

    for (const listener of approvalListeners) {
      listener({
        requestId: 'req-s1',
        sessionId: 's1',
        toolName: 'tool-a',
        risk: 'sensitive',
        reason: 'session 1 approval',
      })
      listener({
        requestId: 'req-s2',
        sessionId: 's2',
        toolName: 'tool-b',
        risk: 'dangerous',
        reason: 'session 2 approval',
      })
    }

    expect(store.pendingApproval?.requestId).toBe('req-s1')
    expect(store.hasSessionPendingApproval('s1')).toBe(true)
    expect(store.hasSessionPendingApproval('s2')).toBe(true)

    store.respondApproval('req-s1', true, false)

    expect(sendApprovalResponse).toHaveBeenCalledWith('req-s1', true, false)
    expect(store.pendingApproval).toBeNull()
    expect(store.hasSessionPendingApproval('s1')).toBe(false)
    expect(store.hasSessionPendingApproval('s2')).toBe(true)

    store.currentSessionId = 's2'
    expect(store.pendingApproval?.requestId).toBe('req-s2')
  })

  it('sends explicit provider and model to backend fallback requests', async () => {
    ensureWebSocketConnected.mockResolvedValue(false)

    const store = useChatStore()
    store.chatParams.provider = '智谱'
    store.chatParams.model = 'glm-5'

    await store.sendMessage('走 HTTP')

    expect(sendViaBackend).toHaveBeenCalledWith(
      '走 HTTP',
      expect.any(String),
      { provider: '智谱', model: 'glm-5' },
      '',
      undefined,
      undefined,
      expect.any(String),
    )
  })
})
