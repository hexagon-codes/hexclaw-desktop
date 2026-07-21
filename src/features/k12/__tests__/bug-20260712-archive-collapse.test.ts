/**
 * IA 定稿（PRD §1.5，2026-07-18 迁移）：折叠机制随旧两段 IA 退役——
 * 「本周复习」= 行动页（只有复习行动卡，无档案行）；「全部错题」= 档案页（直接展开筛选 + 全量 + 归档脚注）。
 * 本文件从旧「档案折叠在行动卡下方」断言改写为新五对象 Tab 拆分语义（原 bug-20260712 折叠锁已被 IA 取代）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => {
  const mk = (id: string, q: string, kp: string, status = 'new', subject?: string) => ({
    record_id: id,
    question: q,
    knowledge_point: kp,
    error_cause: '示例',
    status,
    version: 0,
    due_at: 1710000000,
    subject,
  })
  return {
    mistakes: [
      mk('a', '苹果和梨的价钱', '小数乘法'),
      mk('b', '解方程 2x+15=43', '简易方程'),
      {
        record_id: 'd',
        question: '用数对表示位置',
        knowledge_point: '位置',
        error_cause: '行列反了',
        status: 'mastered',
        version: 2,
      },
    ],
    due: [
      mk('a', '苹果和梨的价钱', '小数乘法', 'new', '数学'),
      mk('b', '解方程 2x+15=43', '简易方程', 'new', '数学'),
    ],
    report: {
      trend: { mastered: 5, reviewing: 2, retried: 1, archived: 0, total: 8 },
      weak_top3: [],
      month_new_mistakes: 2,
      review_completion_rate: 0.5,
      consecutive_fail_kps: null,
      suggestion: '',
    },
  }
})

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: h.due }),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12ReviewRetry: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockImplementation(() => Promise.resolve(h.report)),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
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

describe('IA 定稿 · 本周复习=行动页 / 全部错题=档案页（折叠机制退役）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('① 默认落在「本周复习」：行动卡在、档案行不在', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="week-section"]').exists()).toBe(true)
    expect(w.find('.rl-review').exists(), '行动卡应在').toBe(true)
    // hide-list：档案筛选与全量行不渲染
    expect(w.find('.rl-filters').exists(), '本周复习不应有档案筛选').toBe(false)
    expect(w.text()).not.toContain('未掌握题不会因久未练习被自动隐藏')
  })

  it('② 切「全部错题」→ 档案页直接展开：筛选 + 全量 + 归档脚注，且无行动卡', async () => {
    const w = render()
    await flushPromises()
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    expect(w.find('[data-testid="mistakes-section"]').exists()).toBe(true)
    expect(w.find('.k12rec__filter-stack').exists(), '档案页应直接显示学科与状态复合筛选').toBe(
      true,
    )
    // 20260718 术语快修：原型 2527 口径——未掌握题不因久未练习被自动隐藏（旧「30 天自动归档」退役）
    expect(w.text(), '归档规则脚注应直接可见').toContain('未掌握题不会因久未练习被自动隐藏')
    expect(w.find('.rl-review').exists(), '档案页不应有复习行动卡（hide-review）').toBe(false)
  })

  it('③ 旧折叠开关不复存在（archive-toggle 已随 IA 退役）', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="archive-toggle"]').exists()).toBe(false)
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    expect(w.find('[data-testid="archive-toggle"]').exists()).toBe(false)
  })

  it('④ 行动卡含趋势 pill 与「查看学情」入口（学情=顶栏一等 Tab）', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('.rl-review').text()).toContain('2道待复习')
    const link = w.find('[data-testid="go-insights"]')
    expect(link.exists(), '行动卡脚注应有查看学情入口').toBe(true)
    await link.trigger('click')
    expect(w.emitted('go-insights'), '点击应上抛 go-insights').toBeTruthy()
  })

  it('⑤ 外层 target 变化可直达 week / mistakes / practiceSets，不丢学情路由目标', async () => {
    const w = render()
    await flushPromises()
    await w.setProps({ target: 'mistakes' })
    expect(w.find('[data-testid="mistakes-section"]').exists()).toBe(true)
    await w.setProps({ target: 'practiceSets' })
    await flushPromises()
    expect(w.find('[data-testid="practicesets-section"]').exists()).toBe(true)
    await w.setProps({ target: 'week' })
    expect(w.find('[data-testid="week-section"]').exists()).toBe(true)
  })
})
