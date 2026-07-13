import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue({
    items: [{
      record_id: 'a1', subject: '语文', entry_type: '好词好句',
      content: '时间像海绵里的水，挤一挤总是有的', source: '课外阅读 · 主动收藏', status: '已积累',
    }],
  }),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 0 },
    weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1,
    consecutive_fail_kps: [], suggestion: '',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: (...args: unknown[]) => h.list(...args),
  k12AddAccumulation: vi.fn(),
  k12ReviewRetry: vi.fn(),
  k12ExportMd: vi.fn(),
}))

function render() {
  const i18n = createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明', grade: '五年级下' },
    global: { plugins: [createPinia(), i18n] },
  })
}

describe('BUG-20260714 积累本对齐 prototype/app.html:1618-1624', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.list.mockClear()
  })

  it('使用原型单行字段顺序，不显示错题状态筛选，并把新增入口放在顶栏', async () => {
    const w = render()
    await flushPromises()
    await w.findAll('.seg button').find((b) => b.text() === '积累')!.trigger('click')
    await flushPromises()

    const section = w.find('[data-testid="accum-prototype"]')
    expect(section.exists()).toBe(true)
    expect(section.find('.rl-filters').exists()).toBe(false)
    expect(section.find('.k12accum__bar').exists()).toBe(false)
    expect(w.find('.k12rec__tabs [data-testid="accum-add-open"]').exists()).toBe(true)

    const row = section.find('.k12accum__row')
    expect(row.exists()).toBe(true)
    expect(row.find('.k12accum__subject').text()).toBe('语文')
    expect(row.find('.k12accum__title').text()).toContain('时间像海绵里的水')
    expect(row.find('.k12accum__type').text()).toBe('好词好句')
    expect(row.find('.k12accum__source').text()).toBe('出处：课外阅读 · 主动收藏')
    expect(row.find('.k12accum__status').text()).toBe('—')

    const ordered = row.element.children
    expect([...ordered].map((el) => el.className)).toEqual([
      'k12accum__subject', 'k12accum__title', 'k12accum__type',
      'k12accum__source', 'k12accum__status k12accum__status--na', 'btn btn-ghost k12accum__detail',
    ])
  })
})
