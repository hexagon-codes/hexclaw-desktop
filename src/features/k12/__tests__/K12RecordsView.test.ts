import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => {
  const mistakes = [
    { record_id: 'a', question: '苹果和梨的价钱', knowledge_point: '小数乘法', error_cause: '计算失误·进位', status: 'new', version: 0, due_at: 1710000000 },
    { record_id: 'b', question: '解方程 2x+15=43', knowledge_point: '简易方程', error_cause: '移项符号错', status: 'new', version: 1, due_at: 1710000000 },
    { record_id: 'c', question: '梯形果园的面积', knowledge_point: '简易方程', error_cause: '公式记错', status: 'mastered', version: 2 },
  ]
  return { mistakes, markMasteredSpy: vi.fn().mockResolvedValue({ ok: true }) }
})
const markMasteredSpy = h.markMasteredSpy

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistakes[0]] }),
  k12MarkMastered: (req: unknown) => h.markMasteredSpy(req),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 5, reviewing: 2, retried: 1, archived: 0, total: 8 },
    weak_top3: [{ knowledge_point: '简易方程', count: 2 }, { knowledge_point: '小数乘法', count: 1 }],
    month_new_mistakes: 9,
    review_completion_rate: 0.78,
    consecutive_fail_kps: ['简易方程'],
    suggestion: '「简易方程」连续受挫，建议本周集中复习。',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({
    days: [{ date: '2026-07-07', record_count: 3, estimated_minutes: 45 }],
    total_records: 3, total_minutes: 45, note: '近似值',
  }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
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
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

describe('K12RecordsView（M1-6 记录 + M3-6 复习 + M3-7 学情）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    markMasteredSpy.mockClear()
  })

  it('挂载即拉取错题本，按 schema 渲染错题 + 复习队列', async () => {
    const w = render()
    await flushPromises()
    expect(w.text()).toContain('苹果和梨的价钱')
    expect(w.text()).toContain('小数乘法')
    // 复习队列（due 列表含 record a）
    expect(w.find('.rl-review').exists()).toBe(true)
    expect(w.text()).toContain('本周该练')
  })

  it('「他会了」→ 调 mark-mastered 并带正确 record_id/version', async () => {
    const w = render()
    await flushPromises()
    // 复习队列第一行的"他会了"按钮
    const masteredBtn = w.findAll('.rl-btn').find((b) => b.text() === '已掌握')!
    await masteredBtn.trigger('click')
    await flushPromises()
    expect(markMasteredSpy).toHaveBeenCalledWith({ record_id: 'a', version: 0 })
  })

  it('学情 tab：真实 insight-report 驱动（薄弱 TOP3 + 连续挫败 + 建议）', async () => {
    const w = render()
    await flushPromises()
    await w.findAll('.seg button').find((b) => b.text() === '学情')!.trigger('click')
    expect(w.text()).toContain('薄弱知识点 TOP3')
    // 薄弱 bar 来自后端 weak_top3
    const bars = w.findAll('.k12bar')
    expect(bars[0]!.text()).toContain('简易方程')
    expect(bars[0]!.text()).toContain('2')
    // 连续挫败 + 本月建议（后端派生）
    expect(w.text()).toContain('连续挫败')
    expect(w.text()).toContain('集中复习')
    // 20260709：学习时长模块已删除——学情不再展示按日时长（口径不可信/诱导考核）。
    expect(w.text()).not.toContain('2026-07-07')
  })

  it('积累 tab：无后端 → 空态提示', async () => {
    const w = render()
    await flushPromises()
    await w.findAll('.seg button').find((b) => b.text() === '积累')!.trigger('click')
    expect(w.text()).toContain('积累本还没有内容')
  })
})
