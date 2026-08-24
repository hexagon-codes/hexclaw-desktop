import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ApiError, ChatMessage } from '@/types'
import { createChatSendController } from '../chat-send-controller'
import { createChatStreamErrorController } from '../chat-stream-error'

function createExceptionHarness(overrides?: {
  backendText?: () => Promise<string | undefined>
  openWebSocketStream?: () => never
}) {
  const sessionId = 'session-claim'
  const requestId = 'request-claim'
  const currentSessionId = ref<string | null>(sessionId)
  const messages = ref<ChatMessage[]>([])
  const pendingSessionIds = ref<Record<string, boolean>>({})
  const draftSending = ref(false)
  const activeStreams = ref<Record<string, any>>({})
  const sending = ref(false)
  const error = ref<ApiError | null>(null)
  const terminalMessages: ChatMessage[] = []
  const persistErrorReply = vi.fn().mockResolvedValue(undefined)
  const loadSessions = vi.fn().mockResolvedValue(undefined)
  const streamHandles = new Map()

  const refreshSendingState = vi.fn(() => {
    sending.value = draftSending.value || Object.values(pendingSessionIds.value).some(Boolean)
  })
  const setSessionPending = vi.fn((targetSessionId: string, value: boolean) => {
    const next = { ...pendingSessionIds.value }
    if (value) next[targetSessionId] = true
    else delete next[targetSessionId]
    pendingSessionIds.value = next
    refreshSendingState()
  })
  const upsertStreamState = vi.fn((targetSessionId: string, nextState: any) => {
    const next = { ...activeStreams.value }
    if (nextState) next[targetSessionId] = nextState
    else delete next[targetSessionId]
    activeStreams.value = next
  })
  const resetSessionStream = vi.fn((targetSessionId?: string | null) => {
    if (!targetSessionId) return
    streamHandles.delete(targetSessionId)
    setSessionPending(targetSessionId, false)
    upsertStreamState(targetSessionId, null)
  })
  const errorController = createChatStreamErrorController({
    error,
    currentSessionId,
    streamingSessionId: ref(null),
    logger: { error: vi.fn() } as any,
    createId: () => 'unexpected-random-assistant-id',
    appendMessageToSession: (targetSessionId, message) => {
      expect(targetSessionId).toBe(sessionId)
      terminalMessages.push(message)
    },
    resetSessionStream,
    loadSessions,
    persistErrorReply,
  })
  const handleSendError = vi.fn((errorValue, targetSessionId, streamState) => {
    errorController.handleSendError(errorValue, targetSessionId, sending, draftSending, streamState)
  })
  const openWebSocketStream = vi.fn(
    overrides?.openWebSocketStream ??
      (() => {
        throw new Error('synchronous websocket construction failed')
      }),
  )

  const controller = createChatSendController({
    currentSessionId,
    messages,
    pendingSessionIds,
    draftSending,
    activeStreams,
    chatParams: ref({ provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' }),
    agentRole: ref(''),
    thinkingEnabled: ref(false),
    hasCustomTitle: ref(true),
    sessions: ref([]),
    msgSvc: { updateSessionTitle: vi.fn().mockResolvedValue(undefined) } as any,
    chatSvc: {
      ChatRequestError: class TestChatRequestError extends Error {},
      ensureWebSocketConnected: vi.fn().mockResolvedValue(true),
      openWebSocketStream,
    } as any,
    createId: () => requestId,
    getSettingsStore: (() => ({
      config: { memory: { enabled: true } },
      availableModels: [],
    })) as any,
    ensureSession: vi.fn().mockResolvedValue(sessionId),
    clearSessionCancelled: vi.fn(),
    isSessionCancelled: vi.fn().mockReturnValue(false),
    isSessionStreaming: (targetSessionId) => !!activeStreams.value[targetSessionId],
    isSessionExecuting: vi.fn().mockReturnValue(false),
    setSessionPending,
    refreshSendingState,
    setLocalSessionTitle: vi.fn(),
    setPendingSuggestedTitleExpectation: vi.fn(),
    pendingAutoTitleSync: new Map(),
    persistMessage: vi.fn().mockResolvedValue(true),
    upsertStreamState,
    updateStreamChunk: vi.fn().mockReturnValue(false),
    resetSessionStream,
    finalizeAssistantMessage: vi.fn() as any,
    handleSendError,
    storePendingApproval: vi.fn(),
    streamHandles,
    sending,
  })

  return {
    activeStreams,
    backendText: overrides?.backendText,
    controller,
    draftSending,
    handleSendError,
    messages,
    openWebSocketStream,
    pendingSessionIds,
    persistErrorReply,
    requestId,
    sending,
    sessionId,
    terminalMessages,
  }
}

function expectClaimReleased(harness: ReturnType<typeof createExceptionHarness>) {
  expect(harness.handleSendError).toHaveBeenCalledTimes(1)
  expect(harness.handleSendError).toHaveBeenCalledWith(
    expect.any(Error),
    harness.sessionId,
    expect.objectContaining({
      sessionId: harness.sessionId,
      requestId: harness.requestId,
      assistantMessageId: `${harness.requestId}:assistant`,
    }),
  )
  expect(harness.terminalMessages).toHaveLength(1)
  expect(harness.terminalMessages[0]).toMatchObject({
    id: `${harness.requestId}:assistant`,
    role: 'assistant',
    metadata: {
      is_error: true,
      request_id: harness.requestId,
    },
  })
  expect(harness.persistErrorReply).toHaveBeenCalledTimes(1)
  expect(harness.activeStreams.value).toEqual({})
  expect(harness.pendingSessionIds.value).toEqual({})
  expect(harness.draftSending.value).toBe(false)
  expect(harness.sending.value).toBe(false)
  expect(harness.messages.value).toHaveLength(1)
  expect(harness.messages.value[0]).toMatchObject({
    id: harness.requestId,
    role: 'user',
  })
}

describe('BUG-CHAT-SEND-CLAIM-EXCEPTION-LEAK-20260824', () => {
  it('terminates the claimed identity when backendText rejects', async () => {
    const harness = createExceptionHarness({
      backendText: vi.fn().mockRejectedValue(new Error('backend text failed')),
    })

    await expect(
      harness.controller.sendMessage('hello', undefined, {
        backendText: harness.backendText,
      }),
    ).resolves.toBeNull()

    expect(harness.openWebSocketStream).not.toHaveBeenCalled()
    expectClaimReleased(harness)
  })

  it('terminates the claimed identity when openWebSocketStream throws synchronously', async () => {
    const harness = createExceptionHarness()

    await expect(harness.controller.sendMessage('hello')).resolves.toBeNull()

    expect(harness.openWebSocketStream).toHaveBeenCalledTimes(1)
    expectClaimReleased(harness)
  })
})
