/**
 * BUG-20260708 · 头部一致性锁（防漂移根治）。
 *
 * 漂移根因：K12 会话头部的控件曾被**硬编码**进组件（识题/渐进提示按钮），绕过 view-descriptor 契约 →
 * 头部过载、竖排断行。根治：头部动作**只**渲染 descriptor.actions 里 placement=header 的声明，组件零硬
 * 编码按钮。本锁断言"渲染出的头部动作集 == descriptor 声明集"，任何人再往头部硬编码控件即 FAIL（举一反三）。
 *
 * 同时锁死：识题/渐进提示**不在头部**（识题走 composer 拍照入口、渐进提示是辅导默认行为 + composer chip）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(), k12TutoringTips: vi.fn().mockResolvedValue({ knowledge_points: [], sections: [] }),
  k12Grade: vi.fn(), k12ColdStart: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({ header_tabs: [], message_badges: [], composer_placeholder: '', composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1 }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })
}
function render() {
  document.body.innerHTML = '<div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>'
  return mount(K12ChatEnhancement, {
    props: { agentId: 'ming', agentName: '小明的辅导老师', metadata: { 'k12.grade_term': '五年级上' }, descriptor: K12_VIEW_DESCRIPTOR },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  })
}

describe('BUG-20260708 头部 descriptor 一致性锁', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('头部动作按钮集 == descriptor.actions(placement=header)（零硬编码，防漂移）', () => {
    const w = render()
    const rendered = w.findAll('.k12enh-tabs [data-testid^="k12-header-action-"]')
    const declared = K12_VIEW_DESCRIPTOR.actions.filter((a) => a.placement === 'header')
    expect(rendered.length, '渲染的头部动作数必须等于 descriptor 声明数').toBe(declared.length)
    // 逐一：每个渲染按钮的 testid 对应一个声明 id（一对一，无多余硬编码）
    const renderedIds = rendered.map((b) => b.attributes('data-testid')!.replace('k12-header-action-', '')).sort()
    const declaredIds = declared.map((a) => a.id).sort()
    expect(renderedIds).toEqual(declaredIds)
  })

  it('识题/渐进提示不在头部（识题=composer 入口，渐进提示=辅导默认行为）', () => {
    const w = render()
    const head = w.find('.k12enh-tabs')
    expect(head.find('[data-testid="k12-tutor-toggle"]').exists(), '渐进提示不该是头部按钮').toBe(false)
    expect(head.find('[data-testid="k12-recognize-toggle"]').exists(), '识题不该是头部按钮').toBe(false)
    expect(head.text()).not.toContain(k12Zh.tutor.title) // 渐进提示辅导 文案不在头部
  })

  it('descriptor 头部零动作（20260709：辅导要点内联进识题流，头部只留辅导/错题本 tab）', () => {
    const headerActs = K12_VIEW_DESCRIPTOR.actions.filter((a) => a.placement === 'header')
    expect(headerActs.map((a) => a.id)).toEqual([])
  })
})
