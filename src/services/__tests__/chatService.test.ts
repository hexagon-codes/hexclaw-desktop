import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  wsIsConnected, wsConnect, wsClearCallbacks, wsOnChunk, wsOnReply, wsOnError, wsSendMessage,
  sendChatViaBackend,
  dbOutboxInsert, dbOutboxMarkSending, dbOutboxMarkSent, dbOutboxMarkFailed, dbOutboxGetPending, dbOutboxCleanup,
} = vi.hoisted(() => ({
  wsIsConnected: vi.fn().mockReturnValue(false),
  wsConnect: vi.fn().mockResolvedValue(undefined),
  wsClearCallbacks: vi.fn(),
  wsOnChunk: vi.fn().mockReturnValue(() => {}),
  wsOnReply: vi.fn().mockReturnValue(() => {}),
  wsOnError: vi.fn().mockReturnValue(() => {}),
  wsSendMessage: vi.fn(),
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's1' }),
  dbOutboxInsert: vi.fn().mockResolvedValue(undefined),
  dbOutboxMarkSending: vi.fn().mockResolvedValue(undefined),
  dbOutboxMarkSent: vi.fn().mockResolvedValue(undefined),
  dbOutboxMarkFailed: vi.fn().mockResolvedValue(undefined),
  dbOutboxGetPending: vi.fn().mockResolvedValue([]),
  dbOutboxCleanup: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    isConnected: wsIsConnected, connect: wsConnect, clearCallbacks: wsClearCallbacks,
    onChunk: wsOnChunk, onReply: wsOnReply, onError: wsOnError, sendMessage: wsSendMessage,
  },
}))
vi.mock('@/api/chat', () => ({ sendChatViaBackend }))
vi.mock('@/db/outbox', () => ({
  dbOutboxInsert, dbOutboxMarkSending, dbOutboxMarkSent, dbOutboxMarkFailed, dbOutboxGetPending, dbOutboxCleanup,
}))

import { ensureWebSocketConnected, sendViaBackend, sendViaWebSocket, ChatRequestError } from '../chatService'

describe('chatService', () => {
  beforeEach(() => vi.clearAllMocks())

  // ─── ensureWebSocketConnected ───
  it('returns true when already connected', async () => {
    wsIsConnected.mockReturnValue(true)
    expect(await ensureWebSocketConnected()).toBe(true)
  })

  it('returns true after successful connect', async () => {
    wsIsConnected.mockReturnValue(false)
    wsConnect.mockResolvedValueOnce(undefined)
    expect(await ensureWebSocketConnected()).toBe(true)
  })

  it('returns false when connection fails', async () => {
    wsIsConnected.mockReturnValue(false)
    wsConnect.mockRejectedValueOnce(new Error('refused'))
    expect(await ensureWebSocketConnected()).toBe(false)
  })

  // ─── sendViaBackend ───
  it('passes temperature and maxTokens to backend', async () => {
    await sendViaBackend('hello', 's1', { model: 'glm-5', provider: '智谱', temperature: 0.8, maxTokens: 2048 }, '', undefined)
    expect(sendChatViaBackend).toHaveBeenCalledWith('hello', expect.objectContaining({
      temperature: 0.8,
      maxTokens: 2048,
      model: 'glm-5',
      provider: '智谱',
    }))
  })

  it('passes undefined temperature when not set', async () => {
    await sendViaBackend('hi', 's1', { model: 'gpt-4' }, '', undefined)
    expect(sendChatViaBackend).toHaveBeenCalledWith('hi', expect.objectContaining({
      temperature: undefined,
      maxTokens: undefined,
    }))
  })

  // ─── sendViaWebSocket ───
  it('sends message with temperature/maxTokens via WebSocket', async () => {
    wsOnReply.mockImplementation((cb) => { cb({ content: 'done', type: 'reply' }); return () => {} })
    await sendViaWebSocket('hi', 's1', { model: 'glm-5', temperature: 0.5, maxTokens: 1024 }, 'coder', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })
    expect(wsSendMessage).toHaveBeenCalledWith('hi', 's1', 'glm-5', 'coder', undefined, undefined, 0.5, 1024, undefined)
  })

  it('passes metadata through to WebSocket sendMessage', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => { cb({ content: 'done', type: 'reply' }); return () => {} })
    await sendViaWebSocket('hi', 's1', { model: 'qwen3:8b' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }, { thinking: 'on' })
    expect(wsSendMessage).toHaveBeenCalledWith('hi', 's1', 'qwen3:8b', undefined, undefined, undefined, undefined, undefined, { thinking: 'on' })
  })

  it('omits metadata when undefined', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => { cb({ content: 'done', type: 'reply' }); return () => {} })
    await sendViaWebSocket('hi', 's1', { model: 'glm-5' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })
    expect(wsSendMessage).toHaveBeenCalledWith('hi', 's1', 'glm-5', undefined, undefined, undefined, undefined, undefined, undefined)
  })

  // ─── ChatRequestError ───
  it('ChatRequestError has noFallback property', () => {
    const err = new ChatRequestError('timeout', true)
    expect(err.noFallback).toBe(true)
    expect(err.message).toBe('timeout')
    expect(err.name).toBe('ChatRequestError')
  })

  it('ChatRequestError defaults noFallback to false', () => {
    const err = new ChatRequestError('error')
    expect(err.noFallback).toBe(false)
  })
})
