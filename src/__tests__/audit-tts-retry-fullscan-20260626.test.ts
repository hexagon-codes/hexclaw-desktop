/**
 * hex-test 全场景审计 RED 取证（2026-06-26）——「以上所有功能」全量覆盖
 *
 * 这些是 4 个 fan-out 审计 agent 报出、本文件落成 RED 钉死的**确认 bug**：
 *  P1-A retry/edit：原子删除成功后重发被 shouldBlockChatSend 拦截(handleSend 返回 false)
 *        → 整轮已从后端删除、却无重发也无提示 = 静默数据丢失（我的原子重试残留缺口）
 *  P1-B useVoice.speak：合成 await 期间无 AbortController，stopSpeaking 后合成 resolve 仍 new Audio().play()
 *        → "停止"失效 + 幽灵音频 + 状态脱节（TTS 修好后才暴露的潜伏 bug）
 *  P2-C retry fast-path/已删消息：removeRangeAtomic 不容忍 404，删一条后端不存在的消息即整体失败
 *
 * 约定：当前在未修代码上**应 FAIL**（红）。修复后断言转绿。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/messageService', () => ({
  removeMessage: vi.fn().mockResolvedValue(undefined),
}))

import { useChatActions } from '@/composables/useChatActions'

function makeStore() {
  return {
    currentSessionId: 'original-session',
    messages: [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '', metadata: {} },
    ],
    chatParams: { model: 'glm-4-flash' },
    sendMessage: vi.fn().mockRejectedValue(new Error('regeneration rejected')),
    setMessageFeedback: vi.fn().mockResolvedValue(null),
  }
}
const toast = () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })

describe('hex-test 审计 RED — retry/edit', () => {
  beforeEach(() => vi.clearAllMocks())

  it('P1-A: 重生成被服务端拒绝时整轮仍保留', async () => {
    const { removeMessage } = await import('@/services/messageService')
    vi.mocked(removeMessage).mockResolvedValue(undefined)
    const send = vi.fn().mockResolvedValue(false)
    const store = makeStore()
    const t = toast()
    const { handleRetry } = useChatActions(store as any, t as any, send as any)

    await handleRetry(1)

    expect(store.messages.map(({ id }) => id)).toEqual(['u1', 'a1'])
    expect(removeMessage).not.toHaveBeenCalled()
    expect(t.error).toHaveBeenCalled()
  })

  it('P2-C: 从未落库的本地卡片仍能在本机重新生成', async () => {
    const { removeMessage } = await import('@/services/messageService')
    // 客户端独占消息(fastpath-/slash-/user-)从未落库 → 后端删它 404
    const notFound = Object.assign(new Error('message not found'), { status: 404 })
    vi.mocked(removeMessage).mockRejectedValue(notFound)
    const send = vi.fn().mockResolvedValue(true)
    const store = {
      messages: [
        { id: 'user-x', role: 'user', content: '每天8点采集', timestamp: '' },
        { id: 'fastpath-x', role: 'assistant', content: '卡片', timestamp: '', metadata: { source_tier: '1' } },
      ],
      chatParams: { model: 'glm-4-flash' },
      setMessageFeedback: vi.fn(),
    }
    const t = toast()
    const { handleRetry } = useChatActions(store as any, t as any, send as any)

    await handleRetry(1)

    expect(removeMessage).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalled()
    expect(t.error).not.toHaveBeenCalled()
  })
})

describe('hex-test 审计 RED — useVoice 取消', () => {
  let playCalls: number

  beforeEach(() => {
    vi.clearAllMocks()
    playCalls = 0
    // stub Audio + URL（jsdom 不实现 HTMLMediaElement.play）
    class FakeAudio {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      play() { playCalls++; return Promise.resolve() }
      pause() {}
      currentTime = 0
      constructor(public src?: string) {}
    }
    ;(globalThis as any).Audio = FakeAudio as any
    ;(globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:fake')
    ;(globalThis as any).URL.revokeObjectURL = vi.fn()
  })

  it('P1-B: 合成 await 期间 stopSpeaking → 合成 resolve 后不得再 new Audio().play()', async () => {
    let resolveSynth!: (b: Blob) => void
    const deferred = new Promise<Blob>((res) => { resolveSynth = res })
    vi.doMock('@/api/voice', () => ({ textToSpeech: vi.fn(() => deferred) }))
    vi.resetModules()
    const { useVoice } = await import('@/composables/useVoice')
    vi.doMock('@/api/voice', () => ({ textToSpeech: vi.fn(() => deferred) }))

    const v = useVoice()
    const p = v.speak('要朗读的文本')   // 进入 await textToSpeech（未 resolve）
    await Promise.resolve()
    v.stopSpeaking()                    // 用户在合成中点"停止"
    resolveSynth(new Blob(['x']))       // 合成此刻才完成
    await p

    // 期望（修复后）：停止后不应再播放
    expect(playCalls).toBe(0)
  })
})
