import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import * as chatService from '@/services/chatService'
import { createBoundChatStreamController } from '../chat-stream-bound-controller'
import { createChatSendWebSocketDeliveryController } from '../chat-send-websocket-delivery'
import { buildSessionStreamState, mergeStreamChunkState } from '../chat-stream-helpers'

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

type ReasoningReceipt = {
  version: 1
  reasoning_request: 'on' | 'off'
  reasoning_support: 'supported' | 'unsupported' | 'unknown'
  reasoning_execution: 'applied' | 'ignored' | 'rejected' | 'unknown'
}

const APPLIED_RECEIPT: ReasoningReceipt = {
  version: 1,
  reasoning_request: 'on',
  reasoning_support: 'supported',
  reasoning_execution: 'applied',
}

const UNKNOWN_RECEIPT: ReasoningReceipt = {
  version: 1,
  reasoning_request: 'on',
  reasoning_support: 'unknown',
  reasoning_execution: 'unknown',
}

class ReceiptFlowWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: ReceiptFlowWebSocket[] = []

  readyState = ReceiptFlowWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(_url: string) {
    void _url
    ReceiptFlowWebSocket.instances.push(this)
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    this.readyState = ReceiptFlowWebSocket.CLOSED
  }

  open() {
    this.readyState = ReceiptFlowWebSocket.OPEN
    this.onopen?.()
  }

  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
}

function wireReceiptFlow() {
  const sessionId = 'session-reasoning-receipt'
  const requestId = 'request-reasoning-receipt'
  const activeStreams = ref<Record<string, import('../chat-stream-helpers').SessionStreamState>>({})
  const streamHandles = new Map<string, import('@/services/chatService').WebSocketStreamHandle>()
  const updateStreamChunk = vi.fn<
    (
      targetSessionId: string,
      content?: string,
      reasoning?: string,
      runtimeFrame?: Record<string, unknown>,
    ) => boolean
  >(() => false)
  const boundController = createBoundChatStreamController({
    streamController: { updateStreamChunk } as never,
    sending: ref(false),
    draftSending: ref(false),
  })
  const upsertStreamState = (
    targetSessionId: string,
    nextState: import('../chat-stream-helpers').SessionStreamState | null,
  ) => {
    const next = { ...activeStreams.value }
    if (nextState) next[targetSessionId] = nextState
    else delete next[targetSessionId]
    activeStreams.value = next
  }
  const controller = createChatSendWebSocketDeliveryController({
    chatParams: ref({ provider: 'hexclaw-gpt', model: 'gpt-5.6-luna' }),
    agentRole: ref(''),
    activeStreams,
    chatSvc: chatService,
    isSessionCancelled: vi.fn().mockReturnValue(false),
    setSessionPending: vi.fn(),
    upsertStreamState,
    updateStreamChunk: boundController.updateStreamChunk,
    resetSessionStream: vi.fn(),
    finalizeAssistantMessage: vi.fn(
      (params) =>
        ({
          id: `${requestId}:assistant`,
          role: 'assistant',
          content: params.content,
          timestamp: '2026-08-20T00:00:00Z',
        }) as ChatMessage,
    ),
    handleSendError: vi.fn(),
    storePendingApproval: vi.fn(),
    streamHandles,
  })

  const delivery = controller.deliverViaWebSocket({
    backendText: 'reason about this',
    sessionId,
    requestId,
    requestMetadata: { thinking: 'on' },
    samplingSnapshot: {
      agentRole: '',
      chatParams: { provider: 'hexclaw-gpt', model: 'gpt-5.6-luna' },
      thinkingEnabled: true,
    },
    sending: ref(false),
    draftSending: ref(false),
  })
  const socket = ReceiptFlowWebSocket.instances[ReceiptFlowWebSocket.instances.length - 1]
  if (!socket) throw new Error('Expected request WebSocket to be created')
  socket.open()

  return { delivery, socket, updateStreamChunk }
}

function emitSequencedChunk(
  socket: ReceiptFlowWebSocket,
  reasoningReceipt: Record<string, unknown>,
) {
  socket.emit({
    type: 'chunk',
    content: 'answer',
    done: true,
    assistant_message_id: 'assistant-backend-1',
    message_id: 'assistant-backend-1',
    sequence: 1,
    reasoning_receipt: reasoningReceipt,
  })
}

describe('reasoning receipt stream flow', () => {
  beforeEach(() => {
    ReceiptFlowWebSocket.instances = []
    vi.stubGlobal('WebSocket', ReceiptFlowWebSocket as unknown as typeof WebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards a valid receipt unchanged from chatService through delivery and the bound controller', async () => {
    const flow = wireReceiptFlow()

    emitSequencedChunk(flow.socket, APPLIED_RECEIPT)
    await flow.delivery

    expect(flow.updateStreamChunk).toHaveBeenCalledTimes(1)
    expect(flow.updateStreamChunk).toHaveBeenCalledWith(
      'session-reasoning-receipt',
      'answer',
      undefined,
      expect.objectContaining({
        assistantMessageId: 'assistant-backend-1',
        sequence: 1,
        reasoningReceipt: APPLIED_RECEIPT,
      }),
    )
    expect(flow.updateStreamChunk.mock.calls[0]?.[3]?.reasoningReceipt).toEqual(APPLIED_RECEIPT)
  })

  it('normalizes a legacy frame without a receipt to unknown while preserving request intent', async () => {
    const flow = wireReceiptFlow()

    flow.socket.emit({
      type: 'chunk',
      content: 'legacy answer',
      done: true,
    })
    await flow.delivery

    expect(flow.updateStreamChunk).toHaveBeenCalledWith(
      'session-reasoning-receipt',
      'legacy answer',
      undefined,
      expect.objectContaining({
        sequence: 0,
        reasoningReceipt: UNKNOWN_RECEIPT,
      }),
    )
  })

  it('rejects the whole receipt when a client-added field violates the exact schema', async () => {
    const flow = wireReceiptFlow()

    emitSequencedChunk(flow.socket, {
      ...APPLIED_RECEIPT,
      debug_trace: 'must-not-cross-the-boundary',
    })
    await flow.delivery

    const runtimeFrame = flow.updateStreamChunk.mock.calls[0]?.[3]
    expect(runtimeFrame).toEqual(
      expect.objectContaining({
        reasoningReceipt: UNKNOWN_RECEIPT,
      }),
    )
    expect(runtimeFrame).not.toHaveProperty('reasoningReceipt.debug_trace')
    expect(JSON.stringify(runtimeFrame)).not.toContain('must-not-cross-the-boundary')
  })

  it('rejects the whole receipt when it rewrites the frozen request intent', async () => {
    const flow = wireReceiptFlow()

    emitSequencedChunk(flow.socket, {
      ...APPLIED_RECEIPT,
      reasoning_request: 'off',
    })
    await flow.delivery

    expect(flow.updateStreamChunk.mock.calls[0]?.[3]?.reasoningReceipt).toEqual(UNKNOWN_RECEIPT)
  })

  it('freezes applied timing on first visible content and ignores a late unknown regression', () => {
    const now = vi.spyOn(Date, 'now')
    let state = buildSessionStreamState({
      sessionId: 's1',
      requestId: 'r1',
      thinkingEnabled: true,
      reasoningSupport: 'supported',
    })

    now.mockReturnValue(1_000)
    state = mergeStreamChunkState(state, undefined, undefined, {
      sequence: 0,
      reasoning_receipt: APPLIED_RECEIPT,
    })
    expect(state.reasoningStartTime).toBe(1_000)

    now.mockReturnValue(2_000)
    state = mergeStreamChunkState(state, '  \n')
    expect(state.reasoningEndTime).toBe(0)

    now.mockReturnValue(4_000)
    state = mergeStreamChunkState(state, 'answer')
    expect(state.reasoningEndTime).toBe(4_000)

    now.mockReturnValue(5_000)
    state = mergeStreamChunkState(state, undefined, undefined, {
      sequence: 0,
      reasoning_receipt: {
        ...APPLIED_RECEIPT,
        reasoning_execution: 'unknown',
      },
    })
    expect(state.reasoningExecution).toBe('applied')
    expect(state.reasoningEndTime).toBe(4_000)
  })

  it('does not restart an active status when applied arrives after visible content', () => {
    const now = vi.spyOn(Date, 'now')
    let state = buildSessionStreamState({
      sessionId: 's1',
      requestId: 'r1',
      thinkingEnabled: true,
      reasoningSupport: 'unknown',
    })

    now.mockReturnValue(1_000)
    state = mergeStreamChunkState(state, 'answer')
    expect(state.reasoningStartTime).toBe(0)
    expect(state.reasoningEndTime).toBe(0)

    now.mockReturnValue(2_000)
    state = mergeStreamChunkState(state, undefined, undefined, {
      sequence: 0,
      reasoning_receipt: APPLIED_RECEIPT,
    })
    expect(state.reasoningExecution).toBe('applied')
    expect(state.reasoningStartTime).toBe(2_000)
    expect(state.reasoningEndTime).toBe(2_000)
  })

  it('accumulates only visible reasoning from the frozen provider and model', () => {
    const route = { provider: 'ollama-instance-a', model: 'qwen3.5:9b' }
    let state = buildSessionStreamState({
      sessionId: 's-public-reasoning',
      requestId: 'r-public-reasoning',
      thinkingEnabled: true,
      reasoningSupport: 'supported',
    })

    state = mergeStreamChunkState(state, undefined, '**公开', {
      assistant_message_id: 'assistant-public-reasoning',
      message_id: 'assistant-public-reasoning',
      sequence: 1,
      reasoning_disclosure: {
        visibility: 'visible',
        source: 'ollama.message.thinking',
        dialect: 'ollama_chat_think',
        provider: route.provider,
        model: route.model,
      },
      reasoning_receipt: APPLIED_RECEIPT,
    }, route)
    state = mergeStreamChunkState(state, undefined, '摘要**', {
      assistant_message_id: 'assistant-public-reasoning',
      message_id: 'assistant-public-reasoning',
      sequence: 2,
      reasoning_disclosure: {
        visibility: 'visible',
        source: 'ollama.message.thinking',
        dialect: 'ollama_chat_think',
        provider: route.provider,
        model: route.model,
      },
      reasoning_receipt: APPLIED_RECEIPT,
    }, route)

    expect(state.reasoning).toBe('**公开摘要**')
    expect(state.visibility).toBe('visible')

    state = mergeStreamChunkState(state, undefined, 'PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_RENDER', {
      assistant_message_id: 'assistant-public-reasoning',
      message_id: 'assistant-public-reasoning',
      sequence: 3,
      reasoning_disclosure: {
        visibility: 'visible',
        source: 'ollama.message.thinking',
        dialect: 'ollama_chat_think',
        provider: 'ollama-instance-b',
        model: route.model,
      },
      reasoning_receipt: APPLIED_RECEIPT,
    }, route)

    expect(state.reasoning).toBe('')
    expect(state.explicitReasoning).toBe('')
    expect(state.reasoningDisclosure).toBeUndefined()
    expect(state.visibility).toBe('not_exposed')
  })
})
