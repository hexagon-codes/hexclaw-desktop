import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createChatStreamStateController } from '../chat-stream-state'
import { buildSessionStreamState } from '../chat-stream-helpers'

describe('stream request route snapshot', () => {
  it('keeps the sent provider and model frozen while chunks are merged', () => {
    const mutableRoute = { provider: 'provider-at-send', model: 'model-at-send' }
    const state = buildSessionStreamState({
      sessionId: 'session-route-freeze',
      requestId: 'request-route-freeze',
      thinkingEnabled: true,
      reasoningSupport: 'supported',
      requestRoute: mutableRoute,
    })

    mutableRoute.provider = 'provider-after-send'
    mutableRoute.model = 'model-after-send'

    expect(state.requestRoute).toEqual({ provider: 'provider-at-send', model: 'model-at-send' })
    expect(Object.isFrozen(state.requestRoute)).toBe(true)

    const activeStreams = ref({ [state.sessionId]: state })
    const controller = createChatStreamStateController({
      activeStreams,
      pendingSessionIds: ref({}),
      currentSessionId: ref<string | null>(state.sessionId),
      messages: ref([]),
      streaming: ref(false),
      streamingSessionId: ref<string | null>(null),
      streamingContent: ref(''),
      streamingReasoning: ref(''),
      streamingReasoningStartTime: ref(0),
      streamingReasoningEndTime: ref(0),
      msgSvc: { persistMessage: vi.fn() } as never,
      streamHandles: new Map(),
    })

    controller.updateStreamChunk(state.sessionId, undefined, 'must-not-render', {
      assistantMessageId: 'assistant-route-freeze',
      sequence: 1,
      reasoningDisclosure: {
        visibility: 'visible',
        source: 'provider_adapter',
        dialect: 'reasoning_summary',
        provider: 'provider-after-send',
        model: 'model-after-send',
      },
      reasoningReceipt: {
        version: 1,
        reasoning_request: 'on',
        reasoning_support: 'supported',
        reasoning_execution: 'applied',
      },
    })

    expect(activeStreams.value[state.sessionId]?.reasoning).toBe('')
    expect(activeStreams.value[state.sessionId]?.visibility).toBe('not_exposed')
  })
})
