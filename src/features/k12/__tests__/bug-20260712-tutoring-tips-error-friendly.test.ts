/**
 * BUG-20260712 · 辅导要点/辅导要点生成失败时，tutoringTipsError 必须是可操作的本地化提示，
 * 而非裸技术串「[POST] http://localhost:16060/api/k12/tutoring-tips: <no response> Load failed」。
 *
 * 根因：store.loadTutoringTips 的 catch 直接把 FetchError.message 塞进 tutoringTipsError，TutoringTipsPanel 原样渲染 →
 * 家长看到吓人的技术串。治本：统一翻成三语友好文案（超时/网络中断 → 请重试 + 慢本地模型可切云端）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const tutoringTipsSpy = vi.hoisted(() => vi.fn())

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: (req: unknown) => tutoringTipsSpy(req),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
    k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

import { useK12Store } from '../store'
import { registerK12Scenario } from '../register'

describe('BUG-20260712 · tutoring-tips 失败提示友好化', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerK12Scenario() // 幂等：merge k12 三语文案进全局 i18n
    tutoringTipsSpy.mockReset()
  })

  it('k12TutoringTips reject（Load failed）→ tutoringTipsError 是友好本地化文案含「重试」，不含裸「[POST]」', async () => {
    tutoringTipsSpy.mockRejectedValue(
      new Error('[POST] "http://localhost:16060/api/k12/tutoring-tips": <no response> Load failed'),
    )
    const store = useK12Store()
    await store.loadTutoringTips('mingming', 'job-confirmed-1')

    expect(store.tutoringTipsLoading).toBe(false)
    expect(store.tutoringTipsError).toBeTruthy()
    expect(store.tutoringTipsError).toContain('重试')
    expect(store.tutoringTipsError).not.toContain('[POST]')
    expect(store.tutoringTipsError).not.toContain('Load failed')
  })

  it('k12TutoringTips reject（Fetch is aborted，切 tab 中止）→ 同样翻成友好文案，不透裸串', async () => {
    tutoringTipsSpy.mockRejectedValue(new Error('Fetch is aborted'))
    const store = useK12Store()
    await store.loadTutoringTips('mingming', 'job-confirmed-2')

    expect(store.tutoringTipsError).toContain('重试')
    expect(store.tutoringTipsError).not.toContain('aborted')
  })
})
