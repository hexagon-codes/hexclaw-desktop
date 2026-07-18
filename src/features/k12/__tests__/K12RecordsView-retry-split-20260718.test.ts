import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

// 2026-07-18 P2 清偿：「再练一道」题答分离（守答案遮罩红线：先别给孩子看）。
//   ① 后端拆出 question/answer → 题面立刻可见（孩子可以直接做题），解答默认遮罩；
//   ② 点「显示答案」才揭示解答；
//   ③ 装篮用拆分后的题面 + expected_answer（不再把题答混排全文塞进 question_markdown）；
//   ④ 后端拆不出（question 空）→ 回退整段遮罩（既有行为，最小闭环）。

const h = vi.hoisted(() => ({
  mistakes: [
    { record_id: 'a', question: '3.8×3=?', knowledge_point: '小数乘法', error_cause: '进位', status: 'new', version: 0, due_at: 1710000000 },
  ],
  retrySpy: vi.fn(),
  addToBasketSpy: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistakes[0]] }),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12ReviewRetry: (req: unknown) => h.retrySpy(req),
  k12AddToBasket: (req: unknown) => h.addToBasketSpy(req),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12RecordMistake: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 1 },
    weak_top3: [], month_new_mistakes: 1, review_completion_rate: 1,
    consecutive_fail_kps: [], suggestion: '',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

async function openRetry(w: ReturnType<typeof render>) {
  await flushPromises()
  await w.findAll('.rl-btn').find((b) => b.text() === '再练一道')!.trigger('click')
  await flushPromises()
}

const splitResp = {
  solution: '## 问题\n\n3.9 × 4 = ?\n\n## 解答\n\n先按整数算 39 × 4 = 156，再点小数点。\n\n## 答案\n\n**15.6**',
  question: '3.9 × 4 = ?',
  answer: '## 解答\n\n先按整数算 39 × 4 = 156，再点小数点。\n\n## 答案\n\n**15.6**',
  expected_answer: '15.6',
  verdict: 'agree',
  badge: 'verified-strong',
}

describe('K12RecordsView · 再练一道题答分离（P2 清偿）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.retrySpy.mockReset().mockResolvedValue(splitResp)
    h.addToBasketSpy.mockReset().mockResolvedValue({ record_id: 'basket1', added: true })
  })

  it('题面先显（不遮罩），解答默认遮罩，点显示答案才揭示', async () => {
    const w = render()
    await openRetry(w)
    // 题面区：立刻可见
    const qEl = w.find('[data-testid="retry-question"]')
    expect(qEl.exists(), '拆分后应有独立题面区').toBe(true)
    expect(qEl.text()).toContain('3.9 × 4 = ?')
    // 解答区：默认遮罩
    expect(w.find('.k12retry__bodywrap--masked').exists()).toBe(true)
    const reveal = w.find('[data-testid="retry-reveal"]')
    expect(reveal.exists()).toBe(true)
    await reveal.trigger('click')
    await flushPromises()
    expect(w.find('.k12retry__bodywrap--masked').exists()).toBe(false)
    expect(w.text()).toContain('15.6')
  })

  it('装篮用拆分题面 + expected_answer（不再塞题答混排全文）', async () => {
    const w = render()
    await openRetry(w)
    await w.find('[data-testid="retry-reveal"]').trigger('click')
    await w.find('[data-testid="retry-add-basket"]').trigger('click')
    await flushPromises()
    expect(h.addToBasketSpy).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'mingming',
      item: expect.objectContaining({
        question_markdown: '3.9 × 4 = ?',
        expected_answer_markdown: '15.6',
      }),
    }))
  })

  it('后端拆不出（question 空）→ 回退整段遮罩（既有行为）', async () => {
    h.retrySpy.mockResolvedValue({ solution: '变式题：4.2×3=? 解：12.6', verdict: 'agree', badge: '✅' })
    const w = render()
    await openRetry(w)
    expect(w.find('[data-testid="retry-question"]').exists()).toBe(false)
    expect(w.find('.k12retry__bodywrap--masked').exists()).toBe(true)
    await w.find('[data-testid="retry-reveal"]').trigger('click')
    expect(w.text()).toContain('12.6')
  })
})
