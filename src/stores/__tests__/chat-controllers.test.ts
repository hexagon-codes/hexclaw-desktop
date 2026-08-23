import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import { createChatApprovalController } from '../chat-approval-controller'
import { createChatArtifactController } from '../chat-artifact-controller'
import { createChatFacadeActions } from '../chat-facade-actions'
import { createChatMessageController } from '../chat-message-controller'
import { createChatSendAutoTitleController } from '../chat-send-auto-title'
import { createChatSendController } from '../chat-send-controller'
import { createChatSendDeliveryController } from '../chat-send-delivery-controller'
import { createChatSessionController } from '../chat-session-controller'
import { shouldBlockChatSend, shouldSeedChatAutoTitle } from '../chat-send-guards'
import { createChatSessionLifecycleController } from '../chat-session-lifecycle'
import { createChatSessionLoadingController } from '../chat-session-loading'
import { createChatStoreSelectors } from '../chat-store-selectors'
import { createBoundChatStreamController } from '../chat-stream-bound-controller'
import { createChatStreamCancelController } from '../chat-stream-cancel'
import { createChatStreamCompletionController } from '../chat-stream-completion'
import { createChatStreamErrorController } from '../chat-stream-error'
import { createChatStreamRecoveryController } from '../chat-stream-recovery'
import { createChatStreamStateController } from '../chat-stream-state'
import { createChatThinkingTimerController } from '../chat-thinking-timer'
import { createChatStoreState, createChatStoreRuntime } from '../chat-store-state'

describe('chat controller modules', () => {
  it('BUG-20260802-017 forwards request-owned stream identity through the bound error adapter', () => {
    const sending = ref(false)
    const draftSending = ref(false)
    const handleSendError = vi.fn()
    const streamState = {
      sessionId: 'session-idle',
      requestId: 'req-idle',
      assistantMessageId: 'req-idle:assistant',
    }
    const controller = createBoundChatStreamController({
      streamController: { handleSendError } as any,
      sending,
      draftSending,
    })
    const idleError = new Error('Assistant reply stalled — no new content received.')

    ;(controller.handleSendError as any)(idleError, 'session-idle', streamState)

    expect(handleSendError).toHaveBeenCalledWith(
      idleError,
      'session-idle',
      sending,
      draftSending,
      streamState,
    )
  })

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

  it('stores, resolves, and clears pending approvals by request id', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)
    const pendingApprovals = ref({})
    const ws = {
      onApprovalRequest: vi.fn().mockReturnValue(() => {}),
      sendApprovalResponse: vi.fn(),
    }
    const approvalTransport = {
      sendApprovalResponse: vi.fn((decision: RedApprovalDecision) =>
        Promise.resolve({
          type: 'tool_approval_ack' as const,
          request_id: decision.request_id,
          session_id: 's-1',
          owner_id: 'desktop-user',
          invocation_id: 'invocation-2',
          arguments_digest: 'c'.repeat(64),
          security_scope_digest: 'd'.repeat(64),
          scope_schema_version: 1,
          decision_id: decision.decision_id,
          decision: decision.decision,
          idempotency_key: decision.idempotency_key,
          status: 'accepted' as const,
        }),
      ),
    }
    const controller = createChatApprovalController({
      pendingApprovals,
      approvalCleanup: ref(null),
      ws: ws as any,
      approvalTransport,
    })

    controller.storePendingApproval({
      requestId: 'req-1',
      sessionId: 's-1',
      ownerId: 'desktop-user',
      invocationId: 'invocation-1',
      toolName: 'fetch',
      argumentsDigest: 'a'.repeat(64),
      securityScopeDigest: 'b'.repeat(64),
      scopeSchemaVersion: 1,
      risk: 'medium',
      reason: 'need network',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    } as any)
    controller.storePendingApproval({
      requestId: 'req-2',
      sessionId: 's-1',
      ownerId: 'desktop-user',
      invocationId: 'invocation-2',
      toolName: 'write',
      argumentsDigest: 'c'.repeat(64),
      securityScopeDigest: 'd'.repeat(64),
      scopeSchemaVersion: 1,
      risk: 'high',
      reason: 'modify file',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    } as any)

    expect(controller.hasSessionPendingApproval('s-1')).toBe(true)
    expect(controller.getPendingApprovalForSession('s-1')?.requestId).toBe('req-2')

    await controller.respondApproval('req-2', true, false)
    expect(approvalTransport.sendApprovalResponse).toHaveBeenCalledTimes(1)
    expect(ws.sendApprovalResponse).not.toHaveBeenCalled()
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
      thinkingEnabled: ref(false),
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
      {
        id: 's1',
        title: '上海好玩的地方',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        message_count: 1,
      },
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
      thinkingEnabled: ref(false),
      hasCustomTitle: ref(false),
      pendingSessionIds: ref({}),
      pendingSuggestedTitleExpectation,
      ensureSessionPromise: ref(null),
      sessionSelectionGen: ref(0),
      msgSvc: {
        // Backend returns the OLD title "新对话" (PATCH hasn't landed yet)
        loadAllSessions: vi.fn().mockResolvedValue([
          {
            id: 's1',
            title: '新对话',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
            message_count: 1,
          },
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
    const createSession = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCreate = resolve
        }),
    )
    const setLastSessionId = vi.fn()
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
      sessionSelectionGen: ref(0),
      msgSvc: {
        createSession,
        setLastSessionId,
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
    expect(setLastSessionId).toHaveBeenCalledExactlyOnceWith('session-1')
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
      sessionSelectionGen: ref(0),
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

  it('BUG-20260723-007 preserves a failed deletion result for the caller', async () => {
    const sessions = ref([{ id: 's1', title: '待删除会话' }] as any)
    const controller = createChatSessionController({
      sessions,
      currentSessionId: ref<string | null>('s1'),
      messages: ref([]),
      artifacts: ref([]),
      selectedArtifactId: ref<string | null>(null),
      showArtifacts: ref(false),
      error: ref(null),
      chatMode: ref('chat'),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      hasCustomTitle: ref(false),
      pendingSessionTitle: ref(null),
      pendingSessionIds: ref({}),
      pendingSuggestedTitleExpectation: ref({}),
      sessionSelectionGen: ref(0),
      ensureSessionPromise: ref<Promise<string> | null>(null),
      cancelledSessions: new Set<string>(),
      msgSvc: {
        deleteSession: vi.fn().mockRejectedValue(new Error('delete failed')),
      } as any,
      logger: { warn: vi.fn(), error: vi.fn() } as any,
      createId: () => 'unused',
      syncStreamingMirrors: vi.fn(),
      isSessionStreaming: vi.fn().mockReturnValue(false),
      stopSessionStream: vi.fn().mockReturnValue(false),
      resetSessionStream: vi.fn(),
      clearSessionCancelled: vi.fn(),
      markSessionCancelled: vi.fn(),
      extractArtifacts: vi.fn(),
    })

    await expect(controller.deleteSession('s1')).resolves.toBe(false)
    expect(sessions.value).toHaveLength(1)
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
          assistantMessageAliases: [],
          lastSequence: 0,
          runtimeEvents: [],
          acceptedRuntimeFrames: {},
          rawContent: '',
          content: '最终回答',
          explicitReasoning: '',
          reasoning: '思考过程',
          reasoningStartTime: Date.now() - 2000,
          reasoningEndTime: 0,
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
          assistantMessageAliases: [],
          lastSequence: 0,
          runtimeEvents: [],
          acceptedRuntimeFrames: {},
          rawContent: '',
          content: '半截回答',
          explicitReasoning: '',
          reasoning: '半截思考',
          reasoningStartTime: 0,
          reasoningEndTime: 0,
          visibility: 'visible',
        },
      }),
      currentSessionId: ref('s1'),
      messages: ref([]),
      streaming: ref(false),
      streamingSessionId: ref(null),
      streamingContent: ref(''),
      streamingReasoning: ref(''),
      streamingReasoningStartTime: ref(0),
      streamingReasoningEndTime: ref(0),
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
        streams: [
          { session_id: 's1', request_id: 'req-1', content: '恢复中', reasoning: '', done: false },
        ],
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
    expect(updateStreamChunk).toHaveBeenCalledWith('s1', '追加内容', '补充推理', undefined)
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
    const streamingReasoningEndTime = ref(0)

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
      streamingReasoningEndTime,
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
      reasoningEndTime: 0,
      assistantMessageAliases: [],
      lastSequence: 0,
      runtimeEvents: [],
      acceptedRuntimeFrames: {},
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
      persistErrorReply: vi.fn(),
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

  // Bug 复现(2026-06-25): 报错气泡切会话回来就没了 —— 只写内存、persistMessage 是 no-op，从不落库。
  it('persists the error reply to backend so it survives session reload', () => {
    const persistErrorReply = vi.fn()
    const controller = createChatStreamErrorController({
      error: ref(null),
      currentSessionId: ref('s1'),
      streamingSessionId: ref<string | null>(null),
      logger: { error: vi.fn() } as any,
      createId: () => 'assistant-error-2',
      appendMessageToSession: vi.fn(),
      resetSessionStream: vi.fn(),
      loadSessions: vi.fn(),
      persistErrorReply,
    })

    controller.handleSendError(new Error('llm down'), 's1', ref(false), ref(false))

    expect(persistErrorReply).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ id: 'assistant-error-2', role: 'assistant', content: 'llm down' }),
    )
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
          reasoningEndTime: 0,
          assistantMessageAliases: [],
          lastSequence: 0,
          runtimeEvents: [],
          acceptedRuntimeFrames: {},
        },
      }),
      currentSessionId: ref<string | null>('s1'),
      streamingContent: ref('legacy content'),
      streamingReasoning: ref('legacy reasoning'),
      pendingApprovals: ref({
        'req-1': {
          requestId: 'req-1',
          sessionId: 's1',
          ownerId: 'desktop-user',
          invocationId: 'invocation-1',
          toolName: 'fetch',
          argumentsDigest: 'a'.repeat(64),
          securityScopeDigest: 'b'.repeat(64),
          scopeSchemaVersion: 1,
          risk: 'medium',
          reason: 'need network',
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          receivedAt: 123,
        },
      }),
      hasLegacyCurrentStream: () => false,
      getPendingApprovalForSession: () => ({
        requestId: 'req-1',
        sessionId: 's1',
        ownerId: 'desktop-user',
        invocationId: 'invocation-1',
        toolName: 'fetch',
        argumentsDigest: 'a'.repeat(64),
        securityScopeDigest: 'b'.repeat(64),
        scopeSchemaVersion: 1,
        risk: 'medium',
        reason: 'need network',
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
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
    const streamingReasoningEndTime = ref(0)
    const controller = createChatThinkingTimerController({
      streamingReasoningStartTime,
      streamingReasoningEndTime,
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
    const updateMessageFeedback = vi
      .fn()
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

    await expect(controller.setMessageFeedback('assist-1', 'dislike')).rejects.toThrow(
      'sync failed',
    )
    expect(messages.value[0]?.metadata?.user_feedback).toBe('like')
  })

  it('点赞回退分支：消息确无 backend_message_id 时只本地点亮 + warn，不空调后端', async () => {
    // 这是「真缺 id」时的正确防御行为（如复读熔断/落库失败等罕见边缘消息）：没有可同步的后端 id，
    // 就乐观点亮 + warn，不拿不存在的 id 去空调 updateMessageFeedback。
    // ⚠ 2026-06-26 复核更正：正常路径下 fresh 消息「会丢」是误判——后端流式 done chunk 经
    // engine/react.go buildReplyMetadata/withAssistantMessageID 已携带 backend_message_id，前端
    // finalize 时已接到该 fresh 消息上，点刚生成答案的赞会同步后端、不丢。端到端取证见
    // chat.test.ts「★AUDIT-20260626 fresh WS reply carries backend_message_id」。
    const updateMessageFeedback = vi.fn().mockResolvedValue({ message: 'ok' })
    const logger = { warn: vi.fn() }
    const messages = ref<ChatMessage[]>([
      {
        id: 'fastpath-local-xyz',
        role: 'assistant' as const,
        content: 'hi',
        timestamp: '2026-01-01',
      }, // 无 backend_message_id（边缘消息）
    ])
    const controller = createChatMessageController({
      currentSessionId: ref('s1'),
      messages,
      msgSvc: {
        persistMessage: vi.fn().mockResolvedValue(true),
        touchSession: vi.fn().mockResolvedValue(undefined),
      } as any,
      chatApi: { updateMessageFeedback } as any,
      logger: logger as any,
    })

    await controller.setMessageFeedback('fastpath-local-xyz', 'like')
    // 乐观本地点亮
    expect(messages.value[0]?.metadata?.user_feedback).toBe('like')
    // 无后端 id 可同步 → 不空调后端，仅 warn
    expect(updateMessageFeedback).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled() // "仅保存在本地"
  })

  it('builds request metadata from thinking and memory toggles', () => {
    const controller = createChatSendDeliveryController({
      chatParams: ref({}),
      agentRole: ref(''),
      thinkingEnabled: ref(true),
      activeStreams: ref({}),
      chatSvc: {} as any,
      getSettingsStore: (() => ({ config: { memory: { enabled: false } } })) as any,
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
      // BUG-20260703：聊天路径恒带锁定信号，空 agentRole = 默认助理
      pinned_agent: 'default',
      // BUG-20260709：系统语言恒透传（含默认 zh-CN），后端拼显式输出语言指令
      user_locale: 'zh-CN',
      // v0.5.0 统一消息内容协议：服务端据生产者和规范 locale 生成 RenderManifest。
      locale: 'zh-CN',
      producer_kind: 'chat',
    })
  })

  it('uses the frozen route thinking effort instead of mutable live settings', () => {
    const controller = createChatSendDeliveryController({
      chatParams: ref({ provider: 'openai', model: 'gpt-5.6-sol' }),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      activeStreams: ref({}),
      chatSvc: {} as any,
      getSettingsStore: (() => ({ config: { memory: { enabled: true } } })) as any,
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

    expect(
      controller.buildRequestMetadata({
        agentRole: '',
        chatParams: { provider: 'openai', model: 'gpt-5.6-sol' },
        thinkingEnabled: true,
        reasoningSupport: 'supported',
        reasoningPolicy: { mode: 'effort', effort: 'high' },
        reasoningControl: {
          dialect: 'reasoning_effort',
          on: 'high',
          off: 'none',
          allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      } as never),
    ).toMatchObject({
      thinking: 'on',
      thinking_effort: 'high',
    })
  })

  it('applies send guards for pending/streaming sessions and auto-title seeding rules', () => {
    expect(
      shouldBlockChatSend({
        initialSessionId: 's1',
        pendingSessionIds: { s1: true },
        draftSending: false,
        isSessionStreaming: vi.fn().mockReturnValue(false),
      }),
    ).toBe(true)

    expect(
      shouldBlockChatSend({
        initialSessionId: null,
        pendingSessionIds: {},
        draftSending: true,
        isSessionStreaming: vi.fn().mockReturnValue(false),
      }),
    ).toBe(true)

    expect(
      shouldSeedChatAutoTitle({
        hasCustomTitle: false,
        initialSessionId: null,
        messages: [],
        sessions: [],
      }),
    ).toBe(true)

    expect(
      shouldSeedChatAutoTitle({
        hasCustomTitle: false,
        initialSessionId: 's1',
        messages: [],
        sessions: [
          {
            id: 's1',
            title: 'New Chat',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
            message_count: 0,
          },
        ],
      }),
    ).toBe(true)

    expect(
      shouldSeedChatAutoTitle({
        hasCustomTitle: true,
        initialSessionId: null,
        messages: [],
        sessions: [],
      }),
    ).toBe(false)
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

  it('fails closed when the sole WebSocket transport is unavailable', async () => {
    const finalizeAssistantMessage = vi.fn().mockReturnValue({ id: 'assistant-1' })
    const sendViaBackend = vi.fn()
    const handleSendError = vi.fn()
    const controller = createChatSendDeliveryController({
      chatParams: ref({ provider: 'ollama', model: 'qwen3.5:9b' }),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      activeStreams: ref({}),
      chatSvc: {
        ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
        sendViaBackend,
      } as any,
      getSettingsStore: (() => ({ config: { memory: { enabled: true } } })) as any,
      clearSessionCancelled: vi.fn(),
      isSessionCancelled: vi.fn().mockReturnValue(false),
      setSessionPending: vi.fn(),
      upsertStreamState: vi.fn(),
      updateStreamChunk: vi.fn(),
      resetSessionStream: vi.fn(),
      finalizeAssistantMessage: finalizeAssistantMessage as any,
      handleSendError,
      storePendingApproval: vi.fn(),
      streamHandles: new Map(),
    })

    const result = await controller.deliverMessage({
      backendText: 'hello',
      sessionId: 's1',
      requestId: 'req-1',
      sending: ref(false),
      draftSending: ref(false),
    })

    expect(result).toBeNull()
    expect(handleSendError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('WebSocket transport unavailable'),
      }),
      's1',
      undefined,
    )
    expect(finalizeAssistantMessage).not.toHaveBeenCalled()
    expect(sendViaBackend).not.toHaveBeenCalled()
  })

  it('keeps the request-owned stream identity until an idle transport error is projected', async () => {
    class TestChatRequestError extends Error {
      noFallback: boolean
      constructor(message: string, noFallback = false) {
        super(message)
        this.noFallback = noFallback
      }
    }
    const activeStreams = ref<Record<string, any>>({})
    const handleSendError = vi.fn()
    const upsertStreamState = vi.fn((sessionId: string, nextState: any) => {
      const next = { ...activeStreams.value }
      if (nextState) next[sessionId] = nextState
      else delete next[sessionId]
      activeStreams.value = next
    })
    const resetSessionStream = vi.fn((sessionId?: string | null) => {
      if (!sessionId) return
      const next = { ...activeStreams.value }
      delete next[sessionId]
      activeStreams.value = next
    })
    const controller = createChatSendDeliveryController({
      chatParams: ref({ provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' }),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      activeStreams,
      chatSvc: {
        ChatRequestError: TestChatRequestError,
        ensureWebSocketConnected: vi.fn().mockResolvedValue(true),
        openWebSocketStream: vi.fn().mockReturnValue({
          cancel: vi.fn(),
          done: Promise.reject(
            new TestChatRequestError('Assistant reply stalled — no new content received.'),
          ),
        }),
      } as any,
      getSettingsStore: (() => ({ config: { memory: { enabled: true } } })) as any,
      clearSessionCancelled: vi.fn(),
      isSessionCancelled: vi.fn().mockReturnValue(false),
      setSessionPending: vi.fn(),
      upsertStreamState,
      updateStreamChunk: vi.fn().mockReturnValue(false),
      resetSessionStream,
      finalizeAssistantMessage: vi.fn() as any,
      handleSendError,
      storePendingApproval: vi.fn(),
      streamHandles: new Map(),
    })

    await controller.deliverMessage({
      backendText: 'idle request',
      sessionId: 'session-idle',
      requestId: 'req-idle',
      sending: ref(false),
      draftSending: ref(false),
    })

    expect(handleSendError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('WebSocket transport unavailable'),
      }),
      'session-idle',
      expect.objectContaining({
        requestId: 'req-idle',
        assistantMessageId: 'req-idle:assistant',
      }),
    )
  })

  it('keeps the accepted edit model and agent route frozen while websocket connection settles', async () => {
    let resolveConnection!: (connected: boolean) => void
    const chatParams = ref({ provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' })
    const agentRole = ref('k12-tutor-mingming')
    const openWebSocketStream = vi.fn().mockReturnValue({
      cancel: vi.fn(),
      done: Promise.resolve({ content: 'backend reply' }),
    })
    const controller = createChatSendDeliveryController({
      chatParams,
      agentRole,
      thinkingEnabled: ref(false),
      activeStreams: ref({}),
      chatSvc: {
        ensureWebSocketConnected: vi.fn().mockReturnValue(
          new Promise<boolean>((resolve) => {
            resolveConnection = resolve
          }),
        ),
        openWebSocketStream,
      } as any,
      getSettingsStore: (() => ({
        config: { memory: { enabled: true } },
        availableModels: [],
      })) as any,
      clearSessionCancelled: vi.fn(),
      isSessionCancelled: vi.fn().mockReturnValue(false),
      setSessionPending: vi.fn(),
      upsertStreamState: vi.fn(),
      updateStreamChunk: vi.fn().mockReturnValue(false),
      resetSessionStream: vi.fn(),
      finalizeAssistantMessage: vi.fn().mockReturnValue({ id: 'assistant' }) as any,
      handleSendError: vi.fn(),
      storePendingApproval: vi.fn(),
      streamHandles: new Map(),
    })

    const pending = controller.deliverMessage({
      backendText: 'edited question',
      sessionId: 'edit-branch',
      requestId: 'edited-request',
      sending: ref(false),
      draftSending: ref(false),
      samplingSnapshot: {
        agentRole: 'k12-tutor-mingming',
        chatParams: { provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' },
        thinkingEnabled: false,
      },
    })
    chatParams.value = { provider: 'other-provider', model: 'other-model' }
    agentRole.value = 'other-agent'
    resolveConnection(true)
    await pending

    expect(openWebSocketStream).toHaveBeenCalledWith(
      'edited question',
      'edit-branch',
      { provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' },
      'k12-tutor-mingming',
      undefined,
      expect.any(Object),
      expect.any(Object),
      'edited-request',
    )
  })

  it('directs an edited version to its explicit branch without mutating the visible source session', async () => {
    const currentSessionId = ref<string | null>('source-session')
    const sourceMessages = [
      {
        id: 'source-user',
        role: 'user' as const,
        content: '原问题',
        timestamp: '2026-07-24T00:00:00Z',
      },
    ]
    const messages = ref<ChatMessage[]>(sourceMessages.map((message) => ({ ...message })))
    const ensureSession = vi.fn().mockResolvedValue('wrong-current-session')
    const persistMessage = vi.fn().mockResolvedValue(true)
    const openWebSocketStream = vi.fn().mockReturnValue({
      cancel: vi.fn(),
      done: Promise.resolve({
        content: '新版本回答',
        metadata: { backend_message_id: 'branch-assistant' },
      }),
    })
    const finalizeAssistantMessage = vi.fn().mockReturnValue({
      id: 'branch-assistant',
      role: 'assistant',
      content: '新版本回答',
      timestamp: '2026-07-24T00:00:01Z',
    })
    const sending = ref(false)
    const draftSending = ref(false)

    const controller = createChatSendController({
      currentSessionId,
      messages,
      pendingSessionIds: ref({}),
      draftSending,
      activeStreams: ref({}),
      chatParams: ref({ provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' }),
      agentRole: ref('k12-tutor-mingming'),
      thinkingEnabled: ref(false),
      hasCustomTitle: ref(true),
      sessions: ref([]),
      msgSvc: {
        updateSessionTitle: vi.fn().mockResolvedValue(undefined),
      } as any,
      chatSvc: {
        ensureWebSocketConnected: vi.fn().mockResolvedValue(true),
        openWebSocketStream,
      } as any,
      createId: () => 'edited-user-version',
      getSettingsStore: (() => ({
        config: { memory: { enabled: true } },
        availableModels: [],
      })) as any,
      ensureSession,
      clearSessionCancelled: vi.fn(),
      isSessionCancelled: vi.fn().mockReturnValue(false),
      isSessionStreaming: vi.fn().mockReturnValue(false),
      isSessionExecuting: vi.fn().mockReturnValue(false),
      setSessionPending: vi.fn(),
      refreshSendingState: vi.fn(),
      setLocalSessionTitle: vi.fn(),
      setPendingSuggestedTitleExpectation: vi.fn(),
      pendingAutoTitleSync: new Map(),
      persistMessage,
      upsertStreamState: vi.fn(),
      updateStreamChunk: vi.fn().mockReturnValue(false),
      resetSessionStream: vi.fn(),
      finalizeAssistantMessage: finalizeAssistantMessage as any,
      handleSendError: vi.fn(),
      storePendingApproval: vi.fn(),
      streamHandles: new Map(),
      sending,
    })

    const result = await controller.sendMessage('修改后的问题', undefined, {
      targetSessionId: 'edit-branch',
    })

    expect(currentSessionId.value).toBe('source-session')
    expect(messages.value).toEqual(sourceMessages)
    expect(ensureSession).not.toHaveBeenCalled()
    expect(persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'edited-user-version', content: '修改后的问题' }),
      'edit-branch',
    )
    expect(openWebSocketStream).toHaveBeenCalledWith(
      '修改后的问题',
      'edit-branch',
      expect.objectContaining({ model: 'gpt-5.6-sol' }),
      'k12-tutor-mingming',
      undefined,
      expect.any(Object),
      expect.any(Object),
      'edited-user-version',
    )
    expect(result).toMatchObject({ id: 'branch-assistant' })
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

// RED contract for the approved tool-approval transport lifecycle.
type RedApprovalDecision = {
  request_id: string
  decision_id: string
  invocation_id?: string
  arguments_digest?: string
  security_scope_digest?: string
  decision: 'approved_once' | 'approved_remember' | 'denied'
  idempotency_key: string
  reason?: string
}

type RedApprovalAck = {
  type: 'tool_approval_ack'
  request_id: string
  session_id: string
  owner_id: string
  invocation_id: string
  arguments_digest: string
  security_scope_digest: string
  scope_schema_version: number
  decision_id: string
  decision: 'approved_once' | 'approved_remember' | 'denied'
  idempotency_key: string
  status: 'accepted' | 'already_accepted' | 'send_failed'
}

type RedApprovalTerminal = {
  type: 'tool_approval_terminal'
  request_id: string
  session_id: string
  owner_id: string
  invocation_id: string
  arguments_digest: string
  security_scope_digest: string
  scope_schema_version: number
  terminal_result: 'expired' | 'fenced'
  deadline_at?: string
}

function redApprovalRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'approval-request-1',
    sessionId: 'session-1',
    ownerId: 'desktop-user',
    invocationId: 'invocation-1',
    toolName: 'filesystem.write',
    argumentsDigest: 'a'.repeat(64),
    securityScopeDigest: 'b'.repeat(64),
    scopeSchemaVersion: 1,
    risk: 'high',
    reason: 'Writes a generated file',
    deadlineAt: '2026-07-29T04:01:00.000Z',
    ...overrides,
  }
}

function redApprovalAcknowledgement(
  decision: RedApprovalDecision,
  overrides: Partial<RedApprovalAck> = {},
): RedApprovalAck {
  return {
    type: 'tool_approval_ack',
    request_id: decision.request_id,
    session_id: 'session-1',
    owner_id: 'desktop-user',
    invocation_id: 'invocation-1',
    arguments_digest: 'a'.repeat(64),
    security_scope_digest: 'b'.repeat(64),
    scope_schema_version: 1,
    decision_id: decision.decision_id,
    decision: decision.decision,
    idempotency_key: decision.idempotency_key,
    status: 'accepted',
    ...overrides,
  }
}

function redDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function createRedApprovalHarness(
  responder?: (decision: RedApprovalDecision) => Promise<RedApprovalAck>,
  options: { includeApprovalTransport?: boolean } = {},
) {
  const [{ ref }, approvalModule] = await Promise.all([
    import('vue'),
    import('../chat-approval-controller'),
  ])
  const pendingApprovals = ref<Record<string, Record<string, unknown>>>({})
  const globalSendApprovalResponse = vi.fn()
  const sendRaw = vi.fn()
  const approvalRequestListeners = new Set<(request: Record<string, unknown>) => void>()
  const approvalWireListeners = new Set<(wire: Record<string, unknown>) => void>()
  const reconnectListeners = new Set<() => void>()
  const ownerSendApprovalResponse = vi.fn(
    responder ??
      ((decision: RedApprovalDecision) => Promise.resolve(redApprovalAcknowledgement(decision))),
  )
  const globalWebSocket = {
    sendApprovalResponse: globalSendApprovalResponse,
    sendRaw,
    onApprovalRequest(callback: (request: Record<string, unknown>) => void) {
      approvalRequestListeners.add(callback)
      return () => approvalRequestListeners.delete(callback)
    },
    onApprovalWire(callback: (wire: Record<string, unknown>) => void) {
      approvalWireListeners.add(callback)
      return () => approvalWireListeners.delete(callback)
    },
    onReconnect(callback: () => void) {
      reconnectListeners.add(callback)
      return () => reconnectListeners.delete(callback)
    },
  }
  const state = {
    pendingApprovals,
    pendingToolApprovals: pendingApprovals,
  }
  const dependencies = {
    ...state,
    state,
    ws: globalWebSocket,
    websocket: globalWebSocket,
    approvalCleanup: ref(null),
    approvalTransport:
      options.includeApprovalTransport === false
        ? undefined
        : { sendApprovalResponse: ownerSendApprovalResponse },
  }
  const factory = (approvalModule as Record<string, unknown>).createChatApprovalController as (
    ...args: unknown[]
  ) => Record<string, unknown>
  const controller =
    factory.length >= 2
      ? factory(state, globalWebSocket, dependencies.approvalTransport)
      : factory(dependencies)

  const storePendingApproval =
    controller.storePendingApproval ??
    controller.handleApprovalRequest ??
    controller.handleToolApprovalRequest
  if (typeof storePendingApproval !== 'function') {
    throw new Error('Chat approval controller has no request registration method')
  }
  const respondApproval = controller.respondApproval
  if (typeof respondApproval !== 'function') {
    throw new Error('Chat approval controller has no response method')
  }
  const storeApprovalTerminal = controller.storeApprovalTerminal
  if (typeof storeApprovalTerminal !== 'function') {
    throw new Error('Chat approval controller has no terminal registration method')
  }
  const initApprovalListener = controller.initApprovalListener
  if (typeof initApprovalListener !== 'function') {
    throw new Error('Chat approval controller has no approval listener initializer')
  }
  const clearPendingApprovalsForSession = controller.clearPendingApprovalsForSession
  if (typeof clearPendingApprovalsForSession !== 'function') {
    throw new Error('Chat approval controller has no session approval cleanup method')
  }

  return {
    pendingApprovals,
    globalSendApprovalResponse,
    ownerSendApprovalResponse,
    sendRaw,
    store(request: Record<string, unknown>) {
      return storePendingApproval.call(controller, request)
    },
    respond(requestId: string, approved: boolean, remember: boolean) {
      return respondApproval.call(controller, requestId, approved, remember)
    },
    terminal(terminal: RedApprovalTerminal) {
      return storeApprovalTerminal.call(controller, terminal)
    },
    init() {
      return initApprovalListener.call(controller)
    },
    request(request: Record<string, unknown>) {
      approvalRequestListeners.forEach((listener) => listener(request))
    },
    wire(wire: Record<string, unknown>) {
      approvalWireListeners.forEach((listener) => listener(wire))
    },
    reconnect() {
      reconnectListeners.forEach((listener) => listener())
    },
    clearSession(sessionId: string) {
      return clearPendingApprovalsForSession.call(controller, sessionId)
    },
  }
}

function redApprovalTerminal(overrides: Partial<RedApprovalTerminal> = {}): RedApprovalTerminal {
  return {
    type: 'tool_approval_terminal',
    request_id: 'approval-request-1',
    session_id: 'session-1',
    owner_id: 'desktop-user',
    invocation_id: 'invocation-1',
    arguments_digest: 'a'.repeat(64),
    security_scope_digest: 'b'.repeat(64),
    scope_schema_version: 1,
    terminal_result: 'expired',
    deadline_at: '2026-07-29T04:01:00.000Z',
    ...overrides,
  }
}

describe('chat approval transport lifecycle RED contract', () => {
  it.each([
    ['owner_id', { ownerId: undefined }],
    ['session_id', { sessionId: undefined }],
    ['invocation_id', { invocationId: undefined }],
    ['arguments_digest', { argumentsDigest: undefined }],
    ['security_scope_digest', { securityScopeDigest: undefined }],
    ['scope_schema_version', { scopeSchemaVersion: 0 }],
    ['deadline_at', { deadlineAt: undefined }],
  ] as const)(
    'fails closed without a pending card, decision, or reconcile wire when %s is missing',
    async (_field, overrides) => {
      const harness = await createRedApprovalHarness()
      harness.init()
      harness.request(redApprovalRequest(overrides))

      expect(harness.pendingApprovals.value).toEqual({})

      harness.reconnect()
      await expect(
        Promise.resolve(harness.respond('approval-request-1', true, true)),
      ).resolves.toBeUndefined()

      expect(harness.sendRaw).not.toHaveBeenCalled()
      expect(harness.ownerSendApprovalResponse).not.toHaveBeenCalled()
      expect(harness.globalSendApprovalResponse).not.toHaveBeenCalled()
    },
  )

  it('sends the decision through the owning request transport, not the global websocket', async () => {
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest())

    await Promise.resolve(harness.respond('approval-request-1', true, false))

    expect(harness.ownerSendApprovalResponse).toHaveBeenCalledTimes(1)
    expect(harness.globalSendApprovalResponse).not.toHaveBeenCalled()
  })

  it('retains the pending request until the matching acknowledgement arrives', async () => {
    const acknowledgement = redDeferred<RedApprovalAck>()
    const harness = await createRedApprovalHarness(() => acknowledgement.promise)
    harness.store(redApprovalRequest())

    const response = Promise.resolve(harness.respond('approval-request-1', true, false))
    await Promise.resolve()

    expect(harness.ownerSendApprovalResponse).toHaveBeenCalledTimes(1)
    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
    const decision = harness.ownerSendApprovalResponse.mock.calls[0]?.[0] as RedApprovalDecision

    acknowledgement.resolve(redApprovalAcknowledgement(decision))
    await response

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
  })

  it('contains an expected owner-transport rejection and retains the pending request', async () => {
    const harness = await createRedApprovalHarness(() =>
      Promise.reject(new Error('Owning approval request socket is not connected')),
    )
    harness.store(redApprovalRequest())

    await expect(
      Promise.resolve(harness.respond('approval-request-1', false, false)),
    ).resolves.toBeUndefined()

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
  })

  it('contains a socket send failure and retains the pending request', async () => {
    const harness = await createRedApprovalHarness(() =>
      Promise.reject(new Error('Owning approval request socket send failed')),
    )
    harness.store(redApprovalRequest())

    await expect(
      Promise.resolve(harness.respond('approval-request-1', false, false)),
    ).resolves.toBeUndefined()

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
  })

  it.each([
    {
      label: 'a mismatched acknowledgement',
      acknowledgement: (decision: RedApprovalDecision) =>
        redApprovalAcknowledgement(decision, { request_id: 'other-request' }),
    },
    {
      label: 'an acknowledgement with an unsupported status',
      acknowledgement: (decision: RedApprovalDecision) =>
        redApprovalAcknowledgement(decision, { status: 'unknown' as unknown as 'accepted' }),
    },
  ])(
    'contains $label, retains pending, and reuses the same decision',
    async ({ acknowledgement }) => {
      const harness = await createRedApprovalHarness((decision) =>
        Promise.resolve(acknowledgement(decision) as RedApprovalAck),
      )
      harness.store(redApprovalRequest())

      await expect(
        Promise.resolve(harness.respond('approval-request-1', true, false)),
      ).resolves.toBeUndefined()

      expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
      const first = harness.ownerSendApprovalResponse.mock.calls[0]?.[0] as RedApprovalDecision

      await expect(
        Promise.resolve(harness.respond('approval-request-1', true, false)),
      ).resolves.toBeUndefined()

      const second = harness.ownerSendApprovalResponse.mock.calls[1]?.[0] as RedApprovalDecision
      expect(second.decision_id).toBe(first.decision_id)
      expect(second.idempotency_key).toBe(first.idempotency_key)
    },
  )

  it.each([
    ['session_id', { session_id: 'other-session' }],
    ['owner_id', { owner_id: 'other-owner' }],
    ['invocation_id', { invocation_id: 'other-invocation' }],
    ['arguments_digest', { arguments_digest: 'c'.repeat(64) }],
    ['security_scope_digest', { security_scope_digest: 'd'.repeat(64) }],
    ['scope_schema_version', { scope_schema_version: 2 }],
  ] as const)(
    'retains pending when the owner acknowledgement mismatches %s',
    async (_field, overrides) => {
      const harness = await createRedApprovalHarness((decision) =>
        Promise.resolve(redApprovalAcknowledgement(decision, overrides)),
      )
      harness.store(redApprovalRequest())

      await expect(
        Promise.resolve(harness.respond('approval-request-1', true, false)),
      ).resolves.toBeUndefined()

      expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
    },
  )

  it.each(['expired', 'fenced'] as const)(
    'clears a pending card only for a complete matching backend %s terminal identity',
    async (terminalResult) => {
      const harness = await createRedApprovalHarness()
      harness.store(redApprovalRequest())

      harness.terminal(
        redApprovalTerminal({
          terminal_result: terminalResult,
          // deadline_at 是传输上下文，不属于七项身份字段。
          deadline_at: '2026-07-29T04:01:05.000Z',
        }),
      )

      expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
      expect(harness.ownerSendApprovalResponse).not.toHaveBeenCalled()
      expect(harness.globalSendApprovalResponse).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['request_id', { request_id: 'different-request' }],
    ['session_id', { session_id: 'different-session' }],
    ['owner_id', { owner_id: 'different-owner' }],
    ['invocation_id', { invocation_id: 'different-invocation' }],
    ['arguments_digest', { arguments_digest: 'c'.repeat(64) }],
    ['security_scope_digest', { security_scope_digest: 'd'.repeat(64) }],
    ['scope_schema_version', { scope_schema_version: 2 }],
  ] as const)('ignores a backend terminal with mismatched %s', async (_field, overrides) => {
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest())

    harness.terminal(redApprovalTerminal(overrides))

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
  })

  it.each([
    ['request_id', { requestId: '' }, { request_id: '' }],
    ['session_id', { sessionId: undefined }, { session_id: undefined }],
    ['owner_id', { ownerId: undefined }, { owner_id: undefined }],
    ['invocation_id', { invocationId: undefined }, { invocation_id: undefined }],
    ['arguments_digest', { argumentsDigest: undefined }, { arguments_digest: undefined }],
    [
      'security_scope_digest',
      { securityScopeDigest: undefined },
      { security_scope_digest: undefined },
    ],
    ['scope_schema_version', { scopeSchemaVersion: 0 }, { scope_schema_version: 0 }],
  ] as const)(
    'does not clear a pending card when terminal identity is incomplete at %s',
    async (_field, _request, terminal) => {
      const harness = await createRedApprovalHarness()
      harness.store(redApprovalRequest())
      harness.terminal(redApprovalTerminal(terminal as Partial<RedApprovalTerminal>))

      expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
    },
  )

  it('reuses one stable decision_id when retrying the same user decision', async () => {
    let attempt = 0
    const harness = await createRedApprovalHarness((decision) => {
      attempt += 1
      if (attempt === 1) {
        return Promise.reject(new Error('Owning approval request socket is not connected'))
      }
      return Promise.resolve(redApprovalAcknowledgement(decision))
    })
    harness.store(redApprovalRequest())

    await Promise.resolve(harness.respond('approval-request-1', true, false)).catch(() => undefined)
    await Promise.resolve(harness.respond('approval-request-1', true, false))

    expect(harness.ownerSendApprovalResponse).toHaveBeenCalledTimes(2)
    const first = harness.ownerSendApprovalResponse.mock.calls[0]?.[0] as RedApprovalDecision
    const second = harness.ownerSendApprovalResponse.mock.calls[1]?.[0] as RedApprovalDecision
    expect(first.decision_id).toEqual(expect.any(String))
    expect(second.decision_id).toBe(first.decision_id)
    expect(first.idempotency_key).toEqual(expect.any(String))
    expect(second.idempotency_key).toBe(first.idempotency_key)
    expect(first.decision).toBe('approved_once')
    expect(second.decision).toBe('approved_once')
  })

  it.each([
    { approved: true, remember: false, expected: 'approved_once' },
    { approved: true, remember: true, expected: 'approved_remember' },
    { approved: false, remember: true, expected: 'denied' },
  ] as const)(
    'maps approved=$approved remember=$remember to canonical $expected',
    async ({ approved, remember, expected }) => {
      const harness = await createRedApprovalHarness()
      harness.store(redApprovalRequest())

      await Promise.resolve(harness.respond('approval-request-1', approved, remember))

      const decision = harness.ownerSendApprovalResponse.mock.calls[0]?.[0] as RedApprovalDecision
      expect(decision.decision).toBe(expected)
      expect(decision.idempotency_key).toEqual(expect.any(String))
    },
  )

  it('treats an identical duplicate request as a no-op without resetting its deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-29T04:00:00.000Z'))
    try {
      const harness = await createRedApprovalHarness()
      const request = redApprovalRequest()
      harness.store(request)
      const original = harness.pendingApprovals.value['approval-request-1']

      await vi.advanceTimersByTimeAsync(5_000)
      harness.store({ ...request })

      const duplicate = harness.pendingApprovals.value['approval-request-1']
      expect(duplicate).toBe(original)
      expect(duplicate?.deadlineAt).toBe('2026-07-29T04:01:00.000Z')
      expect(duplicate?.receivedAt).toBe(original?.receivedAt)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the original request when a duplicate id carries conflicting data', async () => {
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest())
    const original = harness.pendingApprovals.value['approval-request-1']

    harness.store(
      redApprovalRequest({
        toolName: 'shell.exec',
        deadlineAt: '2026-07-29T04:02:00.000Z',
      }),
    )

    const stored = harness.pendingApprovals.value['approval-request-1']
    expect(stored).toBe(original)
    expect(stored?.toolName).toBe('filesystem.write')
    expect(stored?.deadlineAt).toBe('2026-07-29T04:01:00.000Z')
  })

  it('sends one exact reconciliation query for every complete visible pending approval after global reconnect', async () => {
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest())
    harness.store(
      redApprovalRequest({
        requestId: 'approval-request-2',
        sessionId: 'session-2',
        invocationId: 'invocation-2',
        argumentsDigest: 'c'.repeat(64),
        securityScopeDigest: 'd'.repeat(64),
      }),
    )
    harness.init()
    harness.sendRaw.mockClear()

    harness.reconnect()

    expect(harness.sendRaw.mock.calls.map(([wire]) => wire)).toEqual([
      {
        type: 'tool_approval_reconcile',
        request_id: 'approval-request-1',
        session_id: 'session-1',
        owner_id: 'desktop-user',
        invocation_id: 'invocation-1',
        arguments_digest: 'a'.repeat(64),
        security_scope_digest: 'b'.repeat(64),
        scope_schema_version: 1,
        deadline_at: '2026-07-29T04:01:00.000Z',
      },
      {
        type: 'tool_approval_reconcile',
        request_id: 'approval-request-2',
        session_id: 'session-2',
        owner_id: 'desktop-user',
        invocation_id: 'invocation-2',
        arguments_digest: 'c'.repeat(64),
        security_scope_digest: 'd'.repeat(64),
        scope_schema_version: 1,
        deadline_at: '2026-07-29T04:01:00.000Z',
      },
    ])
  })

  it('retains a disconnected request decision through reconnect until the exact expired terminal arrives', async () => {
    const disconnectedResponder = vi.fn(() =>
      Promise.reject(new Error('Owning approval request socket is not connected')),
    )
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest({ respondApproval: disconnectedResponder }))

    await expect(
      Promise.resolve(harness.respond('approval-request-1', true, false)),
    ).resolves.toBeUndefined()
    harness.init()
    harness.sendRaw.mockClear()

    harness.reconnect()

    expect(harness.sendRaw).toHaveBeenCalledWith({
      type: 'tool_approval_reconcile',
      request_id: 'approval-request-1',
      session_id: 'session-1',
      owner_id: 'desktop-user',
      invocation_id: 'invocation-1',
      arguments_digest: 'a'.repeat(64),
      security_scope_digest: 'b'.repeat(64),
      scope_schema_version: 1,
      deadline_at: '2026-07-29T04:01:00.000Z',
    })
    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)

    harness.wire(redApprovalTerminal({ terminal_result: 'expired' }))

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
  })

  it('replays one saved decision to the recovered request socket with its stable identity and idempotency key', async () => {
    const disconnectedResponder = vi.fn<(decision: RedApprovalDecision) => Promise<RedApprovalAck>>(
      () => Promise.reject(new Error('Owning approval request socket is not connected')),
    )
    const recoveredAcknowledgement = redDeferred<RedApprovalAck>()
    const recoveredResponder = vi.fn<(decision: RedApprovalDecision) => Promise<RedApprovalAck>>(
      () => recoveredAcknowledgement.promise,
    )
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest({ respondApproval: disconnectedResponder }))

    await expect(
      Promise.resolve(harness.respond('approval-request-1', true, true)),
    ).resolves.toBeUndefined()
    const savedDecision = disconnectedResponder.mock.calls[0]?.[0]
    if (!savedDecision) throw new Error('Disconnected responder did not receive a saved decision')

    harness.init()
    harness.reconnect()
    harness.request(redApprovalRequest({ respondApproval: recoveredResponder }))
    await Promise.resolve()
    await Promise.resolve()

    expect(recoveredResponder).toHaveBeenCalledTimes(1)
    const replayedDecision = recoveredResponder.mock.calls[0]?.[0]
    if (!replayedDecision) throw new Error('Recovered responder did not receive the saved decision')
    expect(replayedDecision).toMatchObject({
      request_id: savedDecision.request_id,
      invocation_id: savedDecision.invocation_id,
      arguments_digest: savedDecision.arguments_digest,
      security_scope_digest: savedDecision.security_scope_digest,
      decision_id: savedDecision.decision_id,
      idempotency_key: savedDecision.idempotency_key,
    })
    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)

    const replayCompletion = Promise.resolve(harness.respond('approval-request-1', true, true))
    recoveredAcknowledgement.resolve(redApprovalAcknowledgement(replayedDecision))
    await expect(replayCompletion).resolves.toMatchObject({
      request_id: 'approval-request-1',
      decision_id: savedDecision.decision_id,
      idempotency_key: savedDecision.idempotency_key,
      status: 'accepted',
    })

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
  })

  it('replays a saved decision through the recovered global socket when its pending wire has no request-socket responder', async () => {
    const disconnectedResponder = vi.fn<(decision: RedApprovalDecision) => Promise<RedApprovalAck>>(
      () => Promise.reject(new Error('Owning approval request socket is not connected')),
    )
    const harness = await createRedApprovalHarness(undefined, { includeApprovalTransport: false })
    harness.store(redApprovalRequest({ respondApproval: disconnectedResponder }))

    await expect(
      Promise.resolve(harness.respond('approval-request-1', true, true)),
    ).resolves.toBeUndefined()
    const savedDecision = disconnectedResponder.mock.calls[0]?.[0]
    if (!savedDecision) throw new Error('Disconnected responder did not receive a saved decision')

    harness.init()
    harness.sendRaw.mockClear()
    harness.reconnect()
    harness.request(redApprovalRequest())
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.sendRaw.mock.calls.map(([wire]) => wire)).toContainEqual({
      type: 'tool_approval_response',
      content: 'approved_remember',
      request_id: 'approval-request-1',
      session_id: 'session-1',
      owner_id: 'desktop-user',
      decision_id: savedDecision.decision_id,
      invocation_id: 'invocation-1',
      arguments_digest: 'a'.repeat(64),
      security_scope_digest: 'b'.repeat(64),
      scope_schema_version: 1,
      deadline_at: '2026-07-29T04:01:00.000Z',
      metadata: {
        request_id: 'approval-request-1',
        session_id: 'session-1',
        owner_id: 'desktop-user',
        decision_id: savedDecision.decision_id,
        invocation_id: 'invocation-1',
        decision: 'approved_remember',
        idempotency_key: savedDecision.idempotency_key,
        arguments_digest: 'a'.repeat(64),
        security_scope_digest: 'b'.repeat(64),
        scope_schema_version: '1',
        deadline_at: '2026-07-29T04:01:00.000Z',
      },
    })

    harness.wire(redApprovalAcknowledgement(savedDecision))

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
  })

  it.each([
    ['owner identity', { ownerId: undefined }],
    ['deadline', { deadlineAt: undefined }],
  ] as const)(
    'does not store or reconcile a malformed pending approval missing %s',
    async (_field, overrides) => {
      const harness = await createRedApprovalHarness()
      harness.store(redApprovalRequest(overrides))
      harness.init()
      harness.sendRaw.mockClear()

      harness.reconnect()

      expect(harness.sendRaw).not.toHaveBeenCalled()
      expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
    },
  )

  it.each([
    ['approved_once', 'accepted'],
    ['denied', 'accepted'],
  ] as const)(
    'clears only an exact durable %s reconciliation acknowledgement',
    async (decision, status) => {
      const harness = await createRedApprovalHarness()
      harness.store(redApprovalRequest())
      harness.init()

      harness.wire({
        type: 'tool_approval_ack',
        request_id: 'approval-request-1',
        session_id: 'session-1',
        owner_id: 'desktop-user',
        invocation_id: 'invocation-1',
        arguments_digest: 'a'.repeat(64),
        security_scope_digest: 'b'.repeat(64),
        scope_schema_version: 1,
        decision_id: `decision-${decision}`,
        decision,
        idempotency_key: `idempotency-${decision}`,
        status,
      })

      expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
    },
  )

  it('retains pending for a reconciliation acknowledgement with a nonterminal status or mismatched identity', async () => {
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest())
    harness.init()

    harness.wire({
      type: 'tool_approval_ack',
      request_id: 'approval-request-1',
      session_id: 'session-1',
      owner_id: 'desktop-user',
      invocation_id: 'invocation-1',
      arguments_digest: 'a'.repeat(64),
      security_scope_digest: 'b'.repeat(64),
      scope_schema_version: 1,
      decision_id: 'decision-1',
      decision: 'approved_once',
      idempotency_key: 'idempotency-1',
      status: 'rejected',
    })
    harness.wire({
      type: 'tool_approval_ack',
      request_id: 'approval-request-1',
      session_id: 'session-1',
      owner_id: 'other-owner',
      invocation_id: 'invocation-1',
      arguments_digest: 'a'.repeat(64),
      security_scope_digest: 'b'.repeat(64),
      scope_schema_version: 1,
      decision_id: 'decision-1',
      decision: 'approved_once',
      idempotency_key: 'idempotency-1',
      status: 'accepted',
    })

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
  })

  it('consumes a complete matching terminal reconciliation wire but not pending absence', async () => {
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest())
    harness.init()

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(true)
    harness.wire(redApprovalTerminal())

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
  })

  it('clears only the deleted session approval projection through the canonical controller exit', async () => {
    const harness = await createRedApprovalHarness()
    harness.store(redApprovalRequest())
    harness.store(
      redApprovalRequest({
        requestId: 'approval-request-2',
        sessionId: 'session-2',
        invocationId: 'invocation-2',
        argumentsDigest: 'c'.repeat(64),
        securityScopeDigest: 'd'.repeat(64),
      }),
    )

    harness.clearSession('session-1')

    expect(Boolean(harness.pendingApprovals.value['approval-request-1'])).toBe(false)
    expect(Boolean(harness.pendingApprovals.value['approval-request-2'])).toBe(true)
  })
})
