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
  addToBasketSpy: vi.fn<(...args: unknown[]) => Promise<{ record_id: string; added: boolean }>>()
    .mockResolvedValue({ record_id: 'ps-1', added: true }),
  listPracticeSetsSpy: vi.fn().mockResolvedValue({ items: [] }),
  mistakes: [
    { record_id: 'a', question: '苹果和梨的价钱', knowledge_point: '小数乘法', error_cause: '进位', status: 'new', version: 0, due_at: 1 },
    { record_id: 'b', question: '解方程 2x+15=43', knowledge_point: '简易方程', error_cause: '移项', status: 'new', version: 0, due_at: 1 },
    { record_id: 'c', question: '梯形面积', knowledge_point: '面积', error_cause: '公式', status: 'mastered', version: 1 },
  ],
}))
vi.mock('../export', () => ({
  printWorksheet: (...a: unknown[]) => h.printSpy(...a),
  exportPdf: (...a: unknown[]) => h.exportPdfSpy(...a), exportWord: vi.fn(), worksheetFilename: vi.fn(() => 'f.doc'),
  download: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockImplementation(() =>
    Promise.resolve({ items: [{ ...h.mistakes[0], subject: '数学' }, { ...h.mistakes[1], subject: '数学' }] })),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12ReviewRetry: vi.fn(),
  k12AddToBasket: (...a: unknown[]) => h.addToBasketSpy(...a),
  k12ListPracticeSets: (...a: unknown[]) => h.listPracticeSetsSpy(...a),
  k12FinalizePracticeSet: vi.fn(),
  k12RemoveFromBasket: vi.fn(),
  k12AdvancePracticeSet: vi.fn(),
  k12CancelPracticeSet: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 }, weak_top3: [], month_new_mistakes: 1, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 1, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })
}

function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
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
    h.addToBasketSpy.mockClear().mockResolvedValue({ record_id: 'ps-1', added: true })
    h.listPracticeSetsSpy.mockClear().mockResolvedValue({ items: [] })
  })

  it('点「生成复习卷」→ 复习队列逐题装篮（added_via=weekly · pending 诚实）+ 切练习集 Tab，不再 exportPdf', async () => {
    const w = render()
    await flushPromises()
    const genBtn = w.find('[data-testid="build-review-set"]')
    expect(genBtn.exists(), '应有「生成复习卷」按钮').toBe(true)
    expect(genBtn.text()).toContain('生成复习卷')
    await genBtn.trigger('click')
    await flushPromises()

    // 队列 2 题 → 逐题装篮
    expect(h.addToBasketSpy).toHaveBeenCalledTimes(2)
    expect(h.addToBasketSpy).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'mingming',
      item: expect.objectContaining({
        source_problem_id: 'a',
        subject: '数学',
        added_via: 'weekly',
        question_markdown: '苹果和梨的价钱',
        // 原题重现暂无独立验算答案 → 诚实置 pending（不预宣称已验证）
        verification_status: 'pending',
      }),
    }))
    // 旧路径整体删除：不再直出 PDF / 打印
    expect(h.exportPdfSpy).not.toHaveBeenCalled()
    expect(h.printSpy).not.toHaveBeenCalled()
    // 装篮完成 → 切到练习集 Tab（打印/发送在那完成）
    expect(w.find('[data-testid="practicesets-section"]').exists()).toBe(true)
  })

  it('自定义组卷：范围默认「本周待复习」→ added_via=custom 装篮 + 切练习集 Tab', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="custom-paper-open"]').trigger('click')
    // 参数行含「范围」两档（本周待复习 / 全部未掌握）
    expect(w.find('[data-testid="paper-scope-week"]').exists()).toBe(true)
    expect(w.find('[data-testid="paper-scope-unmastered"]').exists()).toBe(true)
    // 按钮文案=「加入练习集」（不再「生成并打印」）
    const gen = w.find('[data-testid="custom-paper-gen"]')
    expect(gen.text()).toContain('加入练习集')
    expect(gen.text()).not.toContain('打印')
    await gen.trigger('click')
    await flushPromises()

    expect(h.addToBasketSpy).toHaveBeenCalledTimes(2) // 本周待复习 2 题
    expect(h.addToBasketSpy).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ added_via: 'custom', verification_status: 'pending' }),
    }))
    expect(h.exportPdfSpy).not.toHaveBeenCalled()
    expect(w.find('[data-testid="practicesets-section"]').exists()).toBe(true)
  })

  it('自定义组卷：范围「全部未掌握」取档案未掌握全量（排除 mastered/archived）', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="custom-paper-open"]').trigger('click')
    await w.find('[data-testid="paper-scope-unmastered"]').trigger('click')
    await w.find('[data-testid="custom-paper-gen"]').trigger('click')
    await flushPromises()

    // 档案 3 条里 mastered 的 c 被排除 → 2 次装篮
    expect(h.addToBasketSpy).toHaveBeenCalledTimes(2)
    const ids = h.addToBasketSpy.mock.calls.map((c) => (c[0] as { item: { source_problem_id: string } }).item.source_problem_id)
    expect(ids).toEqual(['a', 'b'])
  })

  it('自定义组卷：总题量 ≤ 限量截取（total=5 时不超 5）', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="custom-paper-open"]').trigger('click')
    // 选 ≤ 5（源只有 2 题，验证不因限量报错且逐题装篮）
    const chip5 = w.findAll('.chip').find((b) => b.text().includes('≤ 5'))!
    await chip5.trigger('click')
    await w.find('[data-testid="custom-paper-gen"]').trigger('click')
    await flushPromises()
    expect(h.addToBasketSpy).toHaveBeenCalledTimes(2)
  })

  it('装篮结果 toast 数字口径：added=false 计入去重（幂等不重复装）', async () => {
    h.addToBasketSpy
      .mockResolvedValueOnce({ record_id: 'ps-1', added: true })
      .mockResolvedValueOnce({ record_id: 'ps-1', added: false })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="build-review-set"]').trigger('click')
    await flushPromises()
    expect(h.addToBasketSpy).toHaveBeenCalledTimes(2)
    // toast 由 useToast 渲染在组件外，这里核心断言是不抛错且两次调用如实完成（N=1 / 去重 M=1 的入参链路）
    expect(w.find('[data-testid="practicesets-section"]').exists()).toBe(true)
  })

  it('溢出菜单的档案导出（错题本 PDF/Word）保留——那是档案导出非出卷', async () => {
    const w = render()
    await flushPromises()
    await w.findAll('.seg button').find((b) => b.text() === '全部错题')!.trigger('click')
    await w.find('.k12rec__export button').trigger('click')
    const pdfBtn = w.findAll('.k12rec__menu button').find((b) => b.text().includes('PDF'))
    expect(pdfBtn, '档案导出 PDF 菜单项应保留').toBeTruthy()
    await pdfBtn!.trigger('click')
    await flushPromises()
    expect(h.exportPdfSpy).toHaveBeenCalledTimes(1)
  })
})
