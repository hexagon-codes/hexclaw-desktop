import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import { createChatStreamStateController } from '../chat-stream-state'
import { createChatStreamRecoveryController } from '../chat-stream-recovery'

/** 恢复流沿后台真实终态和正文收口，不能由展示保护改为取消或裁写终稿。 */
const CLEAN_PREFIX = '计算如下：结果是'
const WALL = '5861'.repeat(30)
const DEGENERATE = CLEAN_PREFIX + WALL

function wire(sessionId = 's-rec') {
  const activeStreams = ref<Record<string, import('../chat-stream-helpers').SessionStreamState>>({})
  const streamHandles = new Map<string, import('@/services/chatService').WebSocketStreamHandle>()
  const finalizeAssistantMessage = vi.fn((p: { content: string }) => ({
    id: 'assistant-rec',
    role: 'assistant' as const,
    content: p.content,
    timestamp: '2026-06-25',
  } as ChatMessage))

  const streamState = createChatStreamStateController({
    activeStreams,
    pendingSessionIds: ref({}),
    currentSessionId: ref<string | null>(sessionId),
    messages: ref([]),
    streaming: ref(false),
    streamingSessionId: ref<string | null>(null),
    streamingContent: ref(''),
    streamingReasoning: ref(''),
    streamingReasoningStartTime: ref(0),
    streamingReasoningEndTime: ref(0),
    msgSvc: { persistMessage: vi.fn() } as any,
    streamHandles,
  })

  let capturedOnChunk: ((content?: string, reasoning?: string) => void) | undefined
  const cancel = vi.fn()
  let resolveDone!: (value: any) => void
  let rejectDone!: (reason: unknown) => void
  const done = new Promise<any>((res, rej) => { resolveDone = res; rejectDone = rej })
  const handle = { cancel, done } as any

  const handleSendError = vi.fn()
  const controller = createChatStreamRecoveryController({
    activeStreams,
    streamHandles,
    chatSvc: {
      resumeWebSocketStream: vi.fn((_sessionId, _requestId, callbacks) => {
        capturedOnChunk = callbacks.onChunk
        return handle
      }),
    } as any,
    logger: { warn: vi.fn() } as any,
    storePendingApproval: vi.fn(),
    listActiveStreams: vi.fn().mockResolvedValue({
      streams: [{ session_id: sessionId, request_id: 'req-rec', content: '', reasoning: '', done: false }],
      total: 1,
    }) as any,
    isSessionCancelled: vi.fn().mockReturnValue(false),
    seedRecoveredStream: streamState.seedRecoveredStream,
    updateStreamChunk: streamState.updateStreamChunk,
    finalizeAssistantMessage: finalizeAssistantMessage as any,
    resetSessionStream: streamState.resetSessionStream,
    handleSendError,
  })

  return { sessionId, controller, activeStreams, finalizeAssistantMessage, cancel, getOnChunk: () => capturedOnChunk, resolveDone, rejectDone, streamHandles, handleSendError }
}

describe('BUG-20260625 R3 M-1 退化熔断 · recovery/resume 路径', () => {
  it('恢复旧句柄的迟到失败不能清掉新句柄', async () => {
    const w = wire()
    await w.controller.recoverActiveStreams(ref(false), ref(false))
    const replacement = { cancel: vi.fn(), done: new Promise<null>(() => {}) }
    w.streamHandles.set(w.sessionId, replacement)
    w.rejectDone(new Error('old failure'))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(w.streamHandles.get(w.sessionId)).toBe(replacement)
    expect(w.handleSendError).not.toHaveBeenCalled()
  })
  it('恢复的重复输出保留后台原文且不请求取消', async () => {
    const w = wire()
    await w.controller.recoverActiveStreams(ref(false), ref(false))

    const onChunk = w.getOnChunk()
    expect(onChunk).toBeTypeOf('function')

    onChunk!(DEGENERATE)
    // 展示检测不能派发后台控制请求。
    expect(w.cancel).not.toHaveBeenCalled()
    expect(w.activeStreams.value[w.sessionId]?.degenerated).toBe(true)

    // 后台终稿保持完整原文。
    w.resolveDone({ content: DEGENERATE, metadata: {}, toolCalls: [] })
    await Promise.resolve(); await Promise.resolve()

    expect(w.finalizeAssistantMessage).toHaveBeenCalledTimes(1)
    expect(w.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: w.sessionId, content: DEGENERATE }),
    )
    const finalized = w.finalizeAssistantMessage.mock.results[0]!.value as ChatMessage
    expect(finalized.content).toBe(DEGENERATE)
  })
})
