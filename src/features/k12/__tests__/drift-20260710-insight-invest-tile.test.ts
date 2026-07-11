/**
 * 漂移-缺 M1（review-fullstack 20260710 全桌面巡检）：学情 mini-grid 缺原型首块
 * 「N 次 本月辅导（一题多轮计 1 次）」——学习时长退役时明文指定的投入感兜底
 * （app.html:1611-1616 四块 vs 实现三块；K12RecordsView:192 注释承诺了却没渲染，
 * i18n tiles.tutorCount 键三语齐备也没用上）。另缺 1618 行学期汇总 note。
 *
 * 口径（诚实，零后端改动）：本月辅导次数 = /study-time 当月各日 record_count 求和
 * （每条错题/积累记录 ≈ 一题一次，与 studytime.go「基于记录活跃估算」同源）。
 * 学期汇总行：总数/已掌握/待复习/已重做取 insight trend；分科段仅当 mistakes
 * 下发 subject 时渲染（/mistakes subject 是已知 P2 后端缺口，不编造）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const { ym } = vi.hoisted(() => {
  const now = new Date()
  return { ym: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` }
})

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [
    { id: 'm1', title: '3.8×3 算成 10.4', status: 'new', created_at: '2026-07-01T10:00:00Z', fields: {}, subject: '数学' },
    { id: 'm2', title: 'believe 拼错', status: 'mastered', created_at: '2026-07-02T10:00:00Z', fields: {}, subject: '英语' },
  ] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(), k12PrepCard: vi.fn(), k12Grade: vi.fn(),
  k12Recognize: vi.fn(), k12ColdStart: vi.fn(), k12ReviewRetry: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { total: 11, mastered: 6, reviewing: 4, retried: 1, archived: 0 },
    weak_top3: [{ knowledge_point: '小数乘法', count: 3 }],
    month_new_mistakes: 9, review_completion_rate: 0.78,
    consecutive_fail_kps: [], suggestion: '本月建议',
  }),
  // 当月两天 12+16=28 次触点；跨月天不计
  k12StudyTime: vi.fn().mockResolvedValue({
    days: [
      { date: `${ym}-03`, record_count: 12, estimated_minutes: 60 },
      { date: `${ym}-05`, record_count: 16, estimated_minutes: 80 },
      { date: '2001-01-01', record_count: 99, estimated_minutes: 5 },
    ],
    total_records: 127, total_minutes: 145, note: '',
  }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12MistakeSheet: vi.fn(), k12ExportMd: vi.fn(), k12Backup: vi.fn(), k12Restore: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

async function mountInsight() {
  setActivePinia(createPinia())
  const w = mount(K12RecordsView, {
    props: { agentId: 'k12-tutor-x', agentName: '小明的辅导助手', grade: '五年级上' },
    global: { plugins: [createPinia(), i18n()] },
  })
  await flushPromises()
  await w.findAll('.k12rec__tabs .seg button').find((b) => b.text() === '学情')!.trigger('click')
  await flushPromises()
  return w
}

describe('M1 · 学情投入感块与学期汇总（对齐原型 app.html:1611-1618）', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('★mini-grid 首块 = 本月辅导 N 次（study-time 当月 record_count 求和，跨月不计）', async () => {
    const w = await mountInsight()
    const tiles = w.findAll('.k12tile')
    expect(tiles.length, '原型 mini-grid 为 4 块').toBe(4)
    expect(tiles[0]!.text()).toContain('28')
    expect(tiles[0]!.text()).toContain('本月辅导')
  })

  it('★学期汇总 note 行：总数/状态计数齐备,分科段随 subject 数据渲染', async () => {
    const w = await mountInsight()
    const note = w.find('[data-testid="k12-semester-note"]')
    expect(note.exists(), '应有学期汇总 note 行（原型 1618）').toBe(true)
    expect(note.text()).toContain('本学期错题共 11 条')
    expect(note.text()).toContain('已掌握 6')
    expect(note.text()).toContain('待复习 4')
    expect(note.text()).toContain('已重做 1')
    // 两条 mistakes 带 subject（数学/英语）→ 分科段应渲染
    expect(note.text()).toContain('数学 1')
    expect(note.text()).toContain('英语 1')
  })
})
