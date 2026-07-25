import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import TutoringTipsPanel from '../views/TutoringTipsPanel.vue'
import { registerK12Scenario } from '../register'

const h = vi.hoisted(() => ({
  tutoringTipsSpy: vi.fn().mockResolvedValue({
    knowledge_points: ['简易方程'],
    sections: [
      {
        title: '这页在练什么',
        content: '等式两边同时加减，$2x+15=43 \\Rightarrow x=14$',
        source_label: '📖 依据课本',
      },
      {
        title: '小明要留意',
        content: '暂无历史证据。',
        source_label: '🧠 学情信号',
      },
      {
        title: '每道题怎么带（不直接给答案）',
        content: '先问孩子等式两边应同时做什么。',
        source_label: '🤖 AI 归纳·供参考',
      },
    ],
  }),
}))
vi.mock('@/api/k12', () => ({
  k12TutoringTips: (req: unknown, signal?: AbortSignal) => h.tutoringTipsSpy(req, signal),
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

function render(
  knowledgePoints: string[] = ['简易方程'],
  overrides: Record<string, unknown> = {},
) {
  return mount(TutoringTipsPanel, {
    props: {
      agentId: 'mingming',
      dispatchId: 'dispatch-confirmed-1',
      sessionId: 'session-1',
      grade: '五年级上',
      subject: '数学',
      textbook: '人教版',
      knowledgePoints,
      ...overrides,
    },
    global: {
      plugins: [createPinia(), i18n()],
      stubs: {
        MarkdownRenderer: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
      },
    },
  })
}

// 辅导要点只在识题持久确认后内联，生成仅引用当前可信 Job。
describe('TutoringTipsPanel（辅导要点内联卡）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerK12Scenario()
    h.tutoringTipsSpy.mockClear()
  })

  it('可信图片任务就绪后事件驱动生成，只带 agent/dispatch_id', async () => {
    render(['简易方程'])
    await flushPromises()
    expect(h.tutoringTipsSpy).toHaveBeenCalledWith(
      {
        agent: 'mingming',
        dispatch_id: 'dispatch-confirmed-1',
      },
      expect.any(AbortSignal),
    )
  })

  it('渲染各段 + 来源徽章直出后端 source_label', async () => {
    const w = render(['简易方程'])
    await flushPromises()
    expect(w.text()).toContain('这页在练什么')
    expect(w.text()).toContain('📖 依据课本')
    // AI 归纳段落 → 弱来源告警徽章
    expect(w.find('.tutor-badge--weak').exists()).toBe(true)
    expect(w.find('.tutor-badge--weak').text()).toContain('AI 归纳')
  })

  it('权威原型：头部展示当前作业范围，图标使用同源 SVG，依据与投递状态归入独立 footer', async () => {
    const w = render(['简易方程'])
    await flushPromises()

    expect(w.get('.tutoring-tips__unit').text()).toBe('简易方程')
    expect(w.findAll('.tutoring-tips__actions .icbtn svg')).toHaveLength(3)
    expect(w.get('.tutoring-tips__legend').element.parentElement).toBe(w.get('.tutoring-tips').element)
    expect(w.get('.tutoring-tips__basis').text()).toContain('人教版')
    expect(w.get('.tutoring-tips__basis').text()).toContain('五年级上')
  })

  it('缺少可信 Job 或 session 时不生成', async () => {
    render(['简易方程'], { dispatchId: '', sessionId: '' })
    await flushPromises()
    expect(h.tutoringTipsSpy).not.toHaveBeenCalled()
  })

  it('生成失败显示可点击重试，重试复用当前孩子与已确认 Job', async () => {
    h.tutoringTipsSpy.mockRejectedValueOnce(new Error('timeout'))
    const w = render(['简易方程'])
    await flushPromises()

    const retry = w.get('[data-testid="tutoring-tips-retry"]')
    expect(retry.text()).toContain('重试')
    let finishRetry!: (value: {
      knowledge_points: string[]
      sections: Array<{ title: string; content: string; source_label: string }>
    }) => void
    h.tutoringTipsSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetry = resolve
        }),
    )
    await retry.trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="tutoring-tips-retry"]').exists()).toBe(false)
    expect(w.text()).toContain('正在结合')
    expect(h.tutoringTipsSpy).toHaveBeenCalledTimes(2)

    finishRetry({
      knowledge_points: ['简易方程'],
      sections: [
        { title: '这页在练什么', content: '等式两边同时加减。', source_label: '📖 依据课本' },
        { title: '小明要留意', content: '暂无历史证据。', source_label: '🧠 学情信号' },
        {
          title: '每道题怎么带（不直接给答案）',
          content: '先问孩子等式两边应同时做什么。',
          source_label: '🤖 AI 归纳·供参考',
        },
      ],
    })
    await flushPromises()

    expect(h.tutoringTipsSpy).toHaveBeenLastCalledWith(
      {
        agent: 'mingming',
        dispatch_id: 'dispatch-confirmed-1',
      },
      expect.any(AbortSignal),
    )
    expect(w.find('[data-testid="tutoring-tips-retry"]').exists()).toBe(false)
    expect(w.text()).toContain('这页在练什么')
  })

  it('切换孩子会中止上一份最长 120 秒的生成请求，只保留新请求', async () => {
    h.tutoringTipsSpy.mockImplementation(() => new Promise(() => {}))
    const w = render(['简易方程'])
    await flushPromises()

    const firstSignal = h.tutoringTipsSpy.mock.calls[0]?.[1] as AbortSignal | undefined
    expect(firstSignal).toBeInstanceOf(AbortSignal)
    expect(firstSignal?.aborted).toBe(false)

    await w.setProps({
      agentId: 'honghong',
      dispatchId: 'dispatch-confirmed-2',
      knowledgePoints: ['分数乘法'],
    })
    await flushPromises()

    const secondSignal = h.tutoringTipsSpy.mock.calls[1]?.[1] as AbortSignal | undefined
    expect(firstSignal?.aborted).toBe(true)
    expect(secondSignal).toBeInstanceOf(AbortSignal)
    expect(secondSignal?.aborted).toBe(false)
  })

  it('离开会话时立即中止仍在生成的辅导要点', async () => {
    h.tutoringTipsSpy.mockImplementation(() => new Promise(() => {}))
    const w = render(['简易方程'])
    await flushPromises()

    const signal = h.tutoringTipsSpy.mock.calls[0]?.[1] as AbortSignal | undefined
    expect(signal).toBeInstanceOf(AbortSignal)
    w.unmount()

    expect(signal?.aborted).toBe(true)
  })
})
