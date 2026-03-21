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
    isConnected: vi.fn().mockReturnValue(false),
    connect: vi.fn().mockRejectedValue(new Error('test')),
    clearCallbacks: vi.fn(),
    onChunk: vi.fn(),
    onReply: vi.fn(),
    onError: vi.fn(),
    sendMessage: vi.fn(),
  },
}))

vi.mock('@/api/chat', () => ({
  sendChatViaBackend,
  sendChat: vi.fn(),
}))

describe('useChatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    sendChatViaBackend.mockResolvedValue({ reply: '你好！', session_id: 's1' })
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
})
