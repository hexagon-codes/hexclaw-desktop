import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12PracticeSetsPanel from '../views/K12PracticeSetsPanel.vue'
import type { PracticeSetDTO, PracticeItemDTO } from '@/api/k12'

// 练习集面板（§3.8 购物车两段 · §4.13 呈现物）：待打印篮（学科分组+阻断沉底+移除）+ 打印历史（paper_no+三态）。
const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  finalizeSpy: vi.fn(),
  removeSpy: vi.fn(),
  advanceSpy: vi.fn(),
  cancelSpy: vi.fn(),
  paperSpy: vi.fn(),
  printSpy: vi.fn(),
  uploadSpy: vi.fn(),
  submitSpy: vi.fn(),
  gradeSpy: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListPracticeSets: (agent: string, status?: string) => h.listSpy(agent, status),
  k12FinalizePracticeSet: (a: string, id: string, via: string, target?: string) => h.finalizeSpy(a, id, via, target),
  k12RemoveFromBasket: (a: string, id: string, itemId: string) => h.removeSpy(a, id, itemId),
  k12AdvancePracticeSet: (a: string, id: string, step: string) => h.advanceSpy(a, id, step),
  k12CancelPracticeSet: (a: string, id: string) => h.cancelSpy(a, id),
  k12GetPracticePaper: (a: string, id: string, kind: string) => h.paperSpy(a, id, kind),
  k12UploadAsset: (a: string, file: File) => h.uploadSpy(a, file),
  k12SubmitPracticeSet: (a: string, id: string, req: unknown) => h.submitSpy(a, id, req),
  k12GradePracticeSet: (a: string, id: string, results: Array<{ item_id: string; correct: boolean }>) => h.gradeSpy(a, id, results),
  k12AssetURL: (agent: string, assetId: string) => `/asset/${agent}/${encodeURIComponent(assetId)}`,
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    success: h.toastSuccess,
    error: h.toastError,
    info: h.toastInfo,
    warning: h.toastWarning,
  }),
}))
vi.mock('../export', () => ({
  printPracticePaper: (markdown: string, title: string) => h.printSpy(markdown, title),
  savePracticePaperPdf: vi.fn().mockResolvedValue(true),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

function item(id: string, q: string, subject: string, status: PracticeItemDTO['verification_status'], via = 'weekly'): PracticeItemDTO {
  return {
    item_id: id, question_markdown: q, subject, added_via: via as PracticeItemDTO['added_via'],
    verification_status: status,
    verification_evidence: status === 'verified' ? '独立验算' : undefined,
    blocked_reason: status !== 'verified' ? '验证器未达质量门' : undefined,
  }
}

function basket(items: PracticeItemDTO[]): PracticeSetDTO {
  return {
    record_id: 'basket1', title: '待打印篮', source_kind: 'mixed', status: 'draft',
    status_label: '草稿', publishable: false, delivery_status: 'not_sent', items,
    return_assets: [],
  }
}

function historySet(over: Partial<PracticeSetDTO> = {}): PracticeSetDTO {
  return {
    record_id: 'hist1', title: '小数乘法专项 · 07/12', source_kind: 'mixed', status: 'graded',
    status_label: '已批改', publishable: true, delivery_status: 'delivered',
    paper_no: 'P-2629-01', finalized_at: 1784300000, finalized_via: 'print',
    items: [item('q9', '2.8×0.65=?', '数学', 'verified')],
    return_assets: [],
    ...over,
  }
}

function render() {
  return mount(K12PracticeSetsPanel, {
    props: { agentId: 'k12-xiaoming' },
    global: { plugins: [i18n()] },
  })
}

beforeEach(() => {
  h.listSpy.mockReset()
  h.finalizeSpy.mockReset().mockResolvedValue({ set: historySet({ status: 'assigned', status_label: '待完成' }), skipped_blocked_count: 2 })
  h.removeSpy.mockReset().mockResolvedValue(basket([]))
  h.advanceSpy.mockReset().mockResolvedValue(historySet())
  h.cancelSpy.mockReset().mockResolvedValue(historySet({ status: 'cancelled', status_label: '已取消' }))
  h.paperSpy.mockReset().mockResolvedValue({
    kind: 'question', title: '小数乘法专项 · 07/12', paper_no: 'P-2629-01',
    markdown: '# 小数乘法专项\n\n1. 2.8×0.65=?', preview: false,
  })
  h.printSpy.mockReset().mockResolvedValue(true)
  h.uploadSpy.mockReset().mockResolvedValue({ asset_id: 'asset://k12-xiaoming/return.png', size: 3 })
  h.submitSpy.mockReset().mockResolvedValue(historySet({ status: 'submitted', status_label: '已回传' }))
  h.gradeSpy.mockReset().mockResolvedValue(historySet())
  h.toastSuccess.mockReset()
  h.toastError.mockReset()
  h.toastInfo.mockReset()
  h.toastWarning.mockReset()
})

describe('K12PracticeSetsPanel · 购物车两段（§3.8/§4.13）', () => {
  it('空篮 + 空历史 → 双空态', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-basket-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="ps-history-empty"]').exists()).toBe(true)
  })

  it('练习集列表加载失败 → 页面内保留重试入口', async () => {
    h.listSpy.mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-error"]').text()).toContain('网络中断')
    await w.find('[data-testid="ps-load-retry"]').trigger('click')
    await flushPromises()
    expect(h.listSpy).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="ps-error"]').exists()).toBe(false)
  })

  it('篮内按学科分组（§4.13 顺序），阻断题沉底成组且降透明', async () => {
    h.listSpy.mockResolvedValue({
      items: [basket([
        item('c1', '默写：梅须逊雪', '语文', 'verified'),
        item('m1', '2.8×0.65=?', '数学', 'verified'),
        item('s1', '闭合电路判断', '科学', 'needs_review'),
      ])],
    })
    const w = render()
    await flushPromises()
    const groups = w.findAll('.k12ps__group').map((g) => g.text())
    // 数学在语文前（§4.13 卷面顺序），阻断组沉底
    expect(groups[0]).toBe('数学')
    expect(groups[1]).toBe('语文')
    expect(w.find('[data-testid="ps-blocked-group"]').exists()).toBe(true)
    expect(w.find('.k12ps__item--blocked').exists()).toBe(true)
    // verified 题连续编号，阻断题无号
    const seqs = w.findAll('.k12ps__seq').map((s) => s.text())
    expect(seqs).toEqual(['1', '2', '–'])
  })

  it('篮内逐题可移除（购物车对称操作）', async () => {
    h.listSpy.mockResolvedValue({ items: [basket([item('m1', '2.8×0.65=?', '数学', 'verified')])] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-remove-item"]').trigger('click')
    await flushPromises()
    expect(h.removeSpy).toHaveBeenCalledWith('k12-xiaoming', 'basket1', 'm1')
  })

  it('原生打印取消/失败 → 不固化待打印篮；成功回执后才 finalize', async () => {
    h.listSpy.mockResolvedValue({
      items: [basket([item('m1', '题', '数学', 'verified'), item('s1', '阻断题', '科学', 'needs_review')])],
    })
    h.paperSpy.mockResolvedValue({
      kind: 'question', title: '待打印篮', paper_no: '',
      markdown: '# 待打印篮\n\n1. 2.8×0.65=?', preview: true,
    })
    h.printSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const w = render()
    await flushPromises()
    expect(w.text()).toContain('1 道阻断题打印时跳过')

    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    expect(h.paperSpy).toHaveBeenCalledWith('k12-xiaoming', 'basket1', 'question')
    expect(h.printSpy).toHaveBeenCalledWith('# 待打印篮\n\n1. 2.8×0.65=?', '待打印篮')
    expect(h.finalizeSpy).not.toHaveBeenCalled()

    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    expect(h.finalizeSpy).toHaveBeenCalledWith('k12-xiaoming', 'basket1', 'print', undefined)
  })

  it('发送端只返回 pending → 明示待投递，禁止 toast 虚报发送成功', async () => {
    h.listSpy.mockResolvedValue({ items: [basket([item('m1', '题', '数学', 'verified')])] })
    h.finalizeSpy.mockResolvedValue({
      set: historySet({ status: 'assigned', status_label: '待完成', delivery_status: 'pending', delivery_target: '手机私聊' }),
      skipped_blocked_count: 0,
      delivery_note: '卷已固化，投递待执行',
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-finalize-send"]').trigger('click')
    await flushPromises()

    expect(h.toastInfo).toHaveBeenCalledWith('卷已固化，投递待执行')
    expect(h.toastSuccess).not.toHaveBeenCalled()
  })

  it('全阻断篮 → 固化禁用并提示', async () => {
    h.listSpy.mockResolvedValue({ items: [basket([item('s1', '阻断', '科学', 'needs_review')])] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-finalize-print"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('还没有已验证的题')
  })

  it('打印历史：paper_no 徽标 + 三态呈现（graded→已批改）+ finalized_at 倒序', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        historySet({ record_id: 'old', title: '旧卷', finalized_at: 100, paper_no: 'P-2628-01' }),
        historySet({ record_id: 'new', title: '新卷', finalized_at: 200, paper_no: 'P-2629-02', status: 'assigned', status_label: '待完成' }),
      ],
    })
    const w = render()
    await flushPromises()
    const cards = w.findAll('.k12ps__hcard')
    expect(cards[0]!.text()).toContain('新卷') // 倒序：新在前
    expect(cards[0]!.text()).toContain('P-2629-02')
    expect(cards[0]!.text()).toContain('待完成') // assigned → 三态「待完成」
    expect(cards[1]!.text()).toContain('已批改') // graded → 三态「已批改」
    // 界面不展示六态时间轴（§3.8）
    expect(w.find('.practice-timeline').exists()).toBe(false)
  })

  it('assigned 回传必须先选照片和照片覆盖题；空输入不调用 submit', async () => {
    h.listSpy.mockResolvedValue({ items: [historySet({ status: 'assigned', status_label: '待完成' })] })
    const w = render()
    await flushPromises()
    await w.findAll('.k12ps__btn').find((b) => b.text() === '回传作答')!.trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="ps-return-modal"]').exists()).toBe(true)
    expect(w.find('[data-testid="ps-return-confirm"]').attributes('disabled')).toBeDefined()
    expect(h.submitSpy).not.toHaveBeenCalled()

    const file = new File(['png'], 'answer.png', { type: 'image/png' })
    const input = w.find('[data-testid="ps-return-file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await w.find('[data-testid="ps-return-item-q9"]').setValue(true)
    await w.find('[data-testid="ps-return-confirm"]').trigger('click')
    await flushPromises()

    expect(h.uploadSpy).toHaveBeenCalledWith('k12-xiaoming', file)
    expect(h.submitSpy).toHaveBeenCalledWith('k12-xiaoming', 'hist1', {
      return_id: expect.any(String),
      item_ids: ['q9'],
      asset_id: 'asset://k12-xiaoming/return.png',
    })
  })

  it('DD-028：两批照片逐次追加并显示覆盖题号，第二批不覆盖第一批', async () => {
    const q1 = { ...item('q1', '第 1 题', '数学', 'verified'), paper_seq: 1 }
    const q2 = { ...item('q2', '第 2 题', '数学', 'verified'), paper_seq: 2 }
    const initial = historySet({ status: 'assigned', status_label: '待完成', items: [q1, q2] })
    const firstReturn = {
      return_id: 'return-1', asset_id: 'asset://k12-xiaoming/one.png',
      item_ids: ['q1'], returned_at: 1784300100,
    }
    const secondReturn = {
      return_id: 'return-2', asset_id: 'asset://k12-xiaoming/two.png',
      item_ids: ['q2'], returned_at: 1784300200,
    }
    h.listSpy.mockResolvedValue({ items: [initial] })
    h.submitSpy
      .mockResolvedValueOnce(historySet({
        status: 'submitted', status_label: '已回传',
        items: [{ ...q1, returned: true, return_ids: ['return-1'] }, q2],
        return_assets: [firstReturn],
      }))
      .mockResolvedValueOnce(historySet({
        status: 'submitted', status_label: '已回传',
        items: [
          { ...q1, returned: true, return_ids: ['return-1'] },
          { ...q2, returned: true, return_ids: ['return-2'] },
        ],
        return_assets: [firstReturn, secondReturn],
      }))

    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-return-open"]').trigger('click')
    let input = w.find('[data-testid="ps-return-file"]')
    const firstFile = new File(['one'], 'one.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [firstFile] })
    await input.trigger('change')
    await w.find('[data-testid="ps-return-item-q1"]').setValue(true)
    await w.find('[data-testid="ps-return-confirm"]').trigger('click')
    await flushPromises()

    expect(w.findAll('[data-testid="ps-return-asset"]')).toHaveLength(1)
    expect(w.find('[data-testid="ps-return-asset"]').text()).toContain('照片 1')
    expect(w.find('[data-testid="ps-return-asset"]').text()).toContain('第 1 题')
    expect(w.find('[data-testid="ps-return-open"]').text()).toContain('继续上传')

    await w.find('[data-testid="ps-return-open"]').trigger('click')
    input = w.find('[data-testid="ps-return-file"]')
    const secondFile = new File(['two'], 'two.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [secondFile] })
    await input.trigger('change')
    await w.find('[data-testid="ps-return-item-q2"]').setValue(true)
    await w.find('[data-testid="ps-return-confirm"]').trigger('click')
    await flushPromises()

    const batches = w.findAll('[data-testid="ps-return-asset"]')
    expect(batches).toHaveLength(2)
    expect(batches[0]!.text()).toContain('照片 1')
    expect(batches[0]!.text()).toContain('第 1 题')
    expect(batches[1]!.text()).toContain('照片 2')
    expect(batches[1]!.text()).toContain('第 2 题')
  })

  it('DD-028：提交结果未知后原地重试复用同一 return_id 和已上传 asset，不重复上传', async () => {
    h.listSpy.mockResolvedValue({
      items: [historySet({ status: 'assigned', status_label: '待完成' })],
    })
    h.submitSpy
      .mockRejectedValueOnce(new Error('网络中断，结果未知'))
      .mockResolvedValueOnce(historySet({
        status: 'submitted', status_label: '已回传',
        items: [{ ...item('q9', '2.8×0.65=?', '数学', 'verified'), returned: true, return_ids: ['return-replay'] }],
        return_assets: [{
          return_id: 'return-replay', asset_id: 'asset://k12-xiaoming/return.png',
          item_ids: ['q9'], returned_at: 1784300100,
        }],
      }))
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-return-open"]').trigger('click')
    const file = new File(['png'], 'answer.png', { type: 'image/png' })
    const input = w.find('[data-testid="ps-return-file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await w.find('[data-testid="ps-return-item-q9"]').setValue(true)
    await w.find('[data-testid="ps-return-confirm"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="ps-return-error"]').text()).toContain('结果未知')
    const firstReq = h.submitSpy.mock.calls[0]![2] as { return_id: string }
    await w.find('[data-testid="ps-return-retry"]').trigger('click')
    await flushPromises()

    expect(h.uploadSpy).toHaveBeenCalledTimes(1)
    expect(h.submitSpy).toHaveBeenCalledTimes(2)
    expect((h.submitSpy.mock.calls[1]![2] as { return_id: string }).return_id).toBe(firstReq.return_id)
  })

  it('submitted 复批必须逐题明确对/错；空 results 不调用 grade', async () => {
    h.listSpy.mockResolvedValue({
      items: [historySet({
        status: 'submitted', status_label: '已回传',
        items: [{
          ...item('q9', '2.8×0.65=?', '数学', 'verified'),
          returned: true, return_ids: ['return-grade'],
        }],
        return_assets: [{
          return_id: 'return-grade', asset_id: 'asset://k12-xiaoming/answer.png',
          item_ids: ['q9'], returned_at: 1784300100,
        }],
      })],
    })
    const w = render()
    await flushPromises()
    await w.findAll('.k12ps__btn').find((b) => b.text() === '复批')!.trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="ps-grade-modal"]').exists()).toBe(true)
    expect(w.find('[data-testid="ps-grade-confirm"]').attributes('disabled')).toBeDefined()
    expect(h.gradeSpy).not.toHaveBeenCalled()

    await w.find('[data-testid="ps-grade-correct-q9"]').setValue(true)
    await w.find('[data-testid="ps-grade-confirm"]').trigger('click')
    await flushPromises()
    expect(h.gradeSpy).toHaveBeenCalledWith('k12-xiaoming', 'hist1', [{ item_id: 'q9', correct: true }])
  })
})
