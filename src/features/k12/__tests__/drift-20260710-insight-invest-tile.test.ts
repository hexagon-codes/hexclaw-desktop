/**
 * 漂移-缺 M1（20260710 巡检；20260718 按执行计划 §3.4 改口径）：学情 mini-grid 首块。
 *
 * 原首块「本月辅导 N 次」借 /study-time 记录活跃近似伪造辅导次数——架构设计
 * v0.5.0《明确不做》#6 不做学习时长与无证据投入指标，且 §5.7 派生指标口径表内
 * 无「辅导次数」。study-time 全链删除后，首块换 §5.7 合法指标「证据已掌握」
 * （report.trend.mastered，复练确认口径），并反向钉死「本月辅导」不回潮。
 * 20260721 以 app.html:2354 为唯一权威：总数/已掌握/本周待复习/待打印直接成为四块指标，
 * 旧学期汇总说明行退役，避免和同页指标重复。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12InsightPanel from '../views/K12InsightPanel.vue'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({
    items: [
      {
        id: 'm1',
        title: '3.8×3 算成 10.4',
        status: 'new',
        created_at: '2026-07-01T10:00:00Z',
        fields: {},
        subject: '数学',
      },
      {
        id: 'm2',
        title: 'believe 拼错',
        status: 'mastered',
        created_at: '2026-07-02T10:00:00Z',
        fields: {},
        subject: '英语',
      },
    ],
  }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12ColdStart: vi.fn(),
  k12GetMistakePracticeGeneration: vi.fn().mockImplementation((_agent: string, recordID: string) =>
    Promise.resolve({ state: 'available', source_mistake_id: recordID })),
  k12InsightReport: vi.fn().mockResolvedValue({
    learner: 'k12-tutor-x',
    grade_term: '五年级上',
    as_of: 1784937600,
    source_digest: 'sha256:drift-fixture',
    source_record_ids: ['m1', 'm2'],
    unscoped_source_count: 0,
    review_week_start: 1784900400,
    review_week_end: 1785505200,
    trend: { total: 11, mastered: 6, reviewing: 4, retried: 1, archived: 0 },
    weak_top3: [{ subject: '数学', knowledge_point: '小数乘法', count: 3, share: 1 / 3 }],
    month_new_mistakes: 9,
    week_pending: 0,
    practice_pending: 0,
    review_completion_rate: 0.78,
    consecutive_fail_kps: [],
    suggestion: '本月建议',
  }),
  // 反向契约：不提供 k12StudyTime——组件若仍引用该 API 会在此红掉
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  // 20260718 学情第四瓷片改练习集待打印：面板自拉 draft 篮
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
  k12MistakeSheet: vi.fn(),
  k12ExportMd: vi.fn(),
  k12Backup: vi.fn(),
  k12Restore: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

async function mountInsight() {
  setActivePinia(createPinia())
  const w = mount(K12InsightPanel, {
    props: { agentId: 'k12-tutor-x', agentName: '小明的辅导助手', grade: '五年级上' },
    global: { plugins: [createPinia(), i18n()] },
  })
  await flushPromises()
  // IA 迁移（2026-07-18）：学情=顶栏一等 Tab（K12InsightPanel 即根视图），无需切二级 Tab
  await flushPromises()
  return w
}

describe('M1 · 学情四项证据指标（对齐原型 app.html:2354）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('★前两块 = 本学期错题 + 证据已掌握；「本月辅导」不回潮', async () => {
    const w = await mountInsight()
    const tiles = w.findAll('.k12ins__tile')
    expect(tiles.length, 'mini-grid 仍为 4 块').toBe(4)
    expect(tiles[0]!.text()).toContain('11条')
    expect(tiles[0]!.text()).toContain('本学期错题')
    expect(tiles[1]!.text()).toContain('6条')
    expect(tiles[1]!.text()).toContain('证据已掌握')
    expect(w.text(), '辅导次数指标已退役（《明确不做》#6）').not.toContain('本月辅导')
  })

  it('★本周待复习取当前孩子 reviewQueue，旧汇总 note 不再重复展示', async () => {
    const w = await mountInsight()
    expect(w.get('[data-testid="insight-tile-week"]').text()).toBe('0条本周待复习')
    expect(w.find('[data-testid="k12-semester-note"]').exists()).toBe(false)
  })
})
