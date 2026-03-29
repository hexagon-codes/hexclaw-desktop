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
  outboxInsert,
  outboxMarkSending,
  outboxMarkSent,
  outboxMarkFailed,
  retryPendingOutbox,
  cleanupOutbox,
  // api/messages
  updateMessageFeedback,
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
  outboxInsert: vi.fn().mockResolvedValue(undefined),
  outboxMarkSending: vi.fn().mockResolvedValue(undefined),
  outboxMarkSent: vi.fn().mockResolvedValue(undefined),
  outboxMarkFailed: vi.fn().mockResolvedValue(undefined),
  retryPendingOutbox: vi.fn(),
  cleanupOutbox: vi.fn(),

  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
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
    outboxInsert,
    outboxMarkSending,
    outboxMarkSent,
    outboxMarkFailed,
    retryPendingOutbox,
    cleanupOutbox,
    ChatRequestError,
  }
})

vi.mock('@/api/messages', () => ({
  updateMessageFeedback,
}))

// chat.ts 也引用了这些，提供空 mock 防止 import 报错
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

describe('useChatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
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
