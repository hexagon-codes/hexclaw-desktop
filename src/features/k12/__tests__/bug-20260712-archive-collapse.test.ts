/**
 * 原型对齐（app.html:1598 + 设计注 1001）：全部错题 = 次级档案，默认折叠成 `<details>` 摘要，
 * 首屏让位给「本周该练」行动队列（对齐 Anki/墨墨/IXL：到期优先、档案次之）。
 *
 * 桌面端此前把 RecordList 的筛选 + 全量档案行常驻展开——与原型「点开才是全量+筛选」相悖。
 * 本文件 RED 锁：①「全部错题 (N)」是可点击折叠入口；②默认折叠（归档规则脚注 archnote 不在 DOM）；
 * ③展开后 archnote 出现、折叠 class 撤除；④「本周该练」行动卡在折叠/展开两态都常驻（不受档案折叠影响）。
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
    record_id: id, question: q, knowledge_point: kp, error_cause: '示例', status, version: 0, due_at: 1710000000, subject,
  })
  return {
    mistakes: [
      mk('a', '苹果和梨的价钱', '小数乘法'),
      mk('b', '解方程 2x+15=43', '简易方程'),
      { record_id: 'd', question: '用数对表示位置', knowledge_point: '位置', error_cause: '行列反了', status: 'mastered', version: 2 },
    ],
    due: [
      mk('a', '苹果和梨的价钱', '小数乘法', 'new', '数学'),
      mk('b', '解方程 2x+15=43', '简易方程', 'new', '数学'),
    ],
    report: {
      trend: { mastered: 5, reviewing: 2, retried: 1, archived: 0, total: 8 },
      weak_top3: [], month_new_mistakes: 2, review_completion_rate: 0.5,
      consecutive_fail_kps: null, suggestion: '',
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
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
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

describe('原型 app.html:1598 对齐 · 全部错题=默认折叠的次级档案', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('①「全部错题 (N)」是可点击折叠入口（非纯标题）', async () => {
    const w = render()
    await flushPromises()
    const toggle = w.find('[data-testid="archive-toggle"]')
    expect(toggle.exists(), '全部错题应是折叠开关按钮').toBe(true)
    expect(toggle.text()).toContain('全部错题 (3)')
  })

  it('② 默认折叠：归档规则脚注(archnote)不在 DOM + 折叠 class 生效', async () => {
    const w = render()
    await flushPromises()
    // archnote 走 v-if archiveOpen → 折叠态真不在 DOM（非仅 CSS 隐藏）
    expect(w.text()).not.toContain('30 天没再练的会自动归档')
    expect(w.find('.k12mistakes--collapsed').exists(), '默认应带折叠 class').toBe(true)
  })

  it('③ 点开 → archnote 出现 + 折叠 class 撤除（点开才是全量+筛选）', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="archive-toggle"]').trigger('click')
    expect(w.text(), '展开后应显归档规则脚注').toContain('30 天没再练的会自动归档')
    expect(w.find('.k12mistakes--collapsed').exists(), '展开后折叠 class 应撤除').toBe(false)
  })

  it('④「本周该练」行动卡在折叠/展开两态都常驻（档案折叠不影响首屏行动队列）', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('.rl-review').exists(), '折叠态行动卡应在').toBe(true)
    expect(w.find('.rl-review').text()).toContain('本周该练')
    await w.find('[data-testid="archive-toggle"]').trigger('click')
    expect(w.find('.rl-review').exists(), '展开态行动卡仍应在').toBe(true)
  })
})
