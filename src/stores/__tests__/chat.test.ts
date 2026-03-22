import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../chat'

// Mock 正确的依赖模块：chat store 使用 @/db/chat + @/api/websocket
const {
  dbGetSessions,
  dbGetMessages,
  dbCreateSession,
  dbUpdateSessionTitle,
  dbTouchSession,
  dbDeleteSession,
  dbSaveMessage,
  sendChatViaBackend,
  wsIsConnected,
  wsConnect,
  wsClearCallbacks,
  wsOnChunk,
  wsOnReply,
  wsOnError,
  wsSendMessage,
  updateMessageFeedback,
} = vi.hoisted(() => ({
  dbGetSessions: vi.fn().mockResolvedValue([
    { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01' },
  ]),
  dbGetMessages: vi.fn().mockResolvedValue([
    { id: 'm1', session_id: 's1', role: 'user', content: 'hello', timestamp: '2026-01-01', metadata: null },
    { id: 'm2', session_id: 's1', role: 'assistant', content: 'hi', timestamp: '2026-01-01', metadata: null },
  ]),
  dbCreateSession: vi.fn().mockResolvedValue(undefined),
  dbUpdateSessionTitle: vi.fn().mockResolvedValue(undefined),
  dbTouchSession: vi.fn().mockResolvedValue(undefined),
  dbDeleteSession: vi.fn().mockResolvedValue(undefined),
  dbSaveMessage: vi.fn().mockResolvedValue(undefined),
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: '你好！', session_id: 's1' }),
  wsIsConnected: vi.fn().mockReturnValue(false),
  wsConnect: vi.fn().mockRejectedValue(new Error('test')),
  wsClearCallbacks: vi.fn(),
  wsOnChunk: vi.fn(),
  wsOnReply: vi.fn(),
  wsOnError: vi.fn(),
  wsSendMessage: vi.fn(),
  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
}))

vi.mock('@/db/chat', () => ({
  dbGetSessions,
  dbGetMessages,
  dbCreateSession,
  dbUpdateSessionTitle,
  dbTouchSession,
  dbDeleteSession,
  dbSaveMessage,
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    isConnected: wsIsConnected,
    connect: wsConnect,
    clearCallbacks: wsClearCallbacks,
    onChunk: wsOnChunk,
    onReply: wsOnReply,
    onError: wsOnError,
    sendMessage: wsSendMessage,
  },
}))

vi.mock('@/api/chat', () => ({
  sendChatViaBackend,
  sendChat: vi.fn(),
}))

vi.mock('@/api/messages', () => ({
  updateMessageFeedback,
}))

describe('useChatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    sendChatViaBackend.mockResolvedValue({ reply: '你好！', session_id: 's1' })
    wsIsConnected.mockReturnValue(false)
    wsConnect.mockRejectedValue(new Error('test'))
    wsOnChunk.mockImplementation(() => () => {})
    wsOnReply.mockImplementation(() => () => {})
    wsOnError.mockImplementation(() => () => {})
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
    sendChatViaBackend.mockResolvedValueOnce({
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
    expect(dbSaveMessage).toHaveBeenCalled()
  })

  it('sends explicit provider and model to websocket requests', async () => {
    wsIsConnected.mockReturnValue(true)

    let replyHandler: ((message: {
      content: string
      metadata?: Record<string, unknown>
    }) => void) | undefined

    wsOnReply.mockImplementation((cb) => {
      replyHandler = cb
      return () => {}
    })

    const store = useChatStore()
    store.currentSessionId = 's1'
    store.chatParams.provider = '智谱'
    store.chatParams.model = 'glm-5'

    const promise = store.sendMessage('hello')
    await Promise.resolve()

    expect(wsSendMessage).toHaveBeenCalledWith(
      'hello',
      's1',
      'glm-5',
      'assistant',
      undefined,
      '智谱',
    )

    replyHandler?.({ content: '已完成' })
    await promise
  })

  it('persists assistant metadata and tool calls from websocket done chunks', async () => {
    wsIsConnected.mockReturnValue(true)

    let chunkHandler: ((message: {
      content: string
      done?: boolean
      metadata?: Record<string, unknown>
      tool_calls?: { id: string; name: string; arguments: string }[]
    }) => void) | undefined

    wsOnChunk.mockImplementation((cb) => {
      chunkHandler = cb
      return () => {}
    })

    const store = useChatStore()
    store.currentSessionId = 's1'
    const promise = store.sendMessage('hello')
    await Promise.resolve()

    chunkHandler?.({ content: '已完成', done: false })
    chunkHandler?.({
      content: '',
      done: true,
      metadata: {
        backend_message_id: 'msg-backend-ws',
        agent_name: 'Coder',
      },
      tool_calls: [{ id: 'tool-1', name: 'search', arguments: '{}' }],
    })

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
    expect(dbSaveMessage).toHaveBeenCalledWith(
      'm2',
      's1',
      'assistant',
      'updated',
      '2026-01-01',
      { user_feedback: 'like' },
    )
  })

  it('syncs assistant feedback to backend when backend_message_id exists', async () => {
    dbGetMessages.mockResolvedValueOnce([
      {
        id: 'm2',
        session_id: 's1',
        role: 'assistant',
        content: 'hi',
        timestamp: '2026-01-01',
        metadata: JSON.stringify({ backend_message_id: 'msg-backend-1' }),
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
    dbGetMessages.mockResolvedValueOnce([
      {
        id: 'm2',
        session_id: 's1',
        role: 'assistant',
        content: 'hi',
        timestamp: '2026-01-01',
        metadata: JSON.stringify({ backend_message_id: 'msg-backend-1', user_feedback: 'dislike' }),
      },
    ])

    const store = useChatStore()
    await store.selectSession('s1')

    await expect(store.setMessageFeedback('m2', 'like')).rejects.toThrow('sync failed')
    expect(store.messages[0]?.metadata?.user_feedback).toBe('dislike')
  })

  it('times out stalled websocket requests without falling back to backend', async () => {
    vi.useFakeTimers()
    wsIsConnected.mockReturnValue(true)

    const store = useChatStore()
    const promise = store.sendMessage('卡住的请求')

    await vi.advanceTimersByTimeAsync(45_001)
    await promise

    expect(sendChatViaBackend).not.toHaveBeenCalled()
    expect(store.streaming).toBe(false)
    expect(store.messages[store.messages.length - 1]?.content).toContain('超时')

    vi.useRealTimers()
  })

  it('sends explicit provider and model to backend fallback requests', async () => {
    wsIsConnected.mockReturnValue(false)

    const store = useChatStore()
    store.chatParams.provider = '智谱'
    store.chatParams.model = 'glm-5'

    await store.sendMessage('走 HTTP')

    expect(sendChatViaBackend).toHaveBeenCalledWith('走 HTTP', expect.objectContaining({
      provider: '智谱',
      model: 'glm-5',
    }))
  })
})
