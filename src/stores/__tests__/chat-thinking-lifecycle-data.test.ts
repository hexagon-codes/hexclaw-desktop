import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import type { SessionStreamState } from '../chat-stream-helpers'

const { appendSessionMessage, listSessionMessages } = vi.hoisted(() => ({
  appendSessionMessage: vi.fn(),
  listSessionMessages: vi.fn(),
}))

vi.mock('@/api/chat', () => ({
  listSessions: vi.fn(),
  listSessionMessages,
  createSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  suggestSessionTitle: vi.fn(),
  deleteSession: vi.fn(),
  deleteMessage: vi.fn(),
  appendSessionMessage,
}))

import { loadMessages, persistCancelledReply } from '@/services/messageService'
import { createChatStreamCancelController } from '../chat-stream-cancel'
import { createChatStreamCompletionController } from '../chat-stream-completion'
import { createChatStreamErrorController } from '../chat-stream-error'
import {
  buildRecoveredStreamState,
  buildStreamingMirrorState,
  getStreamThinkingDuration,
  mergeStreamChunkState,
} from '../chat-stream-helpers'

function streamState(overrides: Partial<SessionStreamState> = {}): SessionStreamState {
  return {
    sessionId: 's1',
    requestId: 'request-1',
    assistantMessageId: 'assistant-live-1',
    rawContent: '',
    content: 'answer',
    explicitReasoning: '',
    reasoning: 'public summary',
    reasoningStartTime: 1_000,
    reasoningEndTime: 4_000,
    thinkingEnabled: true,
    state: 'running',
    visibility: 'visible',
    reasoningDisclosure: {
      visibility: 'visible',
      source: 'provider_adapter',
      dialect: 'reasoning_summary',
      provider: 'openai',
      model: 'gpt-5.6-sol',
    },
    assistantMessageAliases: [],
    lastSequence: 0,
    runtimeEvents: [],
    acceptedRuntimeFrames: {},
    ...overrides,
  }
}

function completionController(
  state: SessionStreamState,
  appendMessageToSession: (sessionId: string, message: ChatMessage) => void,
) {
  return createChatStreamCompletionController({
    activeStreams: ref({ s1: state }),
    pendingSuggestedTitleExpectation: ref({}),
    pendingAutoTitleSync: new Map(),
    currentSessionId: ref('s1'),
    msgSvc: {
      touchSession: vi.fn().mockResolvedValue(undefined),
      suggestSessionTitle: vi.fn(),
    } as any,
    createId: () => 'unexpected-new-id',
    loadSessions: vi.fn().mockResolvedValue(undefined),
    setLocalSessionTitle: vi.fn(),
    setPendingSuggestedTitleExpectation: vi.fn(),
    bumpLocalSession: vi.fn(),
    extractArtifacts: vi.fn(),
    appendMessageToSession,
    resetSessionStream: vi.fn(),
  })
}

describe('CHAT-DEEP-THINK-PROGRESS-001 lifecycle data contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('restores completed history with numeric duration and explicit reasoning visibility', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [{
        id: 'assistant-history-1',
        role: 'assistant',
        content: 'answer',
        timestamp: '2026-07-29T00:00:00Z',
        metadata: {
          reasoning: 'public summary',
          thinking_duration: '7',
          reasoning_visibility: 'not_exposed',
        },
      }],
      total: 1,
    })

    const [message] = await loadMessages('s1')

    expect(message?.id).toBe('assistant-history-1')
    expect(message?.metadata).toMatchObject({
      thinking_state: 'completed',
      thinking_duration: 7,
      reasoning_visibility: 'not_exposed',
    })
  })

  it('infers failed history only from durable error plus thinking evidence', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'assistant-history-failed',
          role: 'assistant',
          content: 'provider failed',
          timestamp: '2026-07-29T00:00:00Z',
          metadata: { is_error: true, thinking_duration: 2 },
        },
        {
          id: 'assistant-history-plain',
          role: 'assistant',
          content: 'plain answer',
          timestamp: '2026-07-29T00:00:01Z',
          metadata: {},
        },
      ],
      total: 2,
    })

    const messages = await loadMessages('s1')

    expect(messages[0]?.metadata).toMatchObject({
      thinking_state: 'failed',
      thinking_duration: 2,
      reasoning_visibility: 'not_exposed',
    })
    expect(messages[1]?.metadata?.thinking_state).toBeUndefined()
  })

  it('completes with the live assistant identity and freezes lifecycle metadata', () => {
    const appendMessageToSession = vi.fn()
    const controller = completionController(streamState(), appendMessageToSession)

    const message = controller.finalizeAssistantMessage({
      content: 'answer',
      sessionId: 's1',
      reasoning: 'public summary',
    })

    expect(message.id).toBe('assistant-live-1')
    expect(message.metadata).toMatchObject({
      thinking_state: 'completed',
      thinking_duration: 3,
      reasoning_visibility: 'visible',
    })
  })

  it('adopts a trusted backend terminal snapshot while retaining the live alias', () => {
    const appendMessageToSession = vi.fn()
    const controller = completionController(
      streamState({
        assistantMessageId: 'assistant-local-1',
        assistantMessageAliases: [],
        lastSequence: 0,
        runtimeEvents: [],
        reasoningDisclosure: undefined,
        visibility: 'not_exposed',
        reasoning: '',
      }),
      appendMessageToSession,
    )

    const message = controller.finalizeAssistantMessage({
      content: 'answer',
      sessionId: 's1',
      reasoning: 'public summary',
      metadata: {
        assistant_message_id: 'assistant-backend-1',
        message_id: 'assistant-backend-1',
        last_sequence: 2,
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
      },
    })

    expect(message.id).toBe('assistant-local-1')
    expect(message.reasoning).toBe('public summary')
    expect(message.metadata).toMatchObject({
      assistant_message_id: 'assistant-backend-1',
      assistant_message_aliases: ['assistant-local-1'],
      backend_message_id: 'assistant-backend-1',
      last_sequence: 2,
      reasoning_visibility: 'visible',
      runtime_events: [
        expect.objectContaining({ event_id: 'event-1', sequence: 1 }),
        expect.objectContaining({ event_id: 'event-2', sequence: 2 }),
      ],
    })
  })

  it('hydrates a fresh recovered snapshot without changing the deterministic UI identity', () => {
    const state = buildRecoveredStreamState('s1', {
      session_id: 's1',
      request_id: 'request-recovered',
      content: 'partial answer',
      reasoning: 'public summary',
      done: false,
      status: 'streaming',
      started_at: '2026-07-29T01:02:03.000Z',
      assistant_message_id: 'assistant-backend-recovered',
      message_id: 'assistant-backend-recovered',
      last_sequence: 2,
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
      ],
      reasoning_disclosure: {
        visibility: 'visible',
        source: 'provider_adapter',
        dialect: 'reasoning_summary',
        provider: 'openai',
        model: 'gpt-5.6-sol',
      },
      metadata: {
        thinking_enabled: 'true',
        thinking_state: 'running',
        reasoning_visibility: 'visible',
        agent_display_name: '小明的辅导老师',
        recipient_display_name: '小明',
      },
    })

    expect(state).toMatchObject({
      assistantMessageId: 'request-recovered:assistant',
      canonicalAssistantMessageId: 'assistant-backend-recovered',
      assistantMessageAliases: ['assistant-backend-recovered'],
      lastSequence: 2,
      thinkingEnabled: true,
      startedAt: Date.parse('2026-07-29T01:02:03.000Z'),
      state: 'running',
      visibility: 'visible',
      agentDisplayName: '小明的辅导老师',
      recipientDisplayName: '小明',
      reasoning: 'public summary',
    })
    expect(state.runtimeEvents).toHaveLength(2)
  })

  it('stores a runtime canonical ID as an alias without replacing the live UI key', () => {
    const current = streamState({
      assistantMessageId: 'assistant-local-1',
      assistantMessageAliases: [],
      lastSequence: 0,
      runtimeEvents: [],
      acceptedRuntimeFrames: {},
      reasoningDisclosure: undefined,
      visibility: 'not_exposed',
    })

    const merged = mergeStreamChunkState(current, 'A', undefined, {
      assistantMessageId: 'assistant-backend-1',
      messageId: 'assistant-backend-1',
      sequence: 1,
      reasoningDisclosure: { visibility: 'not_exposed' },
    })

    expect(merged.assistantMessageId).toBe('assistant-local-1')
    expect(merged.canonicalAssistantMessageId).toBe('assistant-backend-1')
    expect(merged.assistantMessageAliases).toEqual(['assistant-backend-1'])
    expect(merged.lastSequence).toBe(1)
  })

  it('measures thinking from the request-owned start even when no reasoning is exposed', () => {
    const state = streamState({
      reasoning: '',
      reasoningStartTime: 0,
      reasoningEndTime: 0,
      thinkingEnabled: true,
      startedAt: 1_000,
      state: 'running',
      visibility: 'not_exposed',
    } as Partial<SessionStreamState>)

    expect(getStreamThinkingDuration(state, 4_000)).toBe(3)
  })

  it('drives the live elapsed timer from request start without waiting for reasoning', () => {
    const state = streamState({
      reasoning: '',
      reasoningStartTime: 0,
      reasoningEndTime: 0,
      thinkingEnabled: true,
      startedAt: 1_000,
      state: 'running',
      visibility: 'not_exposed',
    } as Partial<SessionStreamState>)

    const mirror = buildStreamingMirrorState({ s1: state }, 's1')
    expect(mirror.streamingReasoningStartTime).toBe(1_000)
  })

  it('classifies a thinking request with zero deliverable output as failed without inventing reasoning', () => {
    const appendMessageToSession = vi.fn()
    const controller = completionController(
      streamState({
        content: '',
        reasoning: '',
        reasoningStartTime: 0,
        reasoningEndTime: 0,
        thinkingEnabled: true,
        startedAt: Date.now() - 3_000,
        state: 'running',
        visibility: 'not_exposed',
      } as Partial<SessionStreamState>),
      appendMessageToSession,
    )

    const message = controller.finalizeAssistantMessage({
      content: '',
      sessionId: 's1',
      reasoning: '',
    })

    expect(message.id).toBe('assistant-live-1')
    expect(message.content).toBe('')
    expect(message.reasoning).toBeUndefined()
    expect(message.metadata).toMatchObject({
      thinking_state: 'failed',
      reasoning_visibility: 'not_exposed',
    })
  })

  it('keeps the request-frozen Agent and recipient display snapshot at completion', () => {
    const appendMessageToSession = vi.fn()
    const controller = completionController(
      streamState({
        agentDisplayName: '小明的辅导老师',
        recipientDisplayName: '小明',
        visibility: 'not_exposed',
      } as Partial<SessionStreamState>),
      appendMessageToSession,
    )

    const message = controller.finalizeAssistantMessage({
      content: 'answer',
      sessionId: 's1',
      agentName: 'researcher',
    })

    expect(message.agent_name).toBe('小明的辅导老师')
    expect(message.metadata?.recipient_display_name).toBe('小明')
  })

  it('fails with the live assistant identity and preserves elapsed thinking data', () => {
    const appendMessageToSession = vi.fn()
    const controller = createChatStreamErrorController({
      error: ref(null),
      currentSessionId: ref('s1'),
      streamingSessionId: ref('s1'),
      logger: { error: vi.fn() } as any,
      createId: () => 'unexpected-new-id',
      appendMessageToSession,
      resetSessionStream: vi.fn(),
      loadSessions: vi.fn(),
      persistErrorReply: vi.fn(),
    })

    controller.handleSendError(
      new Error('provider failed'),
      's1',
      ref(false),
      ref(false),
      streamState(),
    )

    expect(appendMessageToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        id: 'assistant-live-1',
        metadata: expect.objectContaining({
          is_error: true,
          thinking_state: 'failed',
          thinking_duration: 3,
          reasoning_visibility: 'visible',
        }),
      }),
    )
  })

  it('persists cancelled partial metadata under the live assistant identity and restores it', async () => {
    appendSessionMessage.mockResolvedValueOnce({
      id: 'assistant-live-1',
      session_id: 's1',
    })
    const cancelledMessage: ChatMessage = {
      id: 'assistant-live-1',
      role: 'assistant',
      content: 'answer',
      timestamp: '2026-07-29T00:00:00Z',
      reasoning: 'public summary',
      metadata: {
        thinking_state: 'cancelled',
        thinking_duration: 3,
        reasoning_visibility: 'visible',
        reasoning_disclosure: {
          visibility: 'visible',
          source: 'provider_adapter',
          dialect: 'reasoning_summary',
          provider: 'openai',
          model: 'gpt-5.6-sol',
        },
      },
    }

    await persistCancelledReply('s1', cancelledMessage)

    expect(appendSessionMessage).toHaveBeenCalledWith('s1', {
      id: 'assistant-live-1',
      role: 'assistant',
      content: 'answer',
      metadata: expect.objectContaining({
        thinking_state: 'cancelled',
        thinking_duration: 3,
        reasoning_visibility: 'visible',
        reasoning: 'public summary',
      }),
    })

    listSessionMessages.mockResolvedValueOnce({
      messages: [{
        id: 'assistant-live-1',
        role: 'assistant',
        content: 'answer',
        timestamp: '2026-07-29T00:00:00Z',
        metadata: {
          thinking_state: 'cancelled',
          thinking_duration: 3,
          reasoning_visibility: 'visible',
          reasoning_disclosure: {
            visibility: 'visible',
            source: 'provider_adapter',
            dialect: 'reasoning_summary',
            provider: 'openai',
            model: 'gpt-5.6-sol',
          },
          reasoning: 'public summary',
        },
      }],
      total: 1,
    })

    const [restored] = await loadMessages('s1')
    expect(restored).toMatchObject({
      id: 'assistant-live-1',
      reasoning: 'public summary',
      metadata: {
        thinking_state: 'cancelled',
        thinking_duration: 3,
        reasoning_visibility: 'visible',
      },
    })
  })

  it('routes active cancellation to durable terminal persistence', () => {
    const appendMessageToSession = vi.fn()
    const persistCancelled = vi.fn()
    const controller = createChatStreamCancelController({
      activeStreams: ref({ s1: streamState() }),
      currentSessionId: ref('s1'),
      messages: ref([]),
      streaming: ref(false),
      streamingSessionId: ref(null),
      streamingContent: ref(''),
      streamingReasoning: ref(''),
      streamingReasoningStartTime: ref(0),
      streamingReasoningEndTime: ref(0),
      streamHandles: new Map([['s1', { cancel: vi.fn() } as any]]),
      msgSvc: {
        persistMessage: vi.fn(),
        persistCancelledReply: persistCancelled,
      } as any,
      createId: () => 'unexpected-new-id',
      appendMessageToSession,
      resetSessionStream: vi.fn(),
      sendCancel: vi.fn(),
      clearSocketCallbacks: vi.fn(),
      triggerSocketError: vi.fn(),
    })

    expect(controller.stopSessionStream('s1')).toBe(true)
    expect(appendMessageToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        id: 'assistant-live-1',
        metadata: expect.objectContaining({
          thinking_state: 'cancelled',
          thinking_duration: 3,
          reasoning_visibility: 'visible',
        }),
      }),
    )
    expect(persistCancelled).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        id: 'assistant-live-1',
        metadata: expect.objectContaining({
          thinking_state: 'cancelled',
          thinking_duration: 3,
          reasoning_visibility: 'visible',
        }),
      }),
    )
  })

  it('persists a zero-output thinking cancellation under the same assistant identity', () => {
    const appendMessageToSession = vi.fn()
    const persistCancelled = vi.fn()
    const controller = createChatStreamCancelController({
      activeStreams: ref({
        s1: streamState({
          content: '',
          reasoning: '',
          thinkingEnabled: true,
          startedAt: Date.now() - 2_000,
          state: 'running',
          visibility: 'not_exposed',
        } as Partial<SessionStreamState>),
      }),
      currentSessionId: ref('s1'),
      messages: ref([]),
      streaming: ref(false),
      streamingSessionId: ref(null),
      streamingContent: ref(''),
      streamingReasoning: ref(''),
      streamingReasoningStartTime: ref(0),
      streamingReasoningEndTime: ref(0),
      streamHandles: new Map([['s1', { cancel: vi.fn() } as any]]),
      msgSvc: {
        persistMessage: vi.fn(),
        persistCancelledReply: persistCancelled,
      } as any,
      createId: () => 'unexpected-new-id',
      appendMessageToSession,
      resetSessionStream: vi.fn(),
      sendCancel: vi.fn(),
      clearSocketCallbacks: vi.fn(),
      triggerSocketError: vi.fn(),
    })

    expect(controller.stopSessionStream('s1')).toBe(true)
    expect(appendMessageToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        id: 'assistant-live-1',
        content: '',
        reasoning: undefined,
        metadata: expect.objectContaining({
          thinking_state: 'cancelled',
          reasoning_visibility: 'not_exposed',
        }),
      }),
    )
    expect(persistCancelled).toHaveBeenCalledTimes(1)
  })
})
