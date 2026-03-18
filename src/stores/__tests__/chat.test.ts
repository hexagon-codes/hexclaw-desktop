import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../chat'

// Mock 正确的依赖模块：chat store 使用 @/db/chat + @/api/websocket
vi.mock('@/db/chat', () => ({
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
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: '你好！', session_id: 's1' }),
  sendChat: vi.fn(),
}))

describe('useChatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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
})
