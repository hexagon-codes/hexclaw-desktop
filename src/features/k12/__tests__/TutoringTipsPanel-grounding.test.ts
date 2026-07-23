import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import TutoringTipsPanel from '../views/TutoringTipsPanel.vue'

const h = vi.hoisted(() => ({
  tutoringTips: vi.fn(),
  add: vi.fn(),
  parse: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12TutoringTips: (req: unknown, signal?: AbortSignal) => h.tutoringTips(req, signal),
  k12AddGrounding: (req: unknown, signal?: AbortSignal) => h.add(req, signal),
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12Grade: vi.fn(),
}))
vi.mock('@/utils/file-parser', () => ({ parseDocument: (file: File) => h.parse(file) }))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(agentId = 'mingming') {
  return mount(TutoringTipsPanel, {
    props: {
      agentId,
      gradingJobId: `job-${agentId}`,
      sessionId: 'session-1',
      grade: '五年级上',
      subject: '数学',
      knowledgePoints: ['小数乘法'],
    },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
  })
}

describe('TutoringTipsPanel 教材上传闭环', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.tutoringTips.mockReset().mockResolvedValue({
      knowledge_points: ['小数乘法'],
      sections: [
        { title: '这页在练什么', content: '小数乘法。', source_label: '📖 依据课本' },
        { title: '小明要留意', content: '暂无历史证据。', source_label: '🧠 学情信号' },
        {
          title: '每道题怎么带（不直接给答案）',
          content: '先问孩子小数位数。',
          source_label: '🤖 AI 归纳·供参考',
        },
      ],
    })
    h.add.mockReset().mockResolvedValue({ ok: true })
    h.parse.mockReset().mockResolvedValue({ fileName: '人教版五上.pdf', text: '小数乘法教材原文' })
  })

  it('选择教材文件后解析、按当前孩子上传并刷新辅导要点', async () => {
    const w = render()
    await flushPromises()
    h.tutoringTips.mockClear()
    const file = new File(['pdf'], '人教版五上.pdf', { type: 'application/pdf' })
    const input = w.get('[data-testid="tutoring-tips-grounding-file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()

    expect(h.parse).toHaveBeenCalledWith(file)
    expect(h.add).toHaveBeenCalledWith(
      {
        agent: 'mingming',
        subject: '数学',
        title: '人教版五上.pdf',
        content: '小数乘法教材原文',
      },
      expect.any(AbortSignal),
    )
    expect(h.tutoringTips).toHaveBeenCalledWith(
      {
        agent: 'mingming',
        grading_job_id: 'job-mingming',
      },
      expect.any(AbortSignal),
    )
  })

  it('上传过程中切换孩子，旧请求完成后不得为新孩子触发刷新', async () => {
    let resolveAdd!: (value: { ok: true }) => void
    h.add.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAdd = resolve
      }),
    )
    const w = render('child-a')
    await flushPromises()
    h.tutoringTips.mockClear()
    const file = new File(['text'], '教材.txt', { type: 'text/plain' })
    const input = w.get('[data-testid="tutoring-tips-grounding-file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()
    await w.setProps({ agentId: 'child-b', gradingJobId: 'job-child-b' })
    await flushPromises()
    const tutoringTipsCallsAfterSwitch = h.tutoringTips.mock.calls.length
    resolveAdd({ ok: true })
    await flushPromises()

    expect(h.add.mock.calls[0]?.[0]).toMatchObject({ agent: 'child-a' })
    expect(h.tutoringTips.mock.calls.length).toBe(tutoringTipsCallsAfterSwitch)
  })

  it('只切换客户端学科/知识点不会重生成，可信 Job 始终是唯一生成依据', async () => {
    h.tutoringTips.mockImplementation(() => new Promise(() => {}))
    const w = render()
    await flushPromises()

    const firstSignal = h.tutoringTips.mock.calls[0]?.[1] as AbortSignal | undefined
    await w.setProps({ subject: '语文', knowledgePoints: ['古诗积累'] })
    await flushPromises()

    expect(firstSignal?.aborted).toBe(false)
    expect(h.tutoringTips).toHaveBeenCalledTimes(1)
  })
})
