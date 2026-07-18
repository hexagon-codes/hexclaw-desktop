import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12PracticeSetsPanel from '../views/K12PracticeSetsPanel.vue'
import type { PracticeSetDTO, PracticeItemDTO } from '@/api/k12'

// 2026-07-18 呈现物真实渲染（§4.13）前端契约：
//   ① 打印历史卡片提供「题目卷 / 答案卷」查看入口（kind=question|answer 调 paper 端点）；
//   ② 待打印区提供「预览题目卷」——draft 走后端同渲染器预览（诚实预览：预览口径=固化产物口径）；
//   ③ 弹窗为详情/预览类：单「关闭」按钮（§4.13 弹窗按钮裁决），题目卷不显示答案。

const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  paperSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListPracticeSets: (agent: string, status?: string) => h.listSpy(agent, status),
  k12GetPracticePaper: (agent: string, id: string, kind?: string) => h.paperSpy(agent, id, kind),
  k12FinalizePracticeSet: vi.fn(),
  k12RemoveFromBasket: vi.fn(),
  k12AdvancePracticeSet: vi.fn(),
  k12CancelPracticeSet: vi.fn(),
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

function item(id: string, q: string, subject: string, status: PracticeItemDTO['verification_status']): PracticeItemDTO {
  return {
    item_id: id, question_markdown: q, subject, added_via: 'weekly',
    verification_status: status,
    verification_evidence: status === 'verified' ? '独立验算' : undefined,
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
    record_id: 'hist1', title: '本周复习卷 · 07/18', source_kind: 'mixed', status: 'assigned',
    status_label: '待完成', publishable: true, delivery_status: 'not_sent',
    paper_no: 'P-2629-01', finalized_at: 1784300000, finalized_via: 'print',
    items: [item('q1', '解方程 2x+19=51', '数学', 'verified')],
    ...over,
  }
}

function render() {
  return mount(K12PracticeSetsPanel, {
    props: { agentId: 'k12-xiaoming' },
    global: {
      plugins: [i18n()],
      stubs: {
        MarkdownRenderer: { props: ['content'], template: '<div class="md-stub">{{ content }}</div>' },
      },
    },
  })
}

beforeEach(() => {
  h.listSpy.mockReset()
  h.paperSpy.mockReset().mockResolvedValue({
    kind: 'question', title: '本周复习卷 · 07/18', paper_no: 'P-2629-01',
    markdown: '# 本周复习卷 · 07/18\n\n卷面号 P-2629-01 · 2026/07/18\n\n1. 解方程 2x+19=51\n\n**答：**\n\n第 1/1 页 · P-2629-01',
    preview: false,
  })
})

describe('K12PracticeSetsPanel · 题目卷/答案卷真实渲染（§4.13）', () => {
  it('打印历史卡片有「题目卷 / 答案卷」入口；点题目卷 → kind=question 弹层渲染', async () => {
    h.listSpy.mockResolvedValue({ items: [historySet()] })
    const w = render()
    await flushPromises()
    const qBtn = w.find('[data-testid="ps-paper-question"]')
    const aBtn = w.find('[data-testid="ps-paper-answer"]')
    expect(qBtn.exists(), '历史卡片应有题目卷入口').toBe(true)
    expect(aBtn.exists(), '历史卡片应有答案卷入口').toBe(true)

    await qBtn.trigger('click')
    await flushPromises()
    expect(h.paperSpy).toHaveBeenCalledWith('k12-xiaoming', 'hist1', 'question')
    const modal = w.find('[data-testid="ps-paper-modal"]')
    expect(modal.exists()).toBe(true)
    expect(modal.text()).toContain('P-2629-01')
    expect(modal.text()).toContain('解方程 2x+19=51')
  })

  it('点答案卷 → kind=answer', async () => {
    h.listSpy.mockResolvedValue({ items: [historySet()] })
    h.paperSpy.mockResolvedValue({
      kind: 'answer', title: '本周复习卷 · 07/18', paper_no: 'P-2629-01',
      markdown: '# 本周复习卷 · 07/18 · 答案卷\n\n1. 解方程 2x+19=51\n\n**答案：** x = 16 · 独立验算',
      preview: false,
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-paper-answer"]').trigger('click')
    await flushPromises()
    expect(h.paperSpy).toHaveBeenCalledWith('k12-xiaoming', 'hist1', 'answer')
    expect(w.find('[data-testid="ps-paper-modal"]').text()).toContain('x = 16')
  })

  it('待打印区有「预览题目卷」；draft 预览走同一端点（诚实预览，preview 标注）', async () => {
    h.listSpy.mockResolvedValue({ items: [basket([item('m1', '3.8×3=?', '数学', 'verified')])] })
    h.paperSpy.mockResolvedValue({
      kind: 'question', title: '待打印篮', paper_no: '',
      markdown: '# 待打印篮\n\n预览 · 打印或发送后分配卷面号\n\n1. 3.8×3=?\n\n**答：**\n\n第 1/1 页 · 预览',
      preview: true,
    })
    const w = render()
    await flushPromises()
    const btn = w.find('[data-testid="ps-paper-preview"]')
    expect(btn.exists(), '待打印区应有预览题目卷入口').toBe(true)
    await btn.trigger('click')
    await flushPromises()
    expect(h.paperSpy).toHaveBeenCalledWith('k12-xiaoming', 'basket1', 'question')
    const modal = w.find('[data-testid="ps-paper-modal"]')
    expect(modal.text()).toContain('3.8×3=?')
    // 预览明示未固化（无卷面号）。
    expect(modal.text()).toContain('打印或发送后分配卷面号')
  })

  it('空篮（无已验证题）不显示预览入口', async () => {
    h.listSpy.mockResolvedValue({ items: [basket([item('s1', '阻断题', '科学', 'pending')])] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-paper-preview"]').exists()).toBe(false)
  })

  it('预览/查看弹窗是详情类：单「关闭」按钮可关闭（§4.13 弹窗裁决）', async () => {
    h.listSpy.mockResolvedValue({ items: [historySet()] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-paper-question"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="ps-paper-close"]').trigger('click')
    expect(w.find('[data-testid="ps-paper-modal"]').exists()).toBe(false)
  })
})
