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
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn().mockResolvedValue({ knowledge_points: [], sections: [] }),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({
    header_tabs: ['辅导', '错题本'], message_badges: [], composer_placeholder: '',
    composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1,
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

// bug（用户报）：点击进入辅导，头部显示的是 agent 的 ID 而非「小明的辅导老师·五年级」。
// 根因：agentName = cfg.display_name || name，display_name 在辅导路径为空 → 回退到内部 name(ID)。
// 修：K12ChatEnhancement 据 metadata(k12.child_name) 派生显示名，agentName 仅兜底。
describe('bug: 辅导头部显示名而非 ID', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = '<div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>'
  })

  it('agentName 是 ID 时，头部据 child_name 显示「小明的辅导老师」而非 ID', () => {
    const w = mount(K12ChatEnhancement, {
      props: {
        agentId: 'k12-x7f3a9',
        agentName: 'k12-x7f3a9', // display_name 缺失 → 回退到 ID
        metadata: { 'k12.child_name': '小明', 'k12.grade_term': '五年级上' },
        descriptor: K12_VIEW_DESCRIPTOR,
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    expect(w.find('.k12enh-av').text()).toBe('🎓')
    const header = w.find('.k12enh-name').text()
    expect(header).toContain('小明的辅导助手')
    expect(header).not.toContain('k12-x7f3a9')
  })

  it('无 child_name 时回退到 agentName（不崩）', () => {
    const w = mount(K12ChatEnhancement, {
      props: {
        agentId: 'a1', agentName: '某助教', metadata: {}, descriptor: K12_VIEW_DESCRIPTOR,
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    expect(w.find('.k12enh-name').text()).toContain('某助教')
  })
})
