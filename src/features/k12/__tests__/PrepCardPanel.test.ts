import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import PrepCardPanel from '../views/PrepCardPanel.vue'
import { registerK12Scenario } from '../register'

const h = vi.hoisted(() => ({
  prepSpy: vi.fn().mockResolvedValue({
    knowledge_points: ['简易方程'],
    sections: [
      { title: '① 知识点回顾', content: '等式两边同时加减，$2x+15=43 \\Rightarrow x=14$', source_label: '📖 依据课本' },
      { title: '⑤ 情绪提示', content: '连续错过，先从热身题开始。', source_label: '🤖 AI 归纳·供参考（未校验）' },
    ],
  }),
}))
vi.mock('@/api/k12', () => ({
  k12PrepCard: (req: unknown, signal?: AbortSignal) => h.prepSpy(req, signal),
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12Grade: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function render(knowledgePoints: string[] = ['简易方程']) {
  return mount(PrepCardPanel, {
    props: { agentId: 'mingming', grade: '五年级上', knowledgePoints },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: { props: ['content'], template: '<div class="md">{{ content }}</div>' } } },
  })
}

// 20260709：备课卡侧栏 → 识题确认后内联「这份作业的辅导要点」。生成由识题识别出的真实知识点驱动
// （非 open 侧栏开合）；来源徽章 CSS 类 prep-badge → tutor-badge。
describe('PrepCardPanel（辅导要点内联卡）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerK12Scenario()
    h.prepSpy.mockClear()
  })

  it('知识点非空即事件驱动生成，带 agent/grade/knowledge_points', async () => {
    render(['简易方程'])
    await flushPromises()
    expect(h.prepSpy).toHaveBeenCalledWith(
      { agent: 'mingming', grade: '五年级上', knowledge_points: ['简易方程'] },
      expect.any(AbortSignal),
    )
  })

  it('渲染各段 + 来源徽章直出后端 source_label', async () => {
    const w = render(['简易方程'])
    await flushPromises()
    expect(w.text()).toContain('① 知识点回顾')
    expect(w.text()).toContain('📖 依据课本')
    // AI 归纳段落 → 弱来源告警徽章
    expect(w.find('.tutor-badge--weak').exists()).toBe(true)
    expect(w.find('.tutor-badge--weak').text()).toContain('AI 归纳')
  })

  it('无知识点不生成（未识题即无辅导要点）', async () => {
    render([])
    await flushPromises()
    expect(h.prepSpy).not.toHaveBeenCalled()
  })

  it('生成失败显示可点击重试，重试复用当前孩子、年级和知识点', async () => {
    h.prepSpy.mockRejectedValueOnce(new Error('timeout'))
    const w = render(['简易方程'])
    await flushPromises()

    const retry = w.get('[data-testid="prep-retry"]')
    expect(retry.text()).toContain('重试')
    let finishRetry!: (value: { knowledge_points: string[]; sections: Array<{ title: string; content: string; source_label: string }> }) => void
    h.prepSpy.mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve }))
    await retry.trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="prep-retry"]').exists()).toBe(false)
    expect(w.text()).toContain('正在结合')
    expect(h.prepSpy).toHaveBeenCalledTimes(2)

    finishRetry({
      knowledge_points: ['简易方程'],
      sections: [{ title: '① 知识点回顾', content: '等式两边同时加减。', source_label: '📖 依据课本' }],
    })
    await flushPromises()

    expect(h.prepSpy).toHaveBeenLastCalledWith(
      {
        agent: 'mingming',
        grade: '五年级上',
        knowledge_points: ['简易方程'],
      },
      expect.any(AbortSignal),
    )
    expect(w.find('[data-testid="prep-retry"]').exists()).toBe(false)
    expect(w.text()).toContain('① 知识点回顾')
  })

  it('切换孩子会中止上一份最长 120 秒的生成请求，只保留新请求', async () => {
    h.prepSpy.mockImplementation(() => new Promise(() => {}))
    const w = render(['简易方程'])
    await flushPromises()

    const firstSignal = h.prepSpy.mock.calls[0]?.[1] as AbortSignal | undefined
    expect(firstSignal).toBeInstanceOf(AbortSignal)
    expect(firstSignal?.aborted).toBe(false)

    await w.setProps({ agentId: 'honghong', knowledgePoints: ['分数乘法'] })
    await flushPromises()

    const secondSignal = h.prepSpy.mock.calls[1]?.[1] as AbortSignal | undefined
    expect(firstSignal?.aborted).toBe(true)
    expect(secondSignal).toBeInstanceOf(AbortSignal)
    expect(secondSignal?.aborted).toBe(false)
  })

  it('离开会话时立即中止仍在生成的辅导要点', async () => {
    h.prepSpy.mockImplementation(() => new Promise(() => {}))
    const w = render(['简易方程'])
    await flushPromises()

    const signal = h.prepSpy.mock.calls[0]?.[1] as AbortSignal | undefined
    expect(signal).toBeInstanceOf(AbortSignal)
    w.unmount()

    expect(signal?.aborted).toBe(true)
  })
})
