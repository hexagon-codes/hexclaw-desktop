import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listSessionMessages, sendChatViaBackend } = vi.hoisted(() => ({
  listSessionMessages: vi.fn(),
  sendChatViaBackend: vi.fn(),
}))

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    listSessionMessages,
    sendChatViaBackend,
  }
})

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    clearStreamCallbacks: vi.fn(),
    onChunk: vi.fn(),
    onReply: vi.fn(),
    onError: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(),
    connect: vi.fn(),
  },
}))

import { openWebSocketStream, sendViaBackend } from '@/services/chatService'
import { loadMessages, normalizeLoadedMessage, serializeMessageMetadata } from '@/services/messageService'
import {
  buildSessionStreamState,
  mergeStreamChunkState,
} from '@/stores/chat-stream-helpers'

class RuntimeWireWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: RuntimeWireWebSocket[] = []

  readyState = RuntimeWireWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(_url: string) {
    void _url
    RuntimeWireWebSocket.instances.push(this)
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    this.readyState = RuntimeWireWebSocket.CLOSED
  }

  open() {
    this.readyState = RuntimeWireWebSocket.OPEN
    this.onopen?.()
  }

  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
}

function fullFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'chunk',
    content: '',
    assistant_message_id: 'assistant-backend-1',
    message_id: 'assistant-backend-1',
    sequence: 1,
    reasoning_disclosure: {
      visibility: 'visible',
      source: 'provider_adapter',
      dialect: 'reasoning_summary',
      provider: 'openai',
      model: 'gpt-5.6-sol',
    },
    ...overrides,
  }
}

describe('CHAT-INV-THINKING-007 Desktop runtime wire', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    RuntimeWireWebSocket.instances = []
    vi.stubGlobal('WebSocket', RuntimeWireWebSocket as unknown as typeof WebSocket)
  })

  it('keeps legacy content frames compatible but fails raw reasoning closed', async () => {
    const onChunk = vi.fn()
    const handle = openWebSocketStream(
      'hello',
      's1',
      { provider: 'openai', model: 'gpt-5.6-sol' },
      '',
      undefined,
      { onChunk },
      undefined,
      'request-legacy',
    )
    const socket = RuntimeWireWebSocket.instances[0]!
    socket.open()
    socket.emit({
      type: 'chunk',
      content: 'legacy answer',
      reasoning: 'private chain of thought',
      done: true,
    })

    await expect(handle.done).resolves.toMatchObject({ content: 'legacy answer' })
    expect(onChunk).toHaveBeenCalledWith('legacy answer', undefined)
  })

  it('adopts the trusted backend identity and merges contiguous v1 events idempotently', async () => {
    const onChunk = vi.fn()
    const handle = openWebSocketStream(
      'hello',
      's1',
      { provider: 'openai', model: 'gpt-5.6-sol' },
      '',
      undefined,
      { onChunk } as any,
      undefined,
      'request-v1',
    )
    const socket = RuntimeWireWebSocket.instances[0]!
    socket.open()

    const started = fullFrame({
      content: 'A',
      reasoning: 'public summary',
      runtime_event: {
        version: 1,
        event_id: 'event-1',
        kind: 'tool_started',
        tool_call_id: 'call-1',
        tool_name: 'web_search',
      },
    })
    socket.emit(started)
    socket.emit(started)
    socket.emit(fullFrame({
      sequence: 3,
      done: true,
      runtime_event: {
        version: 1,
        event_id: 'event-3',
        kind: 'terminal',
        terminal_status: 'completed',
      },
    }))
    socket.emit(fullFrame({
      sequence: 2,
      content: 'B',
      runtime_event: {
        version: 1,
        event_id: 'event-2',
        kind: 'tool_completed',
        tool_call_id: 'call-1',
        tool_name: 'web_search',
      },
    }))
    socket.emit(fullFrame({
      sequence: 3,
      done: true,
      runtime_event: {
        version: 1,
        event_id: 'event-3',
        kind: 'terminal',
        terminal_status: 'completed',
      },
    }))

    const result = await handle.done
    expect(onChunk).toHaveBeenCalledTimes(3)
    expect(onChunk).toHaveBeenNthCalledWith(
      1,
      'A',
      'public summary',
      expect.objectContaining({
        assistantMessageId: 'assistant-backend-1',
        sequence: 1,
      }),
    )
    expect(result).toMatchObject({
      content: 'AB',
      metadata: {
        assistant_message_id: 'assistant-backend-1',
        message_id: 'assistant-backend-1',
        last_sequence: 3,
        reasoning_visibility: 'visible',
        reasoning_disclosure: {
          visibility: 'visible',
          provider: 'openai',
          model: 'gpt-5.6-sol',
        },
        runtime_events: [
          { sequence: 1, event_id: 'event-1', kind: 'tool_started' },
          { sequence: 2, event_id: 'event-2', kind: 'tool_completed' },
          { sequence: 3, event_id: 'event-3', kind: 'terminal' },
        ],
      },
    })
  })

  it('merges full typed frames through the WebSocket-only compatibility adapter', async () => {
    const pending = sendViaBackend(
      'hello',
      's1',
      { provider: 'openai', model: 'gpt-5.6-sol' },
      '',
      undefined,
      undefined,
      'request-sse',
    )
    const socket = RuntimeWireWebSocket.instances[0]!
    socket.open()
    socket.emit(fullFrame({
      content: 'WebSocket answer',
      reasoning: 'public WebSocket summary',
      runtime_event: {
        version: 1,
        event_id: 'ws-event-1',
        kind: 'tool_started',
        tool_call_id: 'ws-call-1',
        tool_name: 'web_search',
      },
    }))
    socket.emit(fullFrame({
      sequence: 2,
      done: true,
      runtime_event: {
        version: 1,
        event_id: 'ws-event-2',
        kind: 'terminal',
        terminal_status: 'completed',
      },
    }))

    const result = await pending

    expect(result.metadata).toMatchObject({
      assistant_message_id: 'assistant-backend-1',
      last_sequence: 2,
      reasoning_visibility: 'visible',
      runtime_events: [
        expect.objectContaining({ event_id: 'ws-event-1', sequence: 1 }),
        expect.objectContaining({ event_id: 'ws-event-2', sequence: 2 }),
      ],
    })
    expect(result.metadata).not.toHaveProperty('reasoning')
    expect(sendChatViaBackend).not.toHaveBeenCalled()
  })

  it('rejects mismatched aliases, route provenance, unknown kinds, and sensitive payloads', async () => {
    const state = buildSessionStreamState({
      sessionId: 's1',
      requestId: 'request-1',
      thinkingEnabled: true,
    })

    const accepted = mergeStreamChunkState(
      state,
      '',
      'must remain private',
      fullFrame({
        assistant_message_id: 'assistant-backend-1',
        message_id: 'different-id',
        runtime_event: {
          version: 1,
          event_id: 'event-sensitive',
          kind: 'tool_completed',
          tool_call_id: 'call-1',
          tool_name: 'web_search',
          result: 'private tool result',
        },
        reasoning_disclosure: {
          visibility: 'visible',
          source: 'provider_adapter',
          dialect: 'reasoning_summary',
          provider: 'different-provider',
          model: 'gpt-5.6-sol',
        },
      }) as any,
      { provider: 'openai', model: 'gpt-5.6-sol' },
    )

    expect(accepted.assistantMessageId).toBe('request-1:assistant')
    expect(accepted.lastSequence).toBe(0)
    expect(accepted.runtimeEvents).toEqual([])
    expect(accepted.visibility).toBe('not_exposed')
    expect(accepted.reasoning).toBe('')
  })

  it('persists and restores only normalized snapshots and defaults legacy history', async () => {
    const serialized = serializeMessageMetadata({
      id: 'assistant-backend-1',
      role: 'assistant',
      content: 'answer',
      timestamp: '2026-07-29T00:00:00Z',
      reasoning: 'must not serialize',
      metadata: {
        reasoning: 'private metadata reasoning',
        reasoning_visibility: 'not_exposed',
        assistant_message_id: 'assistant-backend-1',
        last_sequence: 2,
        runtime_events: [
          {
            version: 1,
            sequence: 1,
            event_id: 'safe',
            kind: 'tool_started',
            tool_call_id: 'call-1',
            tool_name: 'web_search',
          },
          {
            version: 1,
            sequence: 2,
            event_id: 'unsafe',
            kind: 'tool_completed',
            tool_call_id: 'call-1',
            tool_name: 'web_search',
            result: 'secret',
          } as any,
        ],
      },
    })

    expect(serialized).toMatchObject({
      assistant_message_id: 'assistant-backend-1',
      last_sequence: 2,
      runtime_events: [
        expect.objectContaining({ event_id: 'safe', sequence: 1 }),
      ],
      reasoning_visibility: 'not_exposed',
    })
    expect(serialized).not.toHaveProperty('reasoning')

    const legacy = normalizeLoadedMessage({
      id: 'legacy-id',
      role: 'assistant',
      content: 'answer',
      timestamp: '2026-07-29T00:00:00Z',
      metadata: null,
    })
    expect(legacy.metadata).toMatchObject({
      assistant_message_id: 'legacy-id',
      runtime_events: [],
      last_sequence: 0,
      reasoning_visibility: 'not_exposed',
    })

    listSessionMessages.mockResolvedValueOnce({
      messages: [{
        id: 'assistant-backend-1',
        role: 'assistant',
        content: 'answer',
        timestamp: '2026-07-29T00:00:00Z',
        metadata: serialized,
      }],
      total: 1,
    })
    const [reloaded] = await loadMessages('s1')
    expect(reloaded?.id).toBe('assistant-backend-1')
    expect(reloaded?.metadata).toMatchObject({
      assistant_message_id: 'assistant-backend-1',
      runtime_events: [
        expect.objectContaining({ event_id: 'safe', sequence: 1 }),
      ],
      last_sequence: 2,
      reasoning_visibility: 'not_exposed',
    })
    expect(reloaded?.reasoning).toBeUndefined()
  })
})
