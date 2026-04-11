import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import { createChatApprovalController } from '../chat-approval-controller'
import { createChatArtifactController } from '../chat-artifact-controller'
import { createChatFacadeActions } from '../chat-facade-actions'
import { createChatMessageController } from '../chat-message-controller'
import { createChatSendAutoTitleController } from '../chat-send-auto-title'
import { createChatSendDeliveryController } from '../chat-send-delivery-controller'
import { shouldBlockChatSend, shouldSeedChatAutoTitle } from '../chat-send-guards'
import { createChatSessionLifecycleController } from '../chat-session-lifecycle'
import { createChatSessionLoadingController } from '../chat-session-loading'
import { createChatStoreSelectors } from '../chat-store-selectors'
import { createChatStreamCancelController } from '../chat-stream-cancel'
import { createChatStreamCompletionController } from '../chat-stream-completion'
import { createChatStreamErrorController } from '../chat-stream-error'
import { createChatStreamRecoveryController } from '../chat-stream-recovery'
import { createChatStreamStateController } from '../chat-stream-state'
import { createChatThinkingTimerController } from '../chat-thinking-timer'
import { createChatStoreState, createChatStoreRuntime } from '../chat-store-state'

describe('chat controller modules', () => {
  it('creates the expected default chat store state and runtime containers', () => {
    const state = createChatStoreState()
    const runtime = createChatStoreRuntime()

    expect(state.sessions.value).toEqual([])
    expect(state.currentSessionId.value).toBeNull()
    expect(state.chatMode.value).toBe('chat')
    expect(state.execMode.value).toBe('craft')
    expect(state.pendingApprovals.value).toEqual({})
    expect(runtime.streamHandles.size).toBe(0)
    expect(runtime.pendingAutoTitleSync.size).toBe(0)
    expect(runtime.cancelledSessions.size).toBe(0)
  })

  it('stores, resolves, and clears pending approvals by request id', () => {
    const nowSpy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
    const pendingApprovals = ref({})
    const ws = {
      onApprovalRequest: vi.fn().mockReturnValue(() => {}),
      sendApprovalResponse: vi.fn(),
    }
    const controller = createChatApprovalController({
      pendingApprovals,
      approvalCleanup: ref(null),
      ws: ws as any,
    })

    controller.storePendingApproval({
      requestId: 'req-1',
      sessionId: 's-1',
      toolName: 'fetch',
      risk: 'medium',
      reason: 'need network',
    } as any)
    controller.storePendingApproval({
      requestId: 'req-2',
      sessionId: 's-1',
      toolName: 'write',
      risk: 'high',
      reason: 'modify file',
    } as any)

    expect(controller.hasSessionPendingApproval('s-1')).toBe(true)
    expect(controller.getPendingApprovalForSession('s-1')?.requestId).toBe('req-2')

    controller.respondApproval('req-2', true, false)
    expect(ws.sendApprovalResponse).toHaveBeenCalledWith('req-2', true, false)
    expect(controller.getPendingApprovalForSession('s-1')?.requestId).toBe('req-1')

    controller.clearPendingApproval('req-1')
    expect(controller.hasSessionPendingApproval('s-1')).toBe(false)
    nowSpy.mockRestore()
  })

  it('extracts code blocks into persisted artifacts and supports selection', async () => {
    const saveArtifact = vi.fn().mockResolvedValue(undefined)
    const artifacts = ref([])
    const selectedArtifactId = ref<string | null>(null)
    const showArtifacts = ref(false)
    const controller = createChatArtifactController({
      artifacts,
      selectedArtifactId,
      showArtifacts,
      currentSessionId: ref('session-1'),
      msgSvc: { saveArtifact } as any,
      logger: { warn: vi.fn() } as any,
      createId: (() => {
        let index = 0
        return () => `artifact-${++index}`
      })(),
    })

    controller.extractArtifacts('```ts\nconsole.log("hi")\n```', 'msg-1')

    expect(saveArtifact).toHaveBeenCalledTimes(1)
    const [sessionId, artifact] = saveArtifact.mock.calls[0]!
    expect(sessionId).toBe('session-1')
    expect(artifact.language).toBe('ts')
    expect(artifact.content).toContain('console.log("hi")')

    controller.addArtifact({
      type: 'code',
      title: 'manual snippet',
      language: 'ts',
      content: 'const x = 1',
      messageId: 'msg-2',
      blockIndex: 0,
    })

    controller.selectArtifact('artifact-2')
    expect(selectedArtifactId.value).toBe('artifact-2')
    expect(showArtifacts.value).toBe(true)
    expect(artifacts.value).toHaveLength(2)
  })

  it('loads sessions, preserves local active entries, and restores the last selected session', async () => {
    const sessions = ref([
      {
        id: 's-stream',
        title: '进行中',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        message_count: 1,
      },
    ])
    const currentSessionId = ref<string | null>(null)
    const messages = ref<ChatMessage[]>([])
    const artifacts = ref([])
    const selectedArtifactId = ref<string | null>('artifact-1')
    const showArtifacts = ref(true)
    const error = ref({ code: 'SERVER_ERROR', status: 500, message: 'old error' } as any)
    const loadMessages = vi.fn().mockResolvedValue([
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'hello',
        timestamp: '2026-01-01',
      },
    ])
    const controller = createChatSessionLoadingController({
      sessions,
      currentSessionId,
      messages,
      artifacts,
      selectedArtifactId,
      showArtifacts,
      error,
      chatMode: ref('agent'),
      agentRole: ref('planner'),
      hasCustomTitle: ref(true),
      pendingSessionIds: ref({}),
      pendingSuggestedTitleExpectation: ref({}),
      ensureSessionPromise: ref(null),
      sessionSelectionGen: ref(0),
      msgSvc: {
        loadAllSessions: vi.fn().mockResolvedValue([
          {
            id: 's-last',
            title: '历史会话',
            created_at: '2026-01-02',
            updated_at: '2026-01-02',
            message_count: 3,
          },
        ]),
        getLastSessionId: vi.fn().mockResolvedValue('s-last'),
        setLastSessionId: vi.fn(),
        loadMessages,
        loadArtifacts: vi.fn().mockResolvedValue([]),
      } as any,
      logger: { warn: vi.fn() } as any,
      syncStreamingMirrors: vi.fn(),
      isSessionStreaming: vi.fn((sessionId: string) => sessionId === 's-stream'),
      extractArtifacts: vi.fn(),
    })

    await controller.loadSessions()

    expect(sessions.value.map((session) => session.id)).toEqual(['s-last', 's-stream'])
    expect(currentSessionId.value).toBe('s-last')
    expect(messages.value.map((message) => message.id)).toEqual(['user-1'])
    expect(selectedArtifactId.value).toBeNull()
    expect(showArtifacts.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('loadSessions preserves local title when pendingSuggestedTitleExpectation is set', async () => {
    const sessions = ref<any[]>([
      { id: 's1', title: '上海好玩的地方', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 1 },
    ])
    const pendingSuggestedTitleExpectation = ref<Record<string, string>>({ s1: '上海好玩的地方' })

    const controller = createChatSessionLoadingController({
      sessions,
      currentSessionId: ref(null),
      messages: ref([]),
      artifacts: ref([]),
      selectedArtifactId: ref(null),
      showArtifacts: ref(false),
      error: ref(null),
      chatMode: ref('chat'),
      agentRole: ref(''),
      hasCustomTitle: ref(false),
      pendingSessionIds: ref({}),
      pendingSuggestedTitleExpectation,
      ensureSessionPromise: ref(null),
      sessionSelectionGen: ref(0),
      msgSvc: {
        // Backend returns the OLD title "新对话" (PATCH hasn't landed yet)
        loadAllSessions: vi.fn().mockResolvedValue([
          { id: 's1', title: '新对话', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 1 },
        ]),
        getLastSessionId: vi.fn().mockResolvedValue(null),
        setLastSessionId: vi.fn(),
        loadMessages: vi.fn().mockResolvedValue([]),
        loadArtifacts: vi.fn().mockResolvedValue([]),
      } as any,
      logger: { warn: vi.fn() } as any,
      syncStreamingMirrors: vi.fn(),
      isSessionStreaming: vi.fn().mockReturnValue(false),
      extractArtifacts: vi.fn(),
    })

    await controller.loadSessions()

    // The local title "上海好玩的地方" should be preserved, NOT overwritten by backend's "新对话"
    expect(sessions.value.find((s: any) => s.id === 's1')?.title).toBe('上海好玩的地方')
  })

  it('deduplicates ensureSession and seeds a local session once', async () => {
    let releaseCreate!: () => void
    const upsertLocalSession = vi.fn()
    const pendingSessionTitle = ref('临时标题')
    const createSession = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      releaseCreate = resolve
    }))
    const currentSessionId = ref<string | null>(null)
    const controller = createChatSessionLifecycleController({
      currentSessionId,
      messages: ref([]),
      artifacts: ref([]),
      selectedArtifactId: ref<string | null>(null),
      showArtifacts: ref(false),
      error: ref(null),
      pendingSessionTitle,
      hasCustomTitle: ref(true),
      pendingSessionIds: ref({}),
      ensureSessionPromise: ref<Promise<string> | null>(null),
      cancelledSessions: new Set<string>(),
      msgSvc: {
        createSession,
      } as any,
      logger: { warn: vi.fn(), error: vi.fn() } as any,
      createId: () => 'session-1',
      syncStreamingMirrors: vi.fn(),
      isSessionStreaming: vi.fn().mockReturnValue(false),
      stopSessionStream: vi.fn(),
      resetSessionStream: vi.fn(),
      clearSessionCancelled: vi.fn(),
      markSessionCancelled: vi.fn(),
      upsertLocalSession,
    })

    const first = controller.ensureSession()
    const second = controller.ensureSession()
    releaseCreate()

    await expect(Promise.all([first, second])).resolves.toEqual(['session-1', 'session-1'])
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(currentSessionId.value).toBe('session-1')
    expect(pendingSessionTitle.value).toBeNull()
    expect(upsertLocalSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', title: '临时标题' }),
      true,
    )
  })

  it('deletes a streaming current session and clears scoped state', async () => {
    const cancelledSessions = new Set<string>()
    const currentSessionId = ref<string | null>('s1')
    const messages = ref<ChatMessage[]>([
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'hello',
        timestamp: '2026-01-01',
      },
    ])
    const artifacts = ref([{ id: 'artifact-1' }] as any)
    const selectedArtifactId = ref<string | null>('artifact-1')
    const showArtifacts = ref(true)
    const error = ref({ code: 'SERVER_ERROR', status: 500, message: 'old error' } as any)
    const syncStreamingMirrors = vi.fn()
    const markSessionCancelled = vi.fn((sessionId: string) => {
      cancelledSessions.add(sessionId)
    })
    const controller = createChatSessionLifecycleController({
      currentSessionId,
      messages,
      artifacts,
      selectedArtifactId,
      showArtifacts,
      error,
      pendingSessionTitle: ref(null),
      hasCustomTitle: ref(false),
      pendingSessionIds: ref({}),
      ensureSessionPromise: ref<Promise<string> | null>(null),
      cancelledSessions,
      msgSvc: {
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as any,
      logger: { warn: vi.fn(), error: vi.fn() } as any,
      createId: () => 'unused',
      syncStreamingMirrors,
      isSessionStreaming: vi.fn().mockReturnValue(true),
      stopSessionStream: vi.fn().mockReturnValue(true),
      resetSessionStream: vi.fn(),
      clearSessionCancelled: vi.fn(),
      markSessionCancelled,
      upsertLocalSession: vi.fn(),
    })

    await expect(controller.deleteSession('s1')).resolves.toBe(true)
    expect(currentSessionId.value).toBeNull()
    expect(messages.value).toEqual([])
    expect(artifacts.value).toEqual([])
    expect(selectedArtifactId.value).toBeNull()
    expect(showArtifacts.value).toBe(false)
    expect(error.value).toBeNull()
    expect(syncStreamingMirrors).toHaveBeenCalled()
    expect(cancelledSessions.size).toBe(0)
  })

  it('finalizes a completed stream, refreshes the session list, and keeps title sync conditional', async () => {
    const appendMessageToSession = vi.fn()
    const loadSessions = vi.fn().mockResolvedValue(undefined)
    const setLocalSessionTitle = vi.fn()
    const resetSessionStream = vi.fn()
    const extractArtifacts = vi.fn()
    const touchSession = vi.fn().mockResolvedValue(undefined)
    const suggestSessionTitle = vi.fn().mockResolvedValue({
      id: 's1',
      title: '正式标题',
      updated: true,
      updated_at: '2026-01-01',
    })

    const controller = createChatStreamCompletionController({
      activeStreams: ref({
        s1: {
          sessionId: 's1',
          requestId: 'req-1',
          rawContent: '',
          content: '最终回答',
          explicitReasoning: '',
          reasoning: '思考过程',
          reasoningStartTime: Date.now() - 2000,
        },
      }),
      pendingSuggestedTitleExpectation: ref({ s1: '临时标题' }),
      pendingAutoTitleSync: new Map(),
      currentSessionId: ref('s1'),
      msgSvc: {
        touchSession,
        suggestSessionTitle,
      } as any,
      createId: () => 'assistant-1',
      loadSessions,
      setLocalSessionTitle,
      setPendingSuggestedTitleExpectation: vi.fn(),
      bumpLocalSession: vi.fn(),
      extractArtifacts,
      appendMessageToSession,
      resetSessionStream,
    })

    controller.finalizeAssistantMessage({
      content: '最终回答',
      sessionId: 's1',
      sending: ref(false),
      draftSending: ref(false),
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(appendMessageToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        id: 'assistant-1',
        role: 'assistant',
        content: '最终回答',
      }),
    )
    expect(extractArtifacts).toHaveBeenCalledWith('最终回答', 'assistant-1')
    expect(setLocalSessionTitle).toHaveBeenCalledWith('s1', '正式标题')
    expect(loadSessions).toHaveBeenCalled()
    expect(resetSessionStream).toHaveBeenCalledWith('s1', expect.any(Object), expect.any(Object))
  })

  it('preserves partial stream output when cancelling a session stream', () => {
    const cancel = vi.fn()
    const appendMessageToSession = vi.fn()
    const resetSessionStream = vi.fn()

    const controller = createChatStreamCancelController({
      activeStreams: ref({
        s1: {
          sessionId: 's1',
          requestId: 'req-1',
          rawContent: '',
          content: '半截回答',
          explicitReasoning: '',
          reasoning: '半截思考',
          reasoningStartTime: 0,
        },
      }),
      currentSessionId: ref('s1'),
      messages: ref([]),
      streaming: ref(false),
      streamingSessionId: ref(null),
      streamingContent: ref(''),
      streamingReasoning: ref(''),
      streamingReasoningStartTime: ref(0),
      streamHandles: new Map([['s1', { cancel } as any]]),
      msgSvc: { persistMessage: vi.fn() } as any,
      createId: () => 'partial-1',
      appendMessageToSession,
      resetSessionStream,
      sendCancel: vi.fn(),
      clearSocketCallbacks: vi.fn(),
      triggerSocketError: vi.fn(),
    })

    expect(controller.stopSessionStream('s1')).toBe(true)
    expect(cancel).toHaveBeenCalled()
    expect(appendMessageToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        id: 'partial-1',
        role: 'assistant',
        content: '半截回答',
        reasoning: '半截思考',
      }),
    )
    expect(resetSessionStream).toHaveBeenCalledWith('s1', undefined, undefined)
  })

  it('recovers active streams through the resume flow and finalizes on completion', async () => {
    const finalizeAssistantMessage = vi.fn()
    const seedRecoveredStream = vi.fn()
    const updateStreamChunk = vi.fn()
    const storePendingApproval = vi.fn()
    const streamHandles = new Map<string, any>()
    const done = Promise.resolve({
      content: '恢复完成',
      metadata: { source: 'resume' },
      toolCalls: [],
      agentName: 'agent',
    })

    const controller = createChatStreamRecoveryController({
      activeStreams: ref({}),
      streamHandles,
      chatSvc: {
        resumeWebSocketStream: vi.fn().mockImplementation((_sessionId, _requestId, callbacks) => {
          callbacks.onSnapshot?.({ content: '恢复中', reasoning: '思考中', done: false })
          callbacks.onChunk?.('追加内容', '补充推理')
          return { cancel: vi.fn(), done }
        }),
      } as any,
      logger: { warn: vi.fn() } as any,
      storePendingApproval,
      listActiveStreams: vi.fn().mockResolvedValue({
        streams: [{ session_id: 's1', request_id: 'req-1', content: '恢复中', reasoning: '', done: false }],
        total: 1,
      }) as any,
      isSessionCancelled: vi.fn().mockReturnValue(false),
      seedRecoveredStream,
      updateStreamChunk,
      finalizeAssistantMessage,
      resetSessionStream: vi.fn(),
      handleSendError: vi.fn(),
    })

    await controller.recoverActiveStreams(ref(false), ref(false))
    await Promise.resolve()
    await done

    expect(seedRecoveredStream).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ session_id: 's1', request_id: 'req-1' }),
    )
    expect(updateStreamChunk).toHaveBeenCalledWith('s1', '追加内容', '补充推理')
    expect(finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        content: '恢复完成',
      }),
    )
  })

  it('syncs streaming mirrors and clears pending state when a session stream is reset', () => {
    const activeStreams = ref({})
    const pendingSessionIds = ref({})
    const currentSessionId = ref<string | null>('s1')
    const messages = ref([])
    const streaming = ref(false)
    const streamingSessionId = ref<string | null>(null)
    const streamingContent = ref('')
    const streamingReasoning = ref('')
    const streamingReasoningStartTime = ref(0)

    const controller = createChatStreamStateController({
      activeStreams,
      pendingSessionIds,
      currentSessionId,
      messages,
      streaming,
      streamingSessionId,
      streamingContent,
      streamingReasoning,
      streamingReasoningStartTime,
      msgSvc: { persistMessage: vi.fn() } as any,
      streamHandles: new Map([['s1', { cancel: vi.fn() } as any]]),
    })

    controller.setSessionPending('s1', true, ref(false), ref(false))
    controller.upsertStreamState('s1', {
      sessionId: 's1',
      requestId: 'req-1',
      rawContent: '',
      content: '输出中',
      explicitReasoning: '',
      reasoning: '推理中',
      reasoningStartTime: 123,
    })

    expect(streaming.value).toBe(true)
    expect(streamingSessionId.value).toBe('s1')
    expect(streamingContent.value).toBe('输出中')
    expect(streamingReasoning.value).toBe('推理中')
    expect(streamingReasoningStartTime.value).toBe(123)
    expect(controller.isSessionStreaming('s1')).toBe(true)

    controller.resetSessionStream('s1', ref(false), ref(false))

    expect(activeStreams.value).toEqual({})
    expect(pendingSessionIds.value).toEqual({})
    expect(streaming.value).toBe(false)
    expect(streamingSessionId.value).toBeNull()
    expect(streamingContent.value).toBe('')
    expect(streamingReasoning.value).toBe('')
    expect(streamingReasoningStartTime.value).toBe(0)
  })

  it('converts send failures into session-scoped assistant error messages', () => {
    const error = ref(null)
    const resetSessionStream = vi.fn()
    const appendMessageToSession = vi.fn()
    const loadSessions = vi.fn()

    const controller = createChatStreamErrorController({
      error,
      currentSessionId: ref('s1'),
      streamingSessionId: ref<string | null>(null),
      logger: { error: vi.fn() } as any,
      createId: () => 'assistant-error-1',
      appendMessageToSession,
      resetSessionStream,
      loadSessions,
    })

    controller.handleSendError(new Error('network down'), 's1', ref(false), ref(false))

    expect(error.value).toMatchObject({ message: 'network down' })
    expect(resetSessionStream).toHaveBeenCalledWith('s1', expect.any(Object), expect.any(Object))
    expect(appendMessageToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        id: 'assistant-error-1',
        role: 'assistant',
        content: 'network down',
      }),
    )
    expect(loadSessions).toHaveBeenCalled()
  })

  it('derives current streaming selectors from active stream state and pending approvals', () => {
    const selectors = createChatStoreSelectors({
      activeStreams: ref({
        s1: {
          sessionId: 's1',
          requestId: 'req-1',
          rawContent: '',
          content: '流式正文',
          explicitReasoning: '',
          reasoning: '流式思考',
          reasoningStartTime: 1,
        },
      }),
      currentSessionId: ref<string | null>('s1'),
      streamingContent: ref('legacy content'),
      streamingReasoning: ref('legacy reasoning'),
      pendingApprovals: ref({
        'req-1': {
          requestId: 'req-1',
          sessionId: 's1',
          toolName: 'fetch',
          risk: 'medium',
          reason: 'need network',
          receivedAt: 123,
        },
      }),
      hasLegacyCurrentStream: () => false,
      getPendingApprovalForSession: () => ({
        requestId: 'req-1',
        sessionId: 's1',
        toolName: 'fetch',
        risk: 'medium',
        reason: 'need network',
        receivedAt: 123,
      }),
    })

    expect(selectors.isCurrentStreaming.value).toBe(true)
    expect(selectors.isCurrentStreamingContent.value).toBe('流式正文')
    expect(selectors.isCurrentStreamingReasoning.value).toBe('流式思考')
    expect(selectors.pendingApproval.value?.requestId).toBe('req-1')
    expect(selectors.hasAnyPendingApproval.value).toBe(true)
  })

  it('updates and clears the thinking timer from reasoning start timestamps', async () => {
    vi.useFakeTimers()
    const streamingReasoningStartTime = ref(0)
    const streamingThinkingElapsed = ref(0)
    const thinkingTimer = ref<ReturnType<typeof setInterval> | null>(null)
    const controller = createChatThinkingTimerController({
      streamingReasoningStartTime,
      streamingThinkingElapsed,
      thinkingTimer,
    })
    controller.bindThinkingTimer()
    streamingReasoningStartTime.value = Date.now() - 2500
    await Promise.resolve()

    vi.advanceTimersByTime(1000)
    expect(streamingThinkingElapsed.value).toBeGreaterThanOrEqual(3)

    controller.clearThinkingTimer()
    expect(streamingThinkingElapsed.value).toBe(0)
    expect(thinkingTimer.value).toBeNull()

    vi.useRealTimers()
  })

  it('updates messages, persists the patch, and syncs assistant feedback with rollback', async () => {
    const touchSession = vi.fn().mockResolvedValue(undefined)
    const persistMessage = vi.fn().mockResolvedValue(true)
    const updateMessageFeedback = vi.fn()
      .mockResolvedValueOnce({ message: 'ok' })
      .mockRejectedValueOnce(new Error('sync failed'))
    const logger = { warn: vi.fn() }
    const messages = ref<ChatMessage[]>([
      {
        id: 'assist-1',
        role: 'assistant' as const,
        content: 'hi',
        timestamp: '2026-01-01',
        metadata: { backend_message_id: 'backend-1' },
      },
    ])

    const controller = createChatMessageController({
      currentSessionId: ref('s1'),
      messages,
      msgSvc: { persistMessage, touchSession } as any,
      chatApi: { updateMessageFeedback } as any,
      logger: logger as any,
    })

    await controller.updateMessage('assist-1', { content: 'updated' })
    expect(messages.value[0]?.content).toBe('updated')
    expect(persistMessage).toHaveBeenCalled()
    expect(touchSession).toHaveBeenCalledWith('s1')

    const liked = await controller.setMessageFeedback('assist-1', 'like')
    expect(liked?.metadata?.user_feedback).toBe('like')
    expect(updateMessageFeedback).toHaveBeenCalledWith('backend-1', 'like')

    await expect(controller.setMessageFeedback('assist-1', 'dislike')).rejects.toThrow('sync failed')
    expect(messages.value[0]?.metadata?.user_feedback).toBe('like')
  })

  it('builds request metadata from thinking and memory toggles', () => {
    const controller = createChatSendDeliveryController({
      chatParams: ref({}),
      agentRole: ref(''),
      thinkingEnabled: ref(true),
      activeStreams: ref({}),
      chatSvc: {} as any,
      getSettingsStore: ((() => ({ config: { memory: { enabled: false } } })) as any),
      clearSessionCancelled: vi.fn(),
      isSessionCancelled: vi.fn().mockReturnValue(false),
      setSessionPending: vi.fn(),
      upsertStreamState: vi.fn(),
      updateStreamChunk: vi.fn(),
      resetSessionStream: vi.fn(),
      finalizeAssistantMessage: vi.fn() as any,
      handleSendError: vi.fn(),
      storePendingApproval: vi.fn(),
      streamHandles: new Map(),
    })

    expect(controller.buildRequestMetadata()).toEqual({
      thinking: 'on',
      memory: 'off',
    })
  })

  it('applies send guards for pending/streaming sessions and auto-title seeding rules', () => {
    expect(shouldBlockChatSend({
      initialSessionId: 's1',
      pendingSessionIds: { s1: true },
      draftSending: false,
      isSessionStreaming: vi.fn().mockReturnValue(false),
    })).toBe(true)

    expect(shouldBlockChatSend({
      initialSessionId: null,
      pendingSessionIds: {},
      draftSending: true,
      isSessionStreaming: vi.fn().mockReturnValue(false),
    })).toBe(true)

    expect(shouldSeedChatAutoTitle({
      hasCustomTitle: false,
      initialSessionId: null,
      messages: [],
      sessions: [],
    })).toBe(true)

    expect(shouldSeedChatAutoTitle({
      hasCustomTitle: false,
      initialSessionId: 's1',
      messages: [],
      sessions: [{
        id: 's1',
        title: '新对话',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        message_count: 0,
      }],
    })).toBe(true)

    expect(shouldSeedChatAutoTitle({
      hasCustomTitle: true,
      initialSessionId: null,
      messages: [],
      sessions: [],
    })).toBe(false)
  })

  it('seeds a temporary auto title and clears pending sync state after persistence', async () => {
    const pendingAutoTitleSync = new Map<string, Promise<void>>()
    const setLocalSessionTitle = vi.fn()
    const setPendingSuggestedTitleExpectation = vi.fn()
    const text = '这是一个很长的标题候选，需要被裁剪成临时标题以避免侧栏溢出'
    const expectedTitle = text.slice(0, 30) + (text.length > 30 ? '...' : '')
    const controller = createChatSendAutoTitleController({
      msgSvc: {
        updateSessionTitle: vi.fn().mockResolvedValue(undefined),
      } as any,
      pendingAutoTitleSync,
      setLocalSessionTitle,
      setPendingSuggestedTitleExpectation,
    })

    controller.seedAutoTitle('s1', text)
    await Promise.resolve()
    await Promise.resolve()

    expect(setLocalSessionTitle).toHaveBeenCalledWith('s1', expectedTitle)
    expect(setPendingSuggestedTitleExpectation).toHaveBeenCalledWith('s1', expectedTitle)
    expect(pendingAutoTitleSync.size).toBe(0)
  })

  it('delivers through backend when websocket is unavailable', async () => {
    const finalizeAssistantMessage = vi.fn().mockReturnValue({ id: 'assistant-1' })
    const controller = createChatSendDeliveryController({
      chatParams: ref({ provider: 'ollama', model: 'qwen3.5:9b' }),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      activeStreams: ref({}),
      chatSvc: {
        ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
        sendViaBackend: vi.fn().mockResolvedValue({
          reply: 'backend reply',
          session_id: 's1',
          metadata: { backend_message_id: 'msg-1' },
          tool_calls: [],
        }),
      } as any,
      getSettingsStore: ((() => ({ config: { memory: { enabled: true } } })) as any),
      clearSessionCancelled: vi.fn(),
      isSessionCancelled: vi.fn().mockReturnValue(false),
      setSessionPending: vi.fn(),
      upsertStreamState: vi.fn(),
      updateStreamChunk: vi.fn(),
      resetSessionStream: vi.fn(),
      finalizeAssistantMessage: finalizeAssistantMessage as any,
      handleSendError: vi.fn(),
      storePendingApproval: vi.fn(),
      streamHandles: new Map(),
    })

    await controller.deliverMessage({
      backendText: 'hello',
      sessionId: 's1',
      requestId: 'req-1',
      sending: ref(false),
      draftSending: ref(false),
    })

    expect(finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'backend reply',
        sessionId: 's1',
        metadata: { backend_message_id: 'msg-1' },
      }),
    )
  })

  it('builds thin facade actions around session/send/stream controllers', async () => {
    const sessionController = {
      loadSessions: vi.fn().mockResolvedValue(undefined),
      selectSession: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn(),
      ensureSession: vi.fn().mockResolvedValue('s1'),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    const sendController = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    }
    const boundStreamController = {
      stopStreaming: vi.fn(),
    }
    const thinkingTimerController = {
      clearThinkingTimer: vi.fn(),
    }
    const error = ref({ message: 'old error' } as any)

    const facade = createChatFacadeActions({
      error,
      sessionController: sessionController as any,
      sendController: sendController as any,
      boundStreamController: boundStreamController as any,
      thinkingTimerController: thinkingTimerController as any,
    })

    await facade.loadSessions()
    await facade.selectSession('s2')
    facade.newSession('title')
    await expect(facade.ensureSession()).resolves.toBe('s1')
    await facade.sendMessage('hello')
    facade.stopStreaming('s2')
    await facade.deleteSession('s2')

    expect(thinkingTimerController.clearThinkingTimer).toHaveBeenCalled()
    expect(sessionController.selectSession).toHaveBeenCalledWith('s2')
    expect(sessionController.newSession).toHaveBeenCalledWith('title')
    expect(error.value).toBeNull()
    expect(sendController.sendMessage).toHaveBeenCalledWith('hello', undefined, undefined)
    expect(boundStreamController.stopStreaming).toHaveBeenCalledWith('s2')
    expect(sessionController.deleteSession).toHaveBeenCalledWith('s2')
  })
})
