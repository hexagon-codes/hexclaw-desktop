import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import { createChatStreamCompletionController } from '../chat-stream-completion'
import type { SessionStreamState } from '../chat-stream-helpers'

/**
 * BUG-20260703 B3（桌面链路深测锁）：思考时长的双源竞争与回退。
 *
 * 后端修复后 done chunk metadata 携带 thinking_duration（字符串）。桌面 finalize：
 *  - 本地流计时可用（reasoningStartTime>0）→ 用本地实测覆盖（更贴近用户观感）；
 *  - 本地计时缺失（如 provider 的 reasoning 未走增量、恢复流等）→ 必须保留后端值，
 *    不得把它抹掉——否则「A2 读回」修复在 live finalize 一刻就没数据可读。
 * 渲染端 formatThinkingDuration 用 Number() 归一，字符串安全。
 */
function buildController(streamState: SessionStreamState | null, appendMessageToSession: (sessionId: string, message: ChatMessage) => void) {
  return createChatStreamCompletionController({
    activeStreams: ref<Record<string, SessionStreamState>>(
      streamState ? { s1: streamState } : {},
    ),
    pendingSuggestedTitleExpectation: ref({}),
    pendingAutoTitleSync: new Map(),
    currentSessionId: ref('s1'),
    msgSvc: {
      touchSession: vi.fn().mockResolvedValue(undefined),
      suggestSessionTitle: vi.fn().mockResolvedValue({ updated: false }),
    } as never,
    createId: () => 'assistant-b3',
    loadSessions: vi.fn().mockResolvedValue(undefined),
    setLocalSessionTitle: vi.fn(),
    setPendingSuggestedTitleExpectation: vi.fn(),
    bumpLocalSession: vi.fn(),
    extractArtifacts: vi.fn(),
    appendMessageToSession,
    resetSessionStream: vi.fn(),
  })
}

describe('BUG-20260703 B3: finalize 思考时长双源（本地实测 vs 后端 metadata）', () => {
  it('本地计时缺失 → 后端 thinking_duration（字符串）必须保留且可数字化', () => {
    const captured: ChatMessage[] = []
    const append = (_s: string, m: ChatMessage) => { captured.push(m) }
    const controller = buildController(
      {
        sessionId: 's1', requestId: 'r1', rawContent: '', content: '答案',
        explicitReasoning: '', reasoning: '思考…', reasoningStartTime: 0, reasoningEndTime: 0,
      },
      append,
    )
    controller.finalizeAssistantMessage({
      content: '答案',
      sessionId: 's1',
      metadata: { thinking_duration: '7', provider: 'test' },
      reasoning: '思考…',
      sending: ref(false),
      draftSending: ref(false),
    })
    const msg = captured[0]
    expect(msg?.metadata?.thinking_duration, 'B3: 后端时长被 finalize 抹掉——切会话前徽标就丢').toBe('7')
    expect(Number(msg?.metadata?.thinking_duration)).toBeGreaterThan(0)
  })

  it('本地计时可用 → 本地实测覆盖后端值', () => {
    const captured: ChatMessage[] = []
    const append = (_s: string, m: ChatMessage) => { captured.push(m) }
    const controller = buildController(
      {
        sessionId: 's1', requestId: 'r1', rawContent: '', content: '答案',
        explicitReasoning: '', reasoning: '思考…',
        reasoningStartTime: Date.now() - 5000, reasoningEndTime: Date.now() - 1000,
      },
      append,
    )
    controller.finalizeAssistantMessage({
      content: '答案',
      sessionId: 's1',
      metadata: { thinking_duration: '99' },
      reasoning: '思考…',
      sending: ref(false),
      draftSending: ref(false),
    })
    const msg = captured[0]
    const dur = Number(msg?.metadata?.thinking_duration)
    expect(dur).toBeGreaterThanOrEqual(3)
    expect(dur).toBeLessThanOrEqual(5) // 本地 ~4s 实测覆盖后端 99
  })
})
