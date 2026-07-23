/**
 * BUG-20260708 装机 live 巡检回归锁（下会话接手修复）。
 *
 * 覆盖：
 *  B8 · 错题本头卡重复：K12RecordsView 不得再自绘 `🎓 姓名 + 年级` 头（k12enh-tabs 已提供，
 *       两者同时渲染 → 图中「小明的辅导老师 · 五年级」出现两遍）。
 *  B2 · 建档表单原生 select：年级/教材下拉必须走 HcSelect（WKWebView 下原生 select 显 Aqua 样式），
 *       不得再有原生 `<select>`。
 *
 * 这些是结构性回归锁（jsdom 无 WKWebView 布局，测不了像素，故锁"重复 DOM / 原生控件"这类致因）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'
import K12ProfileForm from '../views/K12ProfileForm.vue'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12UpdateProfile: vi.fn().mockResolvedValue({}),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))
vi.mock('@/api/agents', () => ({
  registerAgent: vi.fn().mockResolvedValue({}),
  updateAgent: vi.fn().mockResolvedValue({}),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

describe('BUG-20260708 B8 · 错题本头卡不得重复姓名/年级', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('K12RecordsView 不自绘 .k12rec__head（避免与 k12enh-tabs 头重复渲染姓名/年级）', async () => {
    const w = mount(K12RecordsView, {
      props: { agentId: 'ming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    // 头卡（🎓 姓名 + 年级 pill）由外层 k12enh-tabs 唯一提供；记录视图内不得再渲染一份
    expect(w.find('.k12rec__head').exists()).toBe(false)
    expect(w.find('.k12rec__name').exists()).toBe(false)
  })
})

describe('BUG-20260708 B2 · 建档表单不得用原生 select', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('年级/教材下拉走 HcSelect（无原生 <select>）', () => {
    const w = mount(K12ProfileForm, {
      props: {},
      global: { plugins: [createPinia(), i18n()], stubs: { Teleport: true } },
    })
    // WKWebView 下原生 select 显 macOS Aqua 样式 → 必须全部换 HcSelect
    expect(w.findAll('select').length).toBe(0)
    // 两个 HcSelect（年级 + 教材）
    expect(w.findAll('.hc-select').length).toBeGreaterThanOrEqual(2)
  })
})
