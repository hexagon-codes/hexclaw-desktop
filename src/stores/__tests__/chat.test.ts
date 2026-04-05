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
  touchSession,
  persistMessage,
  loadArtifacts,
  saveArtifact,
  getLastSessionId,
  setLastSessionId,
  // chatService
  ensureWebSocketConnected,
  sendViaWebSocket,
  sendViaBackend,
  clearWebSocketCallbacks,
  // api/chat
  updateMessageFeedback,
  sendRaw,
  triggerError,
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
  touchSession: vi.fn().mockResolvedValue(undefined),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  loadArtifacts: vi.fn().mockResolvedValue([]),
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  getLastSessionId: vi.fn().mockResolvedValue(null),
  setLastSessionId: vi.fn().mockResolvedValue(undefined),

  ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
  sendViaWebSocket: vi.fn().mockResolvedValue(undefined),
  sendViaBackend: vi.fn().mockResolvedValue({ reply: '你好！', session_id: 's1' }),
  clearWebSocketCallbacks: vi.fn(),

  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
  sendRaw: vi.fn(),
  triggerError: vi.fn(),
}))

vi.mock('@/services/messageService', () => ({
  loadAllSessions,
  loadMessages,
  createSession,
  updateSessionTitle,
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
    sendViaBackend,
    clearWebSocketCallbacks,
    ChatRequestError,
  }
})

vi.mock('@/api/chat', () => ({
  updateMessageFeedback,
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    sendRaw,
    triggerError,
  },
}))

// DB layer removed — all data operations go through services which use the API

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

  it('newSession resets stale artifact and streaming state', () => {
    const store = useChatStore()
    store.currentSessionId = 's1'
    store.messages = [{ id: 'm1', role: 'assistant', content: 'done', timestamp: '' }]
    store.artifacts = [{ id: 'a1', type: 'code', title: 'Snippet', language: 'ts', content: 'console.log(1)', messageId: 'm1', createdAt: '' }]
    store.selectedArtifactId = 'a1'
    store.showArtifacts = true
    store.streaming = true
    store.streamingSessionId = 's1'
    store.streamingContent = 'partial'

    store.newSession()

    expect(store.currentSessionId).toBeNull()
    expect(store.artifacts).toEqual([])
    expect(store.selectedArtifactId).toBeNull()
    expect(store.showArtifacts).toBe(false)
    expect(store.streaming).toBe(false)
    expect(store.streamingSessionId).toBeNull()
    expect(store.streamingContent).toBe('')
  })

  it('deleteSession clears artifact and streaming state for the active session', async () => {
    const store = useChatStore()
    await store.loadSessions()
    store.currentSessionId = 's1'
    store.messages = [{ id: 'm1', role: 'assistant', content: 'done', timestamp: '' }]
    store.artifacts = [{ id: 'a1', type: 'code', title: 'Snippet', language: 'ts', content: 'console.log(1)', messageId: 'm1', createdAt: '' }]
    store.selectedArtifactId = 'a1'
    store.showArtifacts = true
    store.streaming = true
    store.streamingSessionId = 's1'
    store.streamingContent = 'partial'

    await store.deleteSession('s1')

    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.artifacts).toEqual([])
    expect(store.selectedArtifactId).toBeNull()
    expect(store.showArtifacts).toBe(false)
    expect(store.streaming).toBe(false)
    expect(store.streamingSessionId).toBeNull()
    expect(store.streamingContent).toBe('')
  })

  it('deleteSession cancels an in-flight stream for the active session', async () => {
    const store = useChatStore()
    await store.loadSessions()
    store.currentSessionId = 's1'
    store.streaming = true
    store.streamingSessionId = 's1'
    store.streamingContent = 'partial'

    await store.deleteSession('s1')

    expect(sendRaw).toHaveBeenCalledWith({ type: 'cancel', session_id: 's1' })
    expect(triggerError).toHaveBeenCalledWith('用户取消')
    expect(clearWebSocketCallbacks).toHaveBeenCalled()
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
    sendViaWebSocket.mockImplementation(
      (_text, _sid, _params, _role, _att, callbacks) => {
        callbacks?.onDone('已完成', undefined, undefined, undefined)
        return Promise.resolve()
      },
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.chatParams.provider = '智谱'
    store.chatParams.model = 'glm-5'

    await store.sendMessage('hello')

    expect(sendViaWebSocket).toHaveBeenCalledWith(
      'hello',
      's1',
      { provider: '智谱', model: 'glm-5' },
      '',
      undefined,
      expect.any(Object),
      undefined,
    )
  })

  it('sends explicit agent role to websocket requests when entering a specialist mode', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    sendViaWebSocket.mockImplementation(
      (_text, _sid, _params, _role, _att, callbacks) => {
        callbacks?.onDone('已完成', undefined, undefined, undefined)
        return Promise.resolve()
      },
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.chatParams.provider = '智谱'
    store.chatParams.model = 'glm-5'
    store.agentRole = 'coder'

    await store.sendMessage('hello')

    expect(sendViaWebSocket).toHaveBeenCalledWith(
      'hello',
      's1',
      { provider: '智谱', model: 'glm-5' },
      'coder',
      undefined,
      expect.any(Object),
      undefined,
    )
  })

  it('persists assistant metadata and tool calls from websocket done chunks', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    sendViaWebSocket.mockImplementation(
      (_text, _sid, _params, _role, _att, callbacks) => {
        callbacks?.onChunk('已完成')
        callbacks?.onDone(
          '已完成',
          { backend_message_id: 'msg-backend-ws', agent_name: 'Coder' },
          [{ id: 'tool-1', name: 'search', arguments: '{}' }],
          'Coder',
        )
        return Promise.resolve()
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
    // sendViaWebSocket never resolves → triggers timeout inside chatService
    sendViaWebSocket.mockImplementation(() => new Promise(() => {}))

    const store = useChatStore()

    // Manually trigger sendMessage — it will hang on sendViaWebSocket
    // The timeout is handled inside chatService.sendViaWebSocket,
    // but since we mock it as never-resolving, the store's own flow won't time out.
    // Instead, simulate the ChatRequestError that the real service would throw.
    const { ChatRequestError } = await import('@/services/chatService')
    sendViaWebSocket.mockRejectedValueOnce(
      new ChatRequestError('助手长时间未开始回复，已超时并停止等待。', true),
    )

    await store.sendMessage('卡住的请求')

    expect(sendViaBackend).not.toHaveBeenCalled()
    expect(store.streaming).toBe(false)
    expect(store.messages[store.messages.length - 1]?.content).toContain('超时')

    vi.useRealTimers()
  })

  it('sends thinking metadata when thinkingEnabled is on', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    sendViaWebSocket.mockImplementation(
      (_text: string, _sid: string, _params: unknown, _role: string, _att: unknown, callbacks: { onDone: (c: string) => void }) => {
        callbacks?.onDone('已完成')
        return Promise.resolve()
      },
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.thinkingEnabled = true

    await store.sendMessage('think hard')

    expect(sendViaWebSocket).toHaveBeenCalledWith(
      'think hard',
      's1',
      expect.any(Object),
      '',
      undefined,
      expect.any(Object),
      { thinking: 'on' },
    )
  })

  it('sends undefined metadata when thinkingEnabled is off (default)', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    sendViaWebSocket.mockImplementation(
      (_text: string, _sid: string, _params: unknown, _role: string, _att: unknown, callbacks: { onDone: (c: string) => void }) => {
        callbacks?.onDone('已完成')
        return Promise.resolve()
      },
    )

    const store = useChatStore()
    store.currentSessionId = 's1'
    expect(store.thinkingEnabled).toBe(false) // default

    await store.sendMessage('quick reply')

    expect(sendViaWebSocket).toHaveBeenCalledWith(
      'quick reply',
      's1',
      expect.any(Object),
      '',
      undefined,
      expect.any(Object),
      undefined,
    )
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
    )
  })
})
