import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import { createChatStreamStateController } from '../chat-stream-state'
import { createChatSendWebSocketDeliveryController } from '../chat-send-websocket-delivery'
import { DEGENERATION_NOTICE, isDegenerateTail, trimDegenerateTail } from '@/utils/degeneration'

/**
 * BUG-20260625 模型「失控复读塌缩」退化熔断 —— delivery 层端到端集成测试。
 *
 * 既有覆盖只到纯函数层（utils/degeneration.test.ts 15 测试测 isDegenerateTail/trimDegenerateTail）。
 * 本文件补上真正缺口：把**真实** updateStreamChunk（chat-stream-state）接进**真实** deliverViaWebSocket
 * （chat-send-websocket-delivery），喂一个退化 chunk，断言完整 wire：
 *   退化检测 → cancel 后端流（省 token/停转圈）→ 用「冻结的裁剪+提示」内容定稿（绝不用后端整堵复读墙）。
 * 覆盖 done resolve 与 done reject（cancel 致 reject）两条定稿路径，外加干净路径反证不误触发。
 */

// 一段「干净正文 + 失控复读尾」：period=4 的 "5861" 连复 30 次 = 120 字符 ≥ minRun(48) → 必命中。
const CLEAN_PREFIX = '计算如下：结果是'
const WALL = '5861'.repeat(30)
const DEGENERATE = CLEAN_PREFIX + WALL

// 自检：构造的串确实被检测器判为退化（钉死前提，避免哪天默认阈值改了静默失效）。
const FROZEN = trimDegenerateTail(DEGENERATE) + DEGENERATION_NOTICE

function wire(sessionId = 's1') {
  const activeStreams = ref<Record<string, import('../chat-stream-helpers').SessionStreamState>>({})
  const streamHandles = new Map<string, import('@/services/chatService').WebSocketStreamHandle>()
  const finalizeAssistantMessage = vi.fn((p: { content: string; reasoning?: string }) => ({
    id: 'assistant-1',
    role: 'assistant' as const,
    content: p.content,
    reasoning: p.reasoning,
    timestamp: '2026-06-25',
  } as ChatMessage))

  // 真实 stream-state 控制器：提供真正的 updateStreamChunk / upsertStreamState / setSessionPending / resetSessionStream。
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
  const done = new Promise<any>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  const handle = { cancel, done } as any

  const chatSvc = {
    ChatRequestError: class ChatRequestError extends Error {
      noFallback = false
    },
    openWebSocketStream: vi.fn((_text, _sessionId, _params, _role, _attachments, callbacks) => {
      capturedOnChunk = callbacks.onChunk
      return handle
    }),
  }

  const controller = createChatSendWebSocketDeliveryController({
    // 退化熔断与模型无关（纯客户端兜底），故用中性占位，不写具体测试模型名。
    chatParams: ref({ provider: 'test-provider', model: 'test-model' }),
    agentRole: ref(''),
    activeStreams,
    chatSvc: chatSvc as any,
    isSessionCancelled: vi.fn().mockReturnValue(false),
    setSessionPending: streamState.setSessionPending,
    upsertStreamState: streamState.upsertStreamState,
    updateStreamChunk: streamState.updateStreamChunk,
    resetSessionStream: streamState.resetSessionStream,
    finalizeAssistantMessage: finalizeAssistantMessage as any,
    handleSendError: vi.fn(),
    storePendingApproval: vi.fn(),
    streamHandles,
  })

  return {
    sessionId,
    controller,
    activeStreams,
    finalizeAssistantMessage,
    cancel,
    getOnChunk: () => capturedOnChunk,
    resolveDone,
    rejectDone,
  }
}

describe('BUG-20260625 退化熔断 · delivery 层端到端', () => {
  it('自检：构造的「正文+复读尾」确实被检测器判为退化', () => {
    expect(isDegenerateTail(DEGENERATE)).toBe(true)
    expect(isDegenerateTail(CLEAN_PREFIX)).toBe(false)
    // 冻结内容 = 干净正文 + 一小段样例 + 提示，绝不含整堵墙
    expect(FROZEN).toContain(CLEAN_PREFIX)
    expect(FROZEN).toContain(DEGENERATION_NOTICE)
    expect(FROZEN).not.toContain('5861'.repeat(10))
    expect(FROZEN.length).toBeLessThan(DEGENERATE.length)
  })

  it('done resolve：退化 chunk → cancel 后端流 → 用冻结内容定稿（不用整堵墙）', async () => {
    const w = wire()
    const resultPromise = w.controller.deliverViaWebSocket({
      backendText: '帮我算一下',
      sessionId: w.sessionId,
      requestId: 'req-1',
      sending: ref(false),
      draftSending: ref(false),
    })

    // 同步部分已跑完：openWebSocketStream 已调、handle 已入 streamHandles、回调已捕获。
    const onChunk = w.getOnChunk()
    expect(onChunk).toBeTypeOf('function')

    // 退化 chunk 到达 → 触发熔断 → cancel 后端流。
    onChunk!(DEGENERATE)
    expect(w.cancel).toHaveBeenCalledTimes(1)
    expect(w.activeStreams.value[w.sessionId]?.degenerated).toBe(true)

    // 二次复读 chunk：已冻结 → 不再 cancel、墙不再长（幂等）。
    onChunk!('5861'.repeat(30))
    expect(w.cancel).toHaveBeenCalledTimes(1)
    expect(w.activeStreams.value[w.sessionId]?.content).toBe(FROZEN)

    // 后端流即便最终回传整堵复读墙，定稿也必须用冻结内容，而非 result.content。
    w.resolveDone({ content: DEGENERATE, metadata: { backend_message_id: 'm1' }, toolCalls: [] })
    const finalized = (await resultPromise) as ChatMessage | null

    expect(w.finalizeAssistantMessage).toHaveBeenCalledTimes(1)
    expect(w.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: w.sessionId, content: FROZEN }),
    )
    expect(finalized?.content).toBe(FROZEN)
    expect(finalized?.content).not.toContain('5861'.repeat(10))
  })

  it('done reject（cancel 致 reject）：catch 分支仍用冻结内容定稿，不当错误/不回退', async () => {
    const w = wire()
    const resultPromise = w.controller.deliverViaWebSocket({
      backendText: '帮我算一下',
      sessionId: w.sessionId,
      requestId: 'req-1',
      sending: ref(false),
      draftSending: ref(false),
    })

    const onChunk = w.getOnChunk()
    onChunk!(DEGENERATE)
    expect(w.cancel).toHaveBeenCalledTimes(1)

    // cancel 使 done reject（如底层把 cancel 实现为 abort/reject）。
    w.rejectDone(new Error('stream aborted by client'))
    const finalized = (await resultPromise) as ChatMessage | null

    // 不返回 fallback / 不报错，照样用冻结内容定稿。
    expect(w.finalizeAssistantMessage).toHaveBeenCalledTimes(1)
    expect(w.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: w.sessionId, content: FROZEN }),
    )
    expect(finalized?.content).toBe(FROZEN)
  })

  it('干净输出：不误触发熔断，正常用 result.content 定稿', async () => {
    const w = wire()
    const resultPromise = w.controller.deliverViaWebSocket({
      backendText: '你好',
      sessionId: w.sessionId,
      requestId: 'req-1',
      sending: ref(false),
      draftSending: ref(false),
    })

    const onChunk = w.getOnChunk()
    onChunk!('你好，今天天气不错，有什么可以帮你的？')
    expect(w.cancel).not.toHaveBeenCalled()
    expect(w.activeStreams.value[w.sessionId]?.degenerated).toBeFalsy()

    w.resolveDone({ content: '你好，今天天气不错，有什么可以帮你的？', metadata: {}, toolCalls: [] })
    const finalized = (await resultPromise) as ChatMessage | null

    expect(w.finalizeAssistantMessage).toHaveBeenCalledTimes(1)
    expect(finalized?.content).toBe('你好，今天天气不错，有什么可以帮你的？')
  })
})
