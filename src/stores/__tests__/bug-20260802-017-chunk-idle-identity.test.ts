import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { persistErrorReply } from '@/services/messageService'
import { createBoundChatStreamController } from '../chat-stream-bound-controller'
import { createChatSendDeliveryController } from '../chat-send-delivery-controller'
import { createChatStreamErrorController } from '../chat-stream-error'

const apiMocks = vi.hoisted(() => ({
  appendSessionMessage: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    appendSessionMessage: apiMocks.appendSessionMessage,
  }
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('BUG-20260802-017 chunk idle request identity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    apiMocks.appendSessionMessage.mockReset().mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps one request-owned assistant after a received chunk later becomes idle', async () => {
    const sessionId = 'session-chunk-idle'
    const requestId = 'request-chunk-idle'
    const idleFailure = deferred<never>()
    const activeStreams = ref<Record<string, any>>({})
    const appendedMessages: any[] = []
    let streamCallbacks:
      | {
          onChunk?: (content?: string, reasoning?: string) => void
        }
      | undefined

    class TestChatRequestError extends Error {
      noFallback: boolean

      constructor(message: string, noFallback = false) {
        super(message)
        this.noFallback = noFallback
      }
    }

    const openWebSocketStream = vi.fn((...args: any[]) => {
      streamCallbacks = args[5]
      return {
        cancel: vi.fn(),
        done: idleFailure.promise,
      }
    })
    const sendViaBackend = vi.fn()
    const errorController = createChatStreamErrorController({
      error: ref(null),
      currentSessionId: ref(sessionId),
      streamingSessionId: ref(sessionId),
      logger: { error: vi.fn() } as any,
      createId: () => 'unexpected-random-assistant-id',
      appendMessageToSession: (targetSessionId, message) => {
        expect(targetSessionId).toBe(sessionId)
        appendedMessages.push(message)
      },
      resetSessionStream: (targetSessionId) => {
        if (!targetSessionId) return
        const next = { ...activeStreams.value }
        delete next[targetSessionId]
        activeStreams.value = next
      },
      loadSessions: vi.fn().mockResolvedValue(undefined),
      persistErrorReply,
    })
    const boundController = createBoundChatStreamController({
      streamController: errorController as any,
      sending: ref(false),
      draftSending: ref(false),
    })
    const upsertStreamState = vi.fn((targetSessionId: string, nextState: any) => {
      const next = { ...activeStreams.value }
      if (nextState) next[targetSessionId] = nextState
      else delete next[targetSessionId]
      activeStreams.value = next
    })
    const updateStreamChunk = vi.fn((targetSessionId: string, content?: string) => {
      const current = activeStreams.value[targetSessionId]
      if (!current) return false
      upsertStreamState(targetSessionId, {
        ...current,
        rawContent: `${current.rawContent}${content ?? ''}`,
        content: `${current.content}${content ?? ''}`,
      })
      return false
    })
    const controller = createChatSendDeliveryController({
      chatParams: ref({ provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' }),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      activeStreams,
      chatSvc: {
        ChatRequestError: TestChatRequestError,
        ensureWebSocketConnected: vi.fn().mockResolvedValue(true),
        openWebSocketStream,
        sendViaBackend,
      } as any,
      getSettingsStore: (() => ({
        config: { memory: { enabled: true } },
        availableModels: [],
      })) as any,
      clearSessionCancelled: vi.fn(),
      isSessionCancelled: vi.fn().mockReturnValue(false),
      setSessionPending: vi.fn(),
      upsertStreamState,
      updateStreamChunk,
      resetSessionStream: vi.fn(),
      finalizeAssistantMessage: vi.fn() as any,
      handleSendError: boundController.handleSendError,
      storePendingApproval: vi.fn(),
      streamHandles: new Map(),
    })

    const delivery = controller.deliverMessage({
      backendText: 'stream until idle',
      sessionId,
      requestId,
      sending: ref(false),
      draftSending: ref(false),
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(openWebSocketStream).toHaveBeenCalledTimes(1)
    expect(streamCallbacks?.onChunk).toEqual(expect.any(Function))
    streamCallbacks!.onChunk?.('partial response')
    expect(updateStreamChunk).toHaveBeenCalledTimes(1)
    expect(activeStreams.value[sessionId]?.content).toBe('partial response')

    setTimeout(() => {
      idleFailure.reject(
        new TestChatRequestError('Assistant reply stalled — no new content received.'),
      )
    }, 60_000)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(appendedMessages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await expect(delivery).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(0)

    expect(openWebSocketStream).toHaveBeenCalledTimes(1)
    expect(sendViaBackend).not.toHaveBeenCalled()
    expect(appendedMessages).toHaveLength(1)
    expect(appendedMessages[0]).toMatchObject({
      id: `${requestId}:assistant`,
      role: 'assistant',
      content: 'WebSocket transport unavailable; retry will resume with the same request id',
      metadata: {
        request_id: requestId,
        is_error: true,
      },
    })
    expect(apiMocks.appendSessionMessage).toHaveBeenCalledTimes(1)
    expect(apiMocks.appendSessionMessage).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        id: `${requestId}:assistant`,
        request_id: requestId,
        metadata: expect.objectContaining({
          request_id: requestId,
          is_error: true,
        }),
      }),
    )
  })
})
