import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import { createChatStreamStateController } from '../chat-stream-state'
import { createChatStreamRecoveryController } from '../chat-stream-recovery'
import { DEGENERATION_NOTICE, trimDegenerateTail } from '@/utils/degeneration'

/**
 * BUG-20260625 R3 M-1（AP-007 多路径只接一条）：退化「失控复读」熔断的 freeze→用冻结内容定稿 + cancel
 * 守卫只接 live 投递路径（chat-send-websocket-delivery.ts），漏接 **recovery/resume 路径**
 * （chat-stream-recovery.ts：app 重载/重连后恢复后台流）。
 * 后果：恢复的退化流完成时定稿用 `result.content`（后端整堵复读墙）胜出，且 onChunk 不 cancel → 熔断在该入口失效。
 *
 * 真实接线取证：把真实 updateStreamChunk(chat-stream-state) 接进真实 recovery 控制器，
 * 喂退化 chunk，断言定稿用冻结内容（非整堵墙）且触发 cancel。
 */
const CLEAN_PREFIX = '计算如下：结果是'
const WALL = '5861'.repeat(30)
const DEGENERATE = CLEAN_PREFIX + WALL
const FROZEN = trimDegenerateTail(DEGENERATE) + DEGENERATION_NOTICE

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
  const done = new Promise<any>((res) => { resolveDone = res })
  const handle = { cancel, done } as any

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
    handleSendError: vi.fn(),
  })

  return { sessionId, controller, activeStreams, finalizeAssistantMessage, cancel, getOnChunk: () => capturedOnChunk, resolveDone }
}

describe('BUG-20260625 R3 M-1 退化熔断 · recovery/resume 路径', () => {
  it('恢复的退化流：onChunk 触发 cancel + 定稿用冻结内容（不用整堵复读墙）', async () => {
    const w = wire()
    await w.controller.recoverActiveStreams(ref(false), ref(false))

    const onChunk = w.getOnChunk()
    expect(onChunk).toBeTypeOf('function')

    onChunk!(DEGENERATE)
    // 熔断后应 cancel 后端流（与 live 路径一致）
    expect(w.cancel).toHaveBeenCalledTimes(1)
    expect(w.activeStreams.value[w.sessionId]?.degenerated).toBe(true)

    // 后端最终回传整堵墙，定稿必须用冻结内容
    w.resolveDone({ content: DEGENERATE, metadata: {}, toolCalls: [] })
    await Promise.resolve(); await Promise.resolve()

    expect(w.finalizeAssistantMessage).toHaveBeenCalledTimes(1)
    expect(w.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: w.sessionId, content: FROZEN }),
    )
    const finalized = w.finalizeAssistantMessage.mock.results[0]!.value as ChatMessage
    expect(finalized.content).not.toContain('5861'.repeat(10))
  })
})
