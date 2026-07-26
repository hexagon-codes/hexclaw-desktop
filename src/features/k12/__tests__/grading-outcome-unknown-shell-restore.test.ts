import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'
import { K12_IMAGE_TASK_BINDINGS_KEY } from '../image-task-binding'

const STORAGE_KEY = K12_IMAGE_TASK_BINDINGS_KEY

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
  props: {
    agentId: String,
    sessionId: String,
    sourceMessageId: String,
    restoreDispatchId: String,
  },
  template:
    '<div data-testid="guard-restore-stub" :data-agent="agentId" :data-session="sessionId" :data-source-message="sourceMessageId" :data-dispatch="restoreDispatchId" />',
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

describe('K12 会话刷新后的 ImageTaskDispatch 入口恢复', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.innerHTML =
      '<div id="hc-chat-scenario-inline-message-1"></div><div id="hc-chat-scenario-inline-message-2"></div><div id="hc-chat-scenario-footer"></div>'
  })

  it('同 session+agent 的多个绑定分别恢复到原消息锚点', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        bindings: [
          {
            source_session_id: 'session-1',
            agent_id: 'mingming',
            source_message_id: 'message-1',
            dispatch_id: 'dispatch-1',
          },
          {
            source_session_id: 'session-1',
            agent_id: 'mingming',
            source_message_id: 'message-2',
            dispatch_id: 'dispatch-2',
          },
        ],
      }),
    )
    render()
    await flushPromises()

    const guards = document.querySelectorAll<HTMLElement>(
      '[data-testid="guard-restore-stub"]',
    )
    expect(guards).toHaveLength(2)
    expect(
      document.querySelector<HTMLElement>(
        '#hc-chat-scenario-inline-message-1 [data-testid="guard-restore-stub"]',
      )?.dataset,
    ).toMatchObject({
      agent: 'mingming',
      session: 'session-1',
      sourceMessage: 'message-1',
      dispatch: 'dispatch-1',
    })
    expect(
      document.querySelector<HTMLElement>(
        '#hc-chat-scenario-inline-message-2 [data-testid="guard-restore-stub"]',
      )?.dataset,
    ).toMatchObject({
      sourceMessage: 'message-2',
      dispatch: 'dispatch-2',
    })
  })

  it('相同 session 但 Agent 不匹配时不恢复，不把另一孩子的任务投影进来', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        bindings: [
          {
            source_session_id: 'session-1',
            agent_id: 'other-child',
            source_message_id: 'message-1',
            dispatch_id: 'dispatch-other',
          },
        ],
      }),
    )
    render('mingming')
    await flushPromises()
    expect(document.querySelector('[data-testid="guard-restore-stub"]')).toBeNull()
  })
})
