import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => {
  const archiveBlob = new Blob(['archive-pdf'], { type: 'application/pdf' })
  return {
    archiveBlob,
    printSpy: vi.fn<(...args: unknown[]) => boolean>(() => true),
    exportPdfSpy: vi.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true),
    exportArchiveSpy: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      filename: 'mingming-learning-archive.pdf',
      blob: archiveBlob,
      contentType: 'application/pdf',
    }),
    downloadSpy: vi.fn(),
    addToBasketSpy: vi
      .fn<(...args: unknown[]) => Promise<{ record_id: string; added: boolean }>>()
      .mockResolvedValue({ record_id: 'ps-1', added: true }),
    customPaperSpy: vi.fn(),
    fillBasketSpy: vi.fn(),
    startPracticeSpy: vi.fn(),
    listPracticeSetsSpy: vi.fn().mockResolvedValue({ items: [] }),
    mistakes: [
      {
        record_id: 'a',
        question: '苹果和梨的价钱',
        knowledge_point: '小数乘法',
        error_cause: '进位',
        status: 'new',
        version: 0,
        due_at: 1,
      },
      {
        record_id: 'b',
        question: '解方程 2x+15=43',
        knowledge_point: '简易方程',
        error_cause: '移项',
        status: 'new',
        version: 0,
        due_at: 1,
      },
      {
        record_id: 'c',
        question: '梯形面积',
        knowledge_point: '面积',
        error_cause: '公式',
        status: 'mastered',
        version: 1,
      },
    ],
  }
})
vi.mock('../export', () => ({
  printWorksheet: (...a: unknown[]) => h.printSpy(...a),
  exportPdf: (...a: unknown[]) => h.exportPdfSpy(...a),
  exportWord: vi.fn(),
  worksheetFilename: vi.fn(() => 'f.doc'),
  download: (...a: unknown[]) => h.downloadSpy(...a),
}))
vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('mingming'),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockImplementation(() =>
    Promise.resolve({
      items: [
        { ...h.mistakes[0], subject: '数学' },
        { ...h.mistakes[1], subject: '数学' },
      ],
    }),
  ),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12GetMistakePracticeGeneration: vi
    .fn()
    .mockImplementation((_agent: string, recordID: string) =>
      Promise.resolve({ state: 'available', source_mistake_id: recordID }),
    ),
  k12StartMistakePracticeGeneration: (...a: unknown[]) => h.startPracticeSpy(...a),
  k12GenerateCustomPaper: (...a: unknown[]) => h.customPaperSpy(...a),
  k12FillPracticeBasket: (...a: unknown[]) => h.fillBasketSpy(...a),
  k12AddToBasket: (...a: unknown[]) => h.addToBasketSpy(...a),
  k12ListPracticeSets: (...a: unknown[]) => h.listPracticeSetsSpy(...a),
  k12FinalizePracticeSet: vi.fn(),
  k12RemoveFromBasket: vi.fn(),
  k12AdvancePracticeSet: vi.fn(),
  k12CancelPracticeSet: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 },
    weak_top3: [],
    month_new_mistakes: 1,
    review_completion_rate: -1,
    consecutive_fail_kps: null,
    suggestion: '',
  }),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 1, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12ExportArchive: (...a: unknown[]) => h.exportArchiveSpy(...a),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(route?: { provider: string; model: string }) {
  return mount(K12RecordsView, {
    props: {
      agentId: 'mingming',
      agentName: '小明的辅导老师',
      grade: '五年级上',
      textbook: '人教版',
      ...(route ? { modelRoute: { ...route, capability: 'text' as const } } : {}),
    },
    global: { plugins: [createPinia(), i18n()] },
  })
}

// 最新批准合同：本周该练只保留打印和发送；整周复习卷、自定义组卷与独立 PDF 均退役。
// 单题“加入练习集”继续走共享候选选择与原子提交，不由本组整周动作测试替代。
describe('本周该练输出 exact-set 与档案导出', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.printSpy.mockClear()
    h.exportPdfSpy.mockClear()
    h.exportArchiveSpy.mockClear()
    h.downloadSpy.mockClear()
    h.addToBasketSpy.mockClear().mockResolvedValue({ record_id: 'ps-1', added: true })
    h.mistakes.splice(3)
    h.fillBasketSpy.mockReset().mockResolvedValue({ added: 2, skipped: 0 })
    h.customPaperSpy.mockReset().mockResolvedValue({
      generation_job_id: 'paper-job-1',
      status: 'committed',
      set: { record_id: 'ps-1', status: 'draft', items: [] },
      items: [
        {
          item_id: 'generated-1',
          source_problem_id: 'a',
          variant_index: 1,
          actual_difficulty: 'harder',
          verification_status: 'verified',
          verification_evidence: '独立验算',
          question_markdown: '变式 1',
        },
      ],
      added: 1,
      deduplicated: 0,
    })
    h.startPracticeSpy.mockReset()
    h.listPracticeSetsSpy.mockClear().mockResolvedValue({ items: [] })
  })

  it('本周该练移除旧「生成复习卷」，直接提供同源产物动作且不触发旧装篮链', async () => {
    const w = render()
    await flushPromises()

    expect(w.find('[data-testid="build-review-set"]').exists()).toBe(false)
    expect(
      w.findAll('[data-testid="final-artifact-actions"] button').map((button) => button.text()),
    ).toEqual(['打印', '发送到手机'])
    expect(h.fillBasketSpy).not.toHaveBeenCalled()
    expect(h.addToBasketSpy).not.toHaveBeenCalled()
    expect(h.exportPdfSpy).not.toHaveBeenCalled()
    expect(h.printSpy).not.toHaveBeenCalled()
    expect(w.find('[data-testid="week-section"]').exists()).toBe(true)
  })

  it('DD-027 superseded：整周自定义组卷、更多入口与整周保存均不存在', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="weekly-more-trigger"]').exists()).toBe(false)
    expect(w.find('button[aria-label="更多本周该练操作"]').exists()).toBe(false)
    expect(w.find('[data-testid="custom-paper-form"]').exists()).toBe(false)
    expect(w.find('[data-testid="custom-paper-gen"]').exists()).toBe(false)
    expect(h.customPaperSpy).not.toHaveBeenCalled()
    expect(h.fillBasketSpy).not.toHaveBeenCalled()
  })

  it('溢出菜单的档案导出保留，并消费服务端档案二进制响应', async () => {
    const w = render()
    await flushPromises()
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    await w.find('.k12rec__export button').trigger('click')
    const pdfBtn = w.findAll('.k12rec__menu button').find((b) => b.text().includes('PDF'))
    expect(pdfBtn, '档案导出 PDF 菜单项应保留').toBeTruthy()
    await pdfBtn!.trigger('click')
    await flushPromises()
    expect(h.exportArchiveSpy).toHaveBeenCalledWith('mingming', 'pdf')
    expect(h.downloadSpy).toHaveBeenCalledWith(
      'mingming-learning-archive.pdf',
      h.archiveBlob,
      'application/pdf',
    )
  })
})
