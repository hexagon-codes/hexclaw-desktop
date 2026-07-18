/**
 * R4（改写为反向契约，2026-07-18 执行计划 §3.4 study-time 退役）
 *
 * 原测试钉「本月辅导次数」的本地时区聚合口径。study-time 全链删除后
 * （架构设计 v0.5.0《明确不做》#6：不做学习时长与无证据投入指标；§5.7 派生指标
 * 口径表内无「辅导次数」），学情面板不得再展示「本月辅导 N 次」——
 * 该数字借错题/积累记录活跃近似伪造辅导次数，属零容忍风险。
 *
 * 反向契约：①学情面板任何位置不出现「本月辅导」文案；②首瓷片为 §5.7 合法
 * 指标「证据已掌握」（report.trend.mastered）；③面板不请求 /study-time
 * （api mock 未提供 k12StudyTime，若组件仍调用会直接抛错红掉）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12InsightPanel from '../views/K12InsightPanel.vue'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(), k12PrepCard: vi.fn(), k12Grade: vi.fn(),
  k12ColdStart: vi.fn(), k12ReviewRetry: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { total: 14, mastered: 6, reviewing: 4, retried: 1, archived: 0 },
    weak_top3: [], month_new_mistakes: 3, review_completion_rate: 0.5,
    consecutive_fail_kps: [], suggestion: '',
  }),
  // 反向契约：不提供 k12StudyTime——组件若仍引用该 API 会在此红掉
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
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

describe('反向契约 · 学情不展示辅导次数（《明确不做》#6）', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('★面板不出现「本月辅导」，首瓷片=证据已掌握（trend.mastered）', async () => {
    setActivePinia(createPinia())
    const w = mount(K12InsightPanel, {
      props: { agentId: 'k12-x', agentName: '小明', grade: '五年级上' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    expect(w.text()).not.toContain('本月辅导')
    expect(w.text()).not.toContain('学习时长')
    const tiles = w.findAll('.k12ins__tile')
    expect(tiles.length, 'mini-grid 仍 4 块').toBe(4)
    expect(tiles[0]!.text()).toContain('6 条')
    expect(tiles[0]!.text()).toContain('证据已掌握')
  })
})
