/**
 * BUG-20260712 · 辅导要点/备课卡生成失败时，prepError 必须是可操作的本地化提示，
 * 而非裸技术串「[POST] http://localhost:16060/api/k12/prep-card: <no response> Load failed」。
 *
 * 根因：store.loadPrepCard 的 catch 直接把 FetchError.message 塞进 prepError，PrepCardPanel 原样渲染 →
 * 家长看到吓人的技术串。治本：统一翻成三语友好文案（超时/网络中断 → 请重试 + 慢本地模型可切云端）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const prepSpy = vi.hoisted(() => vi.fn())

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12PrepCard: (req: unknown) => prepSpy(req),
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

describe('BUG-20260712 · prep-card 失败提示友好化', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerK12Scenario() // 幂等：merge k12 三语文案进全局 i18n
    prepSpy.mockReset()
  })

  it('k12PrepCard reject（Load failed）→ prepError 是友好本地化文案含「重试」，不含裸「[POST]」', async () => {
    prepSpy.mockRejectedValue(
      new Error('[POST] "http://localhost:16060/api/k12/prep-card": <no response> Load failed'),
    )
    const store = useK12Store()
    await store.loadPrepCard('mingming', '五年级上', '数学', ['小数乘法'])

    expect(store.prepLoading).toBe(false)
    expect(store.prepError).toBeTruthy()
    expect(store.prepError).toContain('重试')
    expect(store.prepError).not.toContain('[POST]')
    expect(store.prepError).not.toContain('Load failed')
  })

  it('k12PrepCard reject（Fetch is aborted，切 tab 中止）→ 同样翻成友好文案，不透裸串', async () => {
    prepSpy.mockRejectedValue(new Error('Fetch is aborted'))
    const store = useK12Store()
    await store.loadPrepCard('mingming', '五年级上', '数学', ['简易方程'])

    expect(store.prepError).toContain('重试')
    expect(store.prepError).not.toContain('aborted')
  })
})
