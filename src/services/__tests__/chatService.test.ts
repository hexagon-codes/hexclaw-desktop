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
  MockRequestWebSocket,
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
  ...(() => {
    const socketInstances: Array<{
      url: string
      readyState: number
      send: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      onopen: ((event?: unknown) => void) | null
      onmessage: ((event: { data: string }) => void) | null
      onerror: ((event?: unknown) => void) | null
      onclose: ((event?: unknown) => void) | null
    }> = []
    class MockRequestWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
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
    return { socketInstances, MockRequestWebSocket }
  })(),
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    isConnected: wsIsConnected,
    connect: wsConnect,
    clearCallbacks: wsClearCallbacks,
    clearStreamCallbacks: vi.fn(),
    onChunk: wsOnChunk,
    onReply: wsOnReply,
    onError: wsOnError,
    onApprovalRequest: wsOnApprovalRequest,
    sendMessage: wsSendMessage,
  },
}))
vi.mock('@/api/chat', () => ({ sendChatViaBackend }))
vi.mock('@/api/native-sidecar-websocket', () => ({ NativeSidecarWebSocket: MockRequestWebSocket }))

import { hexclawWS } from '@/api/websocket'
import {
  ensureWebSocketConnected,
  sendViaBackend,
  sendViaWebSocket,
  openWebSocketStream,
  resumeWebSocketStream,
  ChatRequestError,
} from '../chatService'
import { DESKTOP_USER_ID } from '@/constants'

describe('chatService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    approvalCallbacks.length = 0
    socketInstances.length = 0
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
    const pending = sendViaBackend(
      'hello',
      's1',
      { model: 'glm-5', provider: '智谱', temperature: 0.8, maxTokens: 2048 },
      '',
      undefined,
    )
    const socket = socketInstances[0]!
    socket.readyState = MockRequestWebSocket.OPEN
    socket.onopen?.()
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({
      temperature: 0.8,
      max_tokens: 2048,
      model: 'glm-5',
      provider: '智谱',
    })
    socket.onmessage?.({ data: JSON.stringify({ type: 'reply', content: 'ok' }) })
    await expect(pending).resolves.toMatchObject({ reply: 'ok', session_id: 's1' })
    expect(sendChatViaBackend).not.toHaveBeenCalled()
  })

  it('passes undefined temperature when not set', async () => {
    const pending = sendViaBackend('hi', 's1', { model: 'gpt-4' }, '', undefined)
    const socket = socketInstances[0]!
    socket.readyState = MockRequestWebSocket.OPEN
    socket.onopen?.()
    const payload = JSON.parse(socket.send.mock.calls[0]![0])
    expect(payload).not.toHaveProperty('temperature')
    expect(payload).not.toHaveProperty('max_tokens')
    socket.onmessage?.({ data: JSON.stringify({ type: 'reply', content: 'ok' }) })
    await pending
  })

  it('requests thinking off for qwen thinking models via backend', async () => {
    const pending = sendViaBackend(
      'hi',
      's1',
      { model: 'qwen3.5:9b', provider: 'Ollama (本地)' },
      '',
      undefined,
    )
    const socket = socketInstances[0]!
    socket.readyState = MockRequestWebSocket.OPEN
    socket.onopen?.()
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({
      metadata: { thinking: 'off' },
      model: 'qwen3.5:9b',
      provider: 'Ollama (本地)',
    })
    socket.onmessage?.({ data: JSON.stringify({ type: 'reply', content: 'ok' }) })
    await pending
  })

  // ─── sendViaWebSocket ───
  it('sends message with temperature/maxTokens via WebSocket', async () => {
    wsOnReply.mockImplementation((cb) => {
      cb({ content: 'done', type: 'reply' })
      return () => {}
    })
    await sendViaWebSocket(
      'hi',
      's1',
      { model: 'glm-5', temperature: 0.5, maxTokens: 1024 },
      'coder',
      undefined,
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
      },
    )
    expect(wsSendMessage).toHaveBeenCalledWith(
      'hi',
      's1',
      'glm-5',
      'coder',
      undefined,
      undefined,
      0.5,
      1024,
      undefined,
      undefined,
    )
  })

  it('passes metadata through to WebSocket sendMessage', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => {
      cb({ content: 'done', type: 'reply' })
      return () => {}
    })
    await sendViaWebSocket(
      'hi',
      's1',
      { model: 'qwen3:8b' },
      '',
      undefined,
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
      },
      { thinking: 'on' },
    )
    expect(wsSendMessage).toHaveBeenCalledWith(
      'hi',
      's1',
      'qwen3:8b',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { thinking: 'on' },
      undefined,
    )
  })

  it('requests thinking off for qwen thinking models via WebSocket by default', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => {
      cb({ content: 'done', type: 'reply' })
      return () => {}
    })
    await sendViaWebSocket('hi', 's1', { model: 'qwen3.5:9b' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
    })

    expect(wsSendMessage).toHaveBeenCalledWith(
      'hi',
      's1',
      'qwen3.5:9b',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { thinking: 'off' },
      undefined,
    )
  })

  it('does not override explicit thinking metadata for qwen models', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => {
      cb({ content: 'done', type: 'reply' })
      return () => {}
    })
    await sendViaWebSocket(
      'hi',
      's1',
      { model: 'qwen3.5:9b' },
      '',
      undefined,
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
      },
      { thinking: 'on' },
    )

    expect(wsSendMessage).toHaveBeenCalledWith(
      'hi',
      's1',
      'qwen3.5:9b',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { thinking: 'on' },
      undefined,
    )
  })

  it('omits metadata when undefined', async () => {
    wsOnReply.mockImplementation((cb: (msg: { content: string; type: string }) => void) => {
      cb({ content: 'done', type: 'reply' })
      return () => {}
    })
    await sendViaWebSocket('hi', 's1', { model: 'glm-5' }, '', undefined, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
    })
    expect(wsSendMessage).toHaveBeenCalledWith(
      'hi',
      's1',
      'glm-5',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )
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
    const handle = openWebSocketStream(
      'hello',
      's1',
      { model: 'glm-5', provider: '智谱' },
      'coder',
      undefined,
      undefined,
      { thinking: 'on' },
      'req-1',
    )
    const socket = socketInstances[0]

    expect(socket).toBeDefined()
    expect(socket?.url).toContain('/ws')
    expect(wsSendMessage).not.toHaveBeenCalled()

    socket!.readyState = MockRequestWebSocket.OPEN
    socket!.onopen?.()

    expect(socket!.send).toHaveBeenCalledWith(
      JSON.stringify({
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
      }),
    )

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

  it('openWebSocketStream preserves accumulated text when the done chunk only carries tool blocks', async () => {
    const onChunk = vi.fn()
    const handle = openWebSocketStream(
      'hello',
      's1',
      { model: 'glm-5' },
      '',
      undefined,
      { onChunk },
      undefined,
      'req-tool',
    )
    const socket = socketInstances[0]

    socket!.readyState = MockRequestWebSocket.OPEN
    socket!.onopen?.()

    socket!.onmessage?.({
      data: JSON.stringify({ type: 'chunk', content: '先查连接器。', done: false }),
    })
    socket!.onmessage?.({
      data: JSON.stringify({ type: 'chunk', content: '最终结论不会消失。', done: false }),
    })
    socket!.onmessage?.({
      data: JSON.stringify({
        type: 'chunk',
        content: '',
        done: true,
        metadata: { request_id: 'req-tool' },
        blocks: [
          { type: 'tool_use', id: 'tool-1', name: 'app_query', input: {} },
          {
            type: 'tool_result',
            toolUseId: 'tool-1',
            toolName: 'app_query',
            output: '<app-data>...</app-data>',
            isError: false,
          },
        ],
      }),
    })

    await expect(handle.done).resolves.toEqual({
      content: '先查连接器。最终结论不会消失。',
      metadata: { request_id: 'req-tool' },
      toolCalls: undefined,
      blocks: [
        { type: 'tool_use', id: 'tool-1', name: 'app_query', input: {} },
        {
          type: 'tool_result',
          toolUseId: 'tool-1',
          toolName: 'app_query',
          output: '<app-data>...</app-data>',
          isError: false,
        },
      ],
      agentName: undefined,
    })
    expect(onChunk).toHaveBeenCalledWith('', undefined)
  })

  it('keeps the request socket alive past 120s for slow real-model first responses', async () => {
    vi.useFakeTimers()
    try {
      const handle = openWebSocketStream(
        'slow tool request',
        's1',
        { model: 'Qwen/Qwen3.6-35B-A3B' },
        '',
        undefined,
        undefined,
        undefined,
        'req-slow',
      )
      const done = handle.done.catch((err: unknown) => err)
      const socket = socketInstances[0]

      socket!.readyState = MockRequestWebSocket.OPEN
      socket!.onopen?.()

      await vi.advanceTimersByTimeAsync(120_000)
      expect(socket!.close).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(179_999)
      expect(socket!.close).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(socket!.close).toHaveBeenCalled()
      await expect(done).resolves.toMatchObject({
        message: 'Assistant reply timed out — no response received.',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('openWebSocketStream cancel sends cancel on the dedicated socket and resolves without fallback', async () => {
    const handle = openWebSocketStream(
      'hello',
      's1',
      { model: 'glm-5' },
      '',
      undefined,
      undefined,
      undefined,
      'req-2',
    )
    const socket = socketInstances[0]

    socket!.readyState = MockRequestWebSocket.OPEN
    socket!.onopen?.()
    handle.cancel()

    expect(socket!.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'cancel', session_id: 's1', request_id: 'req-2' }),
    )
    await expect(handle.done).resolves.toBeNull()
  })

  it('resumeWebSocketStream sends a resume payload and resolves from stream_snapshot', async () => {
    const handle = resumeWebSocketStream('s1', 'req-resume', {
      onSnapshot: vi.fn(),
    })
    const socket = socketInstances[0]

    socket!.readyState = MockRequestWebSocket.OPEN
    socket!.onopen?.()

    expect(socket!.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'resume',
        session_id: 's1',
        request_id: 'req-resume',
        user_id: DESKTOP_USER_ID,
      }),
    )

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

  it('hydrates a resumed sequence snapshot atomically and accepts the next frame', async () => {
    const onSnapshot = vi.fn()
    const onChunk = vi.fn()
    const handle = resumeWebSocketStream('s1', 'req-gap', { onSnapshot, onChunk })
    const socket = socketInstances[0]

    socket!.readyState = MockRequestWebSocket.OPEN
    socket!.onopen?.()

    try {
      socket!.onmessage?.({
        data: JSON.stringify({
          type: 'stream_snapshot',
          content: 'already resumed',
          session_id: 's1',
          request_id: 'req-gap',
          done: false,
          assistant_message_id: 'assistant-backend-gap',
          message_id: 'assistant-backend-gap',
          last_sequence: 3,
          runtime_events: [
            {
              version: 1,
              sequence: 1,
              event_id: 'event-1',
              kind: 'tool_started',
              tool_call_id: 'call-1',
              tool_name: 'web_search',
            },
            {
              version: 1,
              sequence: 2,
              event_id: 'event-2',
              kind: 'tool_completed',
              tool_call_id: 'call-1',
              tool_name: 'web_search',
            },
            {
              version: 1,
              sequence: 3,
              event_id: 'event-3',
              kind: 'terminal',
              terminal_status: 'completed',
            },
          ],
          reasoning_disclosure: {
            visibility: 'visible',
            source: 'provider_adapter',
            dialect: 'reasoning_summary',
            provider: 'openai',
            model: 'gpt-5.6-sol',
          },
        }),
      })

      expect(onSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'already resumed',
          metadata: expect.objectContaining({
            assistant_message_id: 'assistant-backend-gap',
            last_sequence: 3,
            runtime_events: [
              expect.objectContaining({ event_id: 'event-1', sequence: 1 }),
              expect.objectContaining({ event_id: 'event-2', sequence: 2 }),
              expect.objectContaining({ event_id: 'event-3', sequence: 3 }),
            ],
          }),
        }),
      )

      socket!.onmessage?.({
        data: JSON.stringify({
          type: 'chunk',
          content: ' next',
          session_id: 's1',
          request_id: 'req-gap',
          assistant_message_id: 'assistant-backend-gap',
          message_id: 'assistant-backend-gap',
          sequence: 4,
          reasoning_disclosure: {
            visibility: 'not_exposed',
            source: 'provider_adapter',
            dialect: 'reasoning_summary',
            provider: 'openai',
            model: 'gpt-5.6-sol',
          },
        }),
      })

      expect(onChunk).toHaveBeenCalledWith(
        ' next',
        undefined,
        expect.objectContaining({ sequence: 4 }),
      )
    } finally {
      handle.cancel()
      await handle.done
    }
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
