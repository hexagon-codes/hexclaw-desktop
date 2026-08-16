/**
 * 原型对齐（hexclaw-docs c8a194e · 20260709 错题本视觉/增长/文案评审定稿）——桌面端漏项 RED 锁。
 *
 * 已落地（1905199，不在此重测）：⋯溢出菜单 / 功能位图标化 / 学科定色 / 守答案真遮罩 / 他会了文案。
 * 本文件锁 4 个尚未接线的原型定稿点：
 *  ① 「本周该练」标题带跨科分布括号（数学 2 · 语文 1）——队列 subject 已知才计（诚实降级）；
 *  ② 趋势 pill 并入行动卡（PRD §3.5.7：确有进步=绿「趋势 ↑ 在进步」，否则琥珀「趋势 → 待巩固」）；
 *  ③ 行动卡内脚注「每周五 19:00 自动出下一卷 · 做对会自动升级状态」（后端 cronspec 0 19 * * 5 真实接线）；
 *  ④ 全部记录区标题「全部错题 (N)」（原型 summary 定稿文案，i18n allMistakes 已备未接）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'
import K12InsightPanel from '../views/K12InsightPanel.vue'

const h = vi.hoisted(() => {
  const mk = (id: string, q: string, kp: string, subject?: string) => ({
    record_id: id,
    question: q,
    knowledge_point: kp,
    error_cause: '示例',
    status: 'new',
    version: 0,
    due_at: 1710000000,
    subject,
  })
  return {
    // 全部 4 条；复习队列 3 条带 subject（数学 2 · 语文 1）——review-queue 契约下发 subject
    mistakes: [
      mk('a', '苹果和梨的价钱', '小数乘法'),
      mk('b', '解方程 2x+15=43', '简易方程'),
      mk('c', '「梅须逊雪三分白」漏「须」字', '默写'),
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
      mk('a', '苹果和梨的价钱', '小数乘法', '数学'),
      mk('b', '解方程 2x+15=43', '简易方程', '数学'),
      mk('c', '「梅须逊雪三分白」漏「须」字', '默写', '语文'),
    ],
    report: {
      learner_id: 'mingming',
      grade_term: '五年级上',
      as_of: '2026-07-25T08:00:00+08:00',
      source_digest: 'sha256:prototype-c8',
      source_record_ids: ['a', 'b', 'c', 'd'],
      unscoped_source_count: 0,
      review_week_start: '2026-07-24T19:00:00+08:00',
      review_week_end: '2026-07-31T19:00:00+08:00',
      trend: { mastered: 5, reviewing: 2, retried: 1, archived: 0, total: 8 },
      weak_top3: [],
      month_new_mistakes: 2,
      review_completion_rate: 0.5,
      consecutive_fail_kps: null,
      suggestion: '',
      week_pending: 3,
      practice_pending: 0,
    },
  }
})

vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('mingming'),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: h.due }),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12GetMistakePracticeGeneration: vi.fn().mockImplementation((_agent: string, recordID: string) =>
    Promise.resolve({ state: 'available', source_mistake_id: recordID })),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockImplementation(() => Promise.resolve(h.report)),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  // 其他档案页仍使用练习集列表；InsightPanel 只消费同一份报告快照。
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

describe('原型 c8a194e 对齐 · 错题本行动卡与档案区（20260709 定稿）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.report.trend.mastered = 5
  })

  it('①「本周该练」只投影服务端计划，不再从本地复习队列拼跨科行动卡', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('.weekly-hero').exists()).toBe(true)
    expect(w.find('.rl-review').exists()).toBe(false)
    expect(w.text()).not.toContain('数学 2')
    expect(w.text()).not.toContain('语文 1')
  })

  it('② 学情趋势数据可用时 hero 显示「趋势 ↑ 在进步」（用户 2026-08-16 批准方案 1）', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('.weekly-hero').exists()).toBe(true)
    expect(w.text()).toContain('趋势 ↑ 在进步')
  })

  it('② 趋势数据仍可用（mastered=0 但 total>0）时 hero 继续显示趋势 pill', async () => {
    h.report.trend.mastered = 0
    const w = render()
    await flushPromises()
    expect(w.find('.weekly-hero').exists()).toBe(true)
    expect(w.text()).toContain('趋势 ↑ 在进步')
  })

  it('③ 旧自动装篮与整周菜单退役，保存到练习集只保留单题入口', async () => {
    const w = render()
    await flushPromises()
    expect(w.text()).not.toContain('每周五 19:00 自动加入练习集')
    expect(w.find('[data-testid="weekly-more-trigger"]').exists()).toBe(false)
    await w.get('[data-testid="subtab-mistakes"]').trigger('click')
    const addOne = w.find('[data-testid^="mistake-practice-"]')
    expect(addOne.exists()).toBe(true)
    expect(addOne.text()).toBe('加入练习集')
  })

  it('⑤ 积累 tab 底部有分界规则脚注（原型 rc1：错了要改→错题 / 好东西要记住→积累）', async () => {
    const w = render()
    await flushPromises()
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '积累')!
      .trigger('click')
    expect(w.text(), '积累 tab 应渲染分界规则脚注（i18n dividerRule 已备未接）').toContain(
      '做错了要改',
    )
    expect(w.text()).toContain('遇到好东西要记住')
  })

  it('⑥ 学情（顶栏一等 Tab · K12InsightPanel）标题=学习概览 + 证据来源 note（原型 2613 月报口径退役）', async () => {
    // IA 迁移（2026-07-18）：学情从二级 Tab 抽到 K12InsightPanel；
    // 20260718 原型 2613：「学情报告·每月1日自动生成」→「学习概览 · 从真实批改与复练证据生成」
    const w = mount(K12InsightPanel, {
      props: { agentId: 'mingming' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    expect(w.text(), '学情标题应为学习概览（无 grade 时通用文案）').toContain('学习概览')
    expect(w.text(), '学情 note 应说明证据来源').toContain('从真实批改与复练证据生成')
    expect(w.text()).not.toContain('学情报告')
    expect(w.text()).not.toContain('每月 1 日自动生成')
  })

  it('④ 全部错题=独立档案页（IA 迁移：list-title 摘要退役，Tab 即标题）', async () => {
    const w = render()
    await flushPromises()
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    // 对象 Tab 是唯一标题（PRD §2）：档案页直接展开筛选+全量，无第二个「全部错题 (N)」标题
    expect(w.find('.k12rec__filter-stack').exists(), '档案页应直接显示学科与状态复合筛选').toBe(
      true,
    )
    // 定稿删除的说明书文案不得出现
    expect(w.text()).not.toContain('查看全部')
    expect(w.text()).not.toContain('可按科目')
  })
})
