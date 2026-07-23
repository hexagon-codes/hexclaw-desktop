import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

const STORAGE_KEY = 'hexclaw.k12.grading-job-bindings.v1'

vi.mock('@/api/k12', () => ({
  k12GetViewDescriptor: vi.fn().mockResolvedValue({ composer_chips: [] }),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
    weak_top3: [],
    month_new_mistakes: 0,
    review_completion_rate: -1,
  }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0 }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

const GuardStub = defineComponent({
  name: 'RecognizeGuardPanel',
  props: { agentId: String, sessionId: String },
  template:
    '<div data-testid="guard-restore-stub" :data-agent="agentId" :data-session="sessionId" />',
})

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(agentId = 'mingming') {
  return mount(K12ChatEnhancement, {
    props: {
      agentId,
      agentName: '小明的辅导助手',
      sessionId: 'session-1',
      metadata: { 'k12.grade_term': '五年级上' },
      descriptor: K12_VIEW_DESCRIPTOR,
    },
    global: {
      plugins: [createPinia(), i18n()],
      stubs: { RecognizeGuardPanel: GuardStub },
    },
    attachTo: document.body,
  })
}

describe('K12 会话刷新后的 GradingJob 入口恢复', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.innerHTML =
      '<div id="hc-chat-scenario-inline"></div><div id="hc-chat-scenario-footer"></div>'
  })

  it('同 session+agent 有绑定时自动恢复原会话位置，并向护栏透传 sessionId', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'mingming', job_id: 'job-unknown' } },
      }),
    )
    render()
    await flushPromises()

    const guard = document.querySelector<HTMLElement>(
      '#hc-chat-scenario-inline [data-testid="guard-restore-stub"]',
    )
    expect(guard).not.toBeNull()
    expect(guard?.dataset.agent).toBe('mingming')
    expect(guard?.dataset.session).toBe('session-1')
  })

  it('相同 session 但 Agent 不匹配时不恢复，不把另一孩子的任务投影进来', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: { 'session-1': { agent_id: 'other-child', job_id: 'job-other' } },
      }),
    )
    render('mingming')
    await flushPromises()
    expect(document.querySelector('[data-testid="guard-restore-stub"]')).toBeNull()
  })
})
