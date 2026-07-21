import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => ({
  printSpy: vi.fn<(...args: unknown[]) => boolean>(() => true),
  exportPdfSpy: vi.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true),
  exportArchiveDocumentSpy: vi
    .fn<(...args: unknown[]) => Promise<boolean>>()
    .mockResolvedValue(true),
  addToBasketSpy: vi
    .fn<(...args: unknown[]) => Promise<{ record_id: string; added: boolean }>>()
    .mockResolvedValue({ record_id: 'ps-1', added: true }),
  customPaperSpy: vi.fn(),
  fillBasketSpy: vi.fn(),
  reviewRetrySpy: vi.fn(),
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
}))
vi.mock('../export', () => ({
  printWorksheet: (...a: unknown[]) => h.printSpy(...a),
  exportPdf: (...a: unknown[]) => h.exportPdfSpy(...a),
  exportWord: vi.fn(),
  worksheetFilename: vi.fn(() => 'f.doc'),
  exportArchiveDocument: (...a: unknown[]) => h.exportArchiveDocumentSpy(...a),
  download: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
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
  k12ReviewRetry: (...a: unknown[]) => h.reviewRetrySpy(...a),
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
  k12ExportMd: vi.fn().mockResolvedValue({ format: 'markdown', content: '# 完整学习档案' }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render() {
  return mount(K12RecordsView, {
    props: {
      agentId: 'mingming',
      agentName: '小明的辅导老师',
      grade: '五年级上',
      textbook: '人教版',
    },
    global: { plugins: [createPinia(), i18n()] },
  })
}

// §3.8 闭环断裂修复（20260718 改道装篮）：出卷动作不再 exportPdf 直出 PDF（绕过练习集），
// 统一为装篮（AddToBasket 幂等去重）→ 打印/发送在练习集完成（打印即确认固化）。
describe('生成复习卷 / 自定义组卷 → 装篮（不再直出 PDF）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.printSpy.mockClear()
    h.exportPdfSpy.mockClear()
    h.exportArchiveDocumentSpy.mockClear()
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
    let retryNo = 0
    h.reviewRetrySpy.mockReset().mockImplementation((req: { record_id: string }) => {
      retryNo++
      return Promise.resolve({
        solution: `## 问题\n${req.record_id} 变式 ${retryNo}\n## 答案\n${retryNo}`,
        question: `${req.record_id} 变式 ${retryNo}`,
        answer: `解答 ${retryNo}`,
        expected_answer: String(retryNo),
        verdict: 'agree',
        badge: 'verified-strong',
      })
    })
    h.listPracticeSetsSpy.mockClear().mockResolvedValue({ items: [] })
  })

  it('点「生成复习卷」→ 调后端到期题验证装篮链，不再把全部题硬编码 pending', async () => {
    const w = render()
    await flushPromises()
    const genBtn = w.find('[data-testid="build-review-set"]')
    expect(genBtn.exists(), '应有「生成复习卷」按钮').toBe(true)
    expect(genBtn.text()).toContain('生成复习卷')
    await genBtn.trigger('click')
    await flushPromises()

    expect(h.fillBasketSpy).toHaveBeenCalledWith('mingming')
    expect(h.addToBasketSpy).not.toHaveBeenCalled()
    // 旧路径整体删除：不再直出 PDF / 打印
    expect(h.exportPdfSpy).not.toHaveBeenCalled()
    expect(h.printSpy).not.toHaveBeenCalled()
    // 装篮完成 → 切到练习集 Tab（打印/发送在那完成）
    expect(w.find('[data-testid="practicesets-section"]').exists()).toBe(true)
  })

  it('DD-027：全部参数开放，并且 Desktop 只调用一次正式组卷 command', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="review-split-more"]').trigger('click')
    await w.find('[data-testid="custom-paper-open"]').trigger('click')
    expect(w.find('[data-testid="paper-scope-week"]').exists()).toBe(true)
    expect(w.find('[data-testid="paper-scope-unmastered"]').exists()).toBe(true)
    await w.find('[data-testid="paper-scope-unmastered"]').trigger('click')
    await w.find('[data-testid="paper-perq-2"]').trigger('click')
    await w.find('[data-testid="paper-difficulty-harder"]').trigger('click')
    await w
      .findAll('.chip')
      .find((b) => b.text().includes('≤ 5'))!
      .trigger('click')

    const gen = w.find('[data-testid="custom-paper-gen"]')
    expect(gen.text()).toContain('加入练习集')
    expect(gen.text()).not.toContain('打印')
    await gen.trigger('click')
    await flushPromises()

    expect(h.customPaperSpy).toHaveBeenCalledTimes(1)
    expect(h.customPaperSpy).toHaveBeenCalledWith({
      agent: 'mingming',
      idempotency_key: expect.any(String),
      scope: 'unmastered',
      total: 5,
      per_source: 2,
      difficulty: 'harder',
      textbook: '人教版',
      grade: '五年级上',
    })
    expect(h.reviewRetrySpy).not.toHaveBeenCalled()
    expect(h.addToBasketSpy).not.toHaveBeenCalled()
    expect(h.exportPdfSpy).not.toHaveBeenCalled()
    const result = w.find('[data-testid="custom-paper-result"]')
    expect(result.attributes('role')).toBe('status')
    expect(result.text()).toContain('组卷完成')
    expect(result.text()).toContain('来源题')
    expect(result.text()).toContain('实际难度')
    expect(result.text()).toContain('已验证')
  })

  it('DD-027：失败留在原弹层，原参数和幂等键重试后展示同一任务回执', async () => {
    h.customPaperSpy
      .mockRejectedValueOnce(new Error('第 2 题验证失败，未装入半篮'))
      .mockResolvedValueOnce({
        generation_job_id: 'paper-job-replayed',
        status: 'committed',
        set: { record_id: 'ps-1', status: 'draft', items: [] },
        items: [],
        added: 0,
        deduplicated: 2,
      })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="review-split-more"]').trigger('click')
    await w.find('[data-testid="custom-paper-open"]').trigger('click')
    await w.find('[data-testid="custom-paper-gen"]').trigger('click')
    await flushPromises()

    const alert = w.find('[data-testid="custom-paper-error"]')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toContain('未装入半篮')
    expect(w.find('[data-testid="custom-paper-form"]').exists()).toBe(true)
    const firstKey = (h.customPaperSpy.mock.calls[0]![0] as { idempotency_key: string })
      .idempotency_key

    await w.find('[data-testid="custom-paper-retry"]').trigger('click')
    await flushPromises()

    expect(h.customPaperSpy).toHaveBeenCalledTimes(2)
    expect(
      (h.customPaperSpy.mock.calls[1]![0] as { idempotency_key: string }).idempotency_key,
    ).toBe(firstKey)
    expect(w.find('[data-testid="custom-paper-result"]').text()).toContain('未重复加入')
    expect(w.find('[data-testid="custom-paper-result"]').text()).toContain('paper-job-replayed')
  })

  it('溢出菜单的档案导出保留，并消费服务端完整学习档案 Markdown', async () => {
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
    expect(h.exportArchiveDocumentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '# 完整学习档案',
        format: 'pdf',
      }),
    )
  })
})
