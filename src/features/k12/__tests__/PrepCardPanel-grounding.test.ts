import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import PrepCardPanel from '../views/PrepCardPanel.vue'

const h = vi.hoisted(() => ({
  prep: vi.fn(),
  add: vi.fn(),
  parse: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12PrepCard: (req: unknown, signal?: AbortSignal) => h.prep(req, signal),
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
  return mount(PrepCardPanel, {
    props: { agentId, grade: '五年级上', subject: '数学', knowledgePoints: ['小数乘法'] },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
  })
}

describe('PrepCardPanel 教材上传闭环', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.prep.mockReset().mockResolvedValue({ knowledge_points: ['小数乘法'], sections: [] })
    h.add.mockReset().mockResolvedValue({ ok: true })
    h.parse.mockReset().mockResolvedValue({ fileName: '人教版五上.pdf', text: '小数乘法教材原文' })
  })

  it('选择教材文件后解析、按当前孩子上传并刷新辅导要点', async () => {
    const w = render()
    await flushPromises()
    h.prep.mockClear()
    const file = new File(['pdf'], '人教版五上.pdf', { type: 'application/pdf' })
    const input = w.get('[data-testid="prep-grounding-file"]')
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
    expect(h.prep).toHaveBeenCalledWith(
      {
        agent: 'mingming',
        grade: '五年级上',
        subject: '数学',
        knowledge_points: ['小数乘法'],
      },
      undefined,
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
    h.prep.mockClear()
    const file = new File(['text'], '教材.txt', { type: 'text/plain' })
    const input = w.get('[data-testid="prep-grounding-file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()
    await w.setProps({ agentId: 'child-b' })
    await flushPromises()
    const prepCallsAfterSwitch = h.prep.mock.calls.length
    resolveAdd({ ok: true })
    await flushPromises()

    expect(h.add.mock.calls[0]?.[0]).toMatchObject({ agent: 'child-a' })
    expect(h.prep.mock.calls.length).toBe(prepCallsAfterSwitch)
  })

  it('切换学科会中止旧教材请求，新请求只使用当前学科', async () => {
    h.prep.mockImplementation(() => new Promise(() => {}))
    const w = render()
    await flushPromises()

    const firstSignal = h.prep.mock.calls[0]?.[1] as AbortSignal | undefined
    await w.setProps({ subject: '语文', knowledgePoints: ['古诗积累'] })
    await flushPromises()

    expect(firstSignal?.aborted).toBe(true)
    expect(h.prep).toHaveBeenLastCalledWith(
      {
        agent: 'mingming',
        grade: '五年级上',
        subject: '语文',
        knowledge_points: ['古诗积累'],
      },
      expect.any(AbortSignal),
    )
  })
})
