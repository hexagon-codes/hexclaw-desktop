import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import PrepCardPanel from '../views/PrepCardPanel.vue'

const h = vi.hoisted(() => ({
  printSpy: vi.fn<(...args: unknown[]) => Promise<boolean>>(() => Promise.resolve(true)),
}))
vi.mock('../persistent-print', () => ({
  preparePersistentPrint: async (...a: unknown[]) => ({
    status: 'completed', printed: await h.printSpy(...a),
  }),
}))
vi.mock('../export', () => ({
  printPrepCard: vi.fn().mockResolvedValue(true),
  prepCardToMarkdown: (card: { sections: Array<{ content: string }> }) =>
    `# 辅导要点\n\n${card.sections[0]?.content ?? ''}`,
  prepCardToText: vi.fn().mockReturnValue('辅导要点'),
}))
vi.mock('@/api/k12', () => ({
  k12PrepCard: vi.fn().mockResolvedValue({
    knowledge_points: ['小数乘法'],
    sections: [
      { title: '知识点回顾', content: '小数乘法要对齐小数点…', source_label: '📖 依据课本' },
    ],
  }),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn().mockResolvedValue({}),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

// bug（用户报）：备课卡「打印」按钮不可用——原实现只 toast，不真打印。
describe('bug: 备课卡打印按钮须真打印', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.printSpy.mockClear()
  })

  it('已生成备课卡时，点🖨 以不可变 canonical 内容调用持久 PrintJob', async () => {
    const w = mount(PrepCardPanel, {
      props: { agentId: 'ming', grade: '五年级上', knowledgePoints: ['小数乘法'] },
      global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    })
    await flushPromises() // loadPrepCard 完成，store.prepCard 就绪
    await w.get('[data-testid="prep-print"]').trigger('click')
    expect(h.printSpy).toHaveBeenCalledTimes(1)
    expect(h.printSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'ming',
        sourceKind: 'prep_card',
        sourceRef: 'prep-card:五年级上:小数乘法',
        title: '这份作业的辅导要点',
        canonicalMarkdown: expect.stringContaining('小数乘法要对齐小数点'),
        browserPrint: expect.any(Function),
      }),
    )
  })
})
