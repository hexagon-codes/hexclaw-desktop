/**
 * R4 K12「本月辅导次数」月份时区错月
 *
 * src/features/k12/views/K12RecordsView.vue:65 曾用 `new Date().toISOString().slice(0,7)`
 * 取当月 YYYY-MM——这是 UTC 年月。在 UTC+8，每月头 8 小时（本地 00:00-07:59）UTC 仍停留在
 * 上一个月，导致「本月辅导次数」错按上月聚合。后端 studytime.go 用本地时区，两端口径不一致。
 *
 * 固定时区 Asia/Shanghai，把系统时间设到 2026-08-01 00:30(+08) = 2026-07-31T16:30:00Z：
 *   本地月 = 2026-08，UTC 月 = 2026-07。
 * days 给「本月(08)」5 次 + 「上月(07)」9 次。
 *   RED（修复前，用 UTC 月 2026-07）：会数上月 9 次 → 断言 5 失败。
 *   GREEN（修复后，用本地月 2026-08）：只数本月 5 次。
 */
process.env.TZ = 'Asia/Shanghai'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(), k12PrepCard: vi.fn(), k12Grade: vi.fn(),
  k12Recognize: vi.fn(), k12ColdStart: vi.fn(), k12ReviewRetry: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { total: 14, mastered: 6, reviewing: 4, retried: 1, archived: 0 },
    weak_top3: [], month_new_mistakes: 3, review_completion_rate: 0.5,
    consecutive_fail_kps: [], suggestion: '',
  }),
  // 本地 08 月 5 次；本地 07 月（= 当前 UTC 月）9 次
  k12StudyTime: vi.fn().mockResolvedValue({
    days: [
      { date: '2026-08-01', record_count: 5, estimated_minutes: 30 },
      { date: '2026-07-31', record_count: 9, estimated_minutes: 45 },
    ],
    total_records: 14, total_minutes: 75, note: '',
  }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12MistakeSheet: vi.fn(), k12ExportMd: vi.fn(), k12Backup: vi.fn(), k12Restore: vi.fn(),
  k12AddAccumulation: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

describe('R4 · 本月辅导次数按本地时区聚合（UTC+8 月初不错月）', () => {
  beforeEach(() => {
    // 只伪造 Date，保留真实定时器/微任务，避免 flushPromises 被卡住
    vi.useFakeTimers({ toFake: ['Date'] })
    // 2026-08-01 00:30:00 +08:00 —— 此刻 UTC 仍是 2026-07-31
    vi.setSystemTime(new Date('2026-07-31T16:30:00Z'))
    document.body.innerHTML = ''
  })
  afterEach(() => { vi.useRealTimers() })

  it('本地是 8 月 1 日凌晨时，只数本月(08) 5 次而非上月(07) 9 次', async () => {
    setActivePinia(createPinia())
    const w = mount(K12RecordsView, {
      props: { agentId: 'k12-x', agentName: '小明', grade: '五年级上' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    await w.findAll('.k12rec__tabs .seg button').find((b) => b.text() === '学情')!.trigger('click')
    await flushPromises()
    const tiles = w.findAll('.k12tile')
    expect(tiles[0]!.text()).toContain('5')
    expect(tiles[0]!.text()).not.toContain('9')
    expect(tiles[0]!.text()).toContain('本月辅导')
  })
})
