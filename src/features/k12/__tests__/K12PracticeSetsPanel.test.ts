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
}))
vi.mock('@/api/k12', () => ({
  k12ListPracticeSets: (agent: string, status?: string) => h.listSpy(agent, status),
  k12FinalizePracticeSet: (a: string, id: string, via: string, target?: string) => h.finalizeSpy(a, id, via, target),
  k12RemoveFromBasket: (a: string, id: string, itemId: string) => h.removeSpy(a, id, itemId),
  k12AdvancePracticeSet: (a: string, id: string, step: string) => h.advanceSpy(a, id, step),
  k12CancelPracticeSet: (a: string, id: string) => h.cancelSpy(a, id),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
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
  }
}

function historySet(over: Partial<PracticeSetDTO> = {}): PracticeSetDTO {
  return {
    record_id: 'hist1', title: '小数乘法专项 · 07/12', source_kind: 'mixed', status: 'graded',
    status_label: '已批改', publishable: true, delivery_status: 'delivered',
    paper_no: 'P-2629-01', finalized_at: 1784300000, finalized_via: 'print',
    items: [item('q9', '2.8×0.65=?', '数学', 'verified')],
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
})

describe('K12PracticeSetsPanel · 购物车两段（§3.8/§4.13）', () => {
  it('空篮 + 空历史 → 双空态', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-basket-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="ps-history-empty"]').exists()).toBe(true)
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

  it('至少一道 verified → 打印/发送可用；打印走 finalize(print)', async () => {
    h.listSpy.mockResolvedValue({
      items: [basket([item('m1', '题', '数学', 'verified'), item('s1', '阻断题', '科学', 'needs_review')])],
    })
    const w = render()
    await flushPromises()
    expect(w.text()).toContain('1 道阻断题打印时跳过')
    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    expect(h.finalizeSpy).toHaveBeenCalledWith('k12-xiaoming', 'basket1', 'print', undefined)
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

  it('历史推进：assigned→回传(submit)；submitted→复批(grade)；graded→关闭(close)', async () => {
    h.listSpy.mockResolvedValue({ items: [historySet({ status: 'assigned', status_label: '待完成' })] })
    const w = render()
    await flushPromises()
    await w.findAll('.k12ps__btn').find((b) => b.text() === '回传作答')!.trigger('click')
    await flushPromises()
    expect(h.advanceSpy).toHaveBeenCalledWith('k12-xiaoming', 'hist1', 'submit')
  })
})
