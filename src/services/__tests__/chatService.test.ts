import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  wsIsConnected,
  wsConnect,
  wsClearCallbacks,
  wsOnChunk,
  wsOnReply,
  wsOnError,
  wsOnApprovalRequest,
  wsSendMessage,
  sendChatViaBackend,
  approvalCallbacks,
  socketInstances,
} = vi.hoisted(() => ({
  wsIsConnected: vi.fn().mockReturnValue(false),
  wsConnect: vi.fn().mockResolvedValue(undefined),
  approvalCallbacks: [] as Array<(req: { requestId: string }) => void>,
  wsClearCallbacks: vi.fn().mockImplementation(() => {
    approvalCallbacks.length = 0
  }),
  wsOnChunk: vi.fn().mockReturnValue(() => {}),
  wsOnReply: vi.fn().mockReturnValue(() => {}),
  wsOnError: vi.fn().mockReturnValue(() => {}),
  wsOnApprovalRequest: vi.fn().mockImplementation((cb: (req: { requestId: string }) => void) => {
    approvalCallbacks.push(cb)
    return () => {
      const idx = approvalCallbacks.indexOf(cb)
      if (idx >= 0) approvalCallbacks.splice(idx, 1)
    }
  }),
  wsSendMessage: vi.fn(),
  sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's1' }),
  socketInstances: [] as Array<{
    url: string
    readyState: number
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    onopen: ((event?: unknown) => void) | null
    onmessage: ((event: { data: string }) => void) | null
    onerror: ((event?: unknown) => void) | null
    onclose: ((event?: unknown) => void) | null
  }>,
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    isConnected: wsIsConnected, connect: wsConnect,
    clearCallbacks: wsClearCallbacks, clearStreamCallbacks: vi.fn(),
    onChunk: wsOnChunk,
    onReply: wsOnReply,
    onError: wsOnError,
    onApprovalRequest: wsOnApprovalRequest,
    sendMessage: wsSendMessage,
  },
}))
vi.mock('@/api/chat', () => ({ sendChatViaBackend }))

import { hexclawWS } from '@/api/websocket'
import { ensureWebSocketConnected, sendViaBackend, sendViaWebSocket, openWebSocketStream, resumeWebSocketStream, ChatRequestError } from '../chatService'
import { DESKTOP_USER_ID } from '@/constants'

class MockRequestWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  url: string
  readyState = MockRequestWebSocket.CONNECTING
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = MockRequestWebSocket.CLOSED
  })
  onopen: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    socketInstances.push(this)
  }
}

describe('chatService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    approvalCallbacks.length = 0
    socketInstances.length = 0
    vi.stubGlobal('WebSocket', MockRequestWebSocket as unknown as typeof WebSocket)
  })

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

  it('requests thinking off for qwen thinking models via backend', async () => {
    await sendViaBackend('hi', 's1', { model: 'qwen3.5:9b', provider: 'Ollama (本地)' }, '', undefined)

    expect(sendChatViaBackend).toHaveBeenCalledWith('hi', expect.objectContaining({
      metadata: { thinking: 'off' },
      model: 'qwen3.5:9b',
      provider: 'Ollama (本地)',
    }))
  })

  // ─── sendViaWebSocket ───
  it('sends message with temperature/maxTokens via WebSocket', async () => {
    wsOnReply.mockImplementation((cb) => { cb({ content: 'done', type: 'reply' }); return () => {} })
    await sendViaWebSocket('hi', 's1', { model: 'glm-5', temperature: 0.5, maxTokens: 1024 }, 'coder', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
    })
    expect(wsSendMessage).toHaveBeenCalledWith('hi', 's1', 'glm-5', 'coder', undefined, undefined, 0.5, 1024, undefined, undefined)
  })

  it('passes metadata through to WebSocket sendMessage', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => { cb({ content: 'done', type: 'reply' }); return () => {} })
    await sendViaWebSocket('hi', 's1', { model: 'qwen3:8b' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
    }, { thinking: 'on' })
    expect(wsSendMessage).toHaveBeenCalledWith('hi', 's1', 'qwen3:8b', undefined, undefined, undefined, undefined, undefined, { thinking: 'on' }, undefined)
  })

  it('requests thinking off for qwen thinking models via WebSocket by default', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => { cb({ content: 'done', type: 'reply' }); return () => {} })
    await sendViaWebSocket('hi', 's1', { model: 'qwen3.5:9b' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
    })

    expect(wsSendMessage).toHaveBeenCalledWith('hi', 's1', 'qwen3.5:9b', undefined, undefined, undefined, undefined, undefined, { thinking: 'off' }, undefined)
  })

  it('does not override explicit thinking metadata for qwen models', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => { cb({ content: 'done', type: 'reply' }); return () => {} })
    await sendViaWebSocket('hi', 's1', { model: 'qwen3.5:9b' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
    }, { thinking: 'on' })

    expect(wsSendMessage).toHaveBeenCalledWith('hi', 's1', 'qwen3.5:9b', undefined, undefined, undefined, undefined, undefined, { thinking: 'on' }, undefined)
  })

  it('omits metadata when undefined', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => { cb({ content: 'done', type: 'reply' }); return () => {} })
    await sendViaWebSocket('hi', 's1', { model: 'glm-5' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
    })
    expect(wsSendMessage).toHaveBeenCalledWith('hi', 's1', 'glm-5', undefined, undefined, undefined, undefined, undefined, undefined, undefined)
  })

  it('keeps existing tool approval listeners while starting a chat request', async () => {
    hexclawWS.onApprovalRequest(vi.fn())
    expect(approvalCallbacks).toHaveLength(1)

    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => {
      cb({ content: 'done', type: 'reply' })
      return () => {}
    })

    await sendViaWebSocket('hi', 's1', { model: 'glm-5' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
    })

    expect(approvalCallbacks).toHaveLength(1)
  })

  it('openWebSocketStream opens a dedicated socket and sends the request payload on that socket', async () => {
    const handle = openWebSocketStream('hello', 's1', { model: 'glm-5', provider: '智谱' }, 'coder', undefined, undefined, { thinking: 'on' }, 'req-1')
    const socket = socketInstances[0]

    expect(socket).toBeDefined()
    expect(socket?.url).toContain('/ws')
    expect(wsSendMessage).not.toHaveBeenCalled()

    socket!.readyState = MockRequestWebSocket.OPEN
    socket!.onopen?.()

    expect(socket!.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'message',
      content: 'hello',
      request_id: 'req-1',
      session_id: 's1',
      user_id: DESKTOP_USER_ID,
      provider: '智谱',
      model: 'glm-5',
      role: 'coder',
      attachments: undefined,
      temperature: undefined,
      max_tokens: undefined,
      metadata: { thinking: 'on' },
    }))

    socket!.onmessage?.({
      data: JSON.stringify({ type: 'reply', content: 'done', metadata: { request_id: 'req-1' } }),
    })

    await expect(handle.done).resolves.toEqual({
      content: 'done',
      metadata: { request_id: 'req-1' },
      toolCalls: undefined,
      agentName: undefined,
    })
  })

  it('openWebSocketStream cancel sends cancel on the dedicated socket and resolves without fallback', async () => {
    const handle = openWebSocketStream('hello', 's1', { model: 'glm-5' }, '', undefined, undefined, undefined, 'req-2')
    const socket = socketInstances[0]

    socket!.readyState = MockRequestWebSocket.OPEN
    socket!.onopen?.()
    handle.cancel()

    expect(socket!.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'cancel', session_id: 's1', request_id: 'req-2' }))
    await expect(handle.done).resolves.toBeNull()
  })

  it('resumeWebSocketStream sends a resume payload and resolves from stream_snapshot', async () => {
    const handle = resumeWebSocketStream('s1', 'req-resume', {
      onSnapshot: vi.fn(),
    })
    const socket = socketInstances[0]

    socket!.readyState = MockRequestWebSocket.OPEN
    socket!.onopen?.()

    expect(socket!.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'resume',
      session_id: 's1',
      request_id: 'req-resume',
      user_id: DESKTOP_USER_ID,
    }))

    socket!.onmessage?.({
      data: JSON.stringify({
        type: 'stream_snapshot',
        content: 'resumed content',
        session_id: 's1',
        request_id: 'req-resume',
        done: true,
        metadata: { request_id: 'req-resume' },
      }),
    })

    await expect(handle.done).resolves.toEqual({
      content: 'resumed content',
      metadata: { request_id: 'req-resume' },
      toolCalls: undefined,
      agentName: undefined,
    })
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
