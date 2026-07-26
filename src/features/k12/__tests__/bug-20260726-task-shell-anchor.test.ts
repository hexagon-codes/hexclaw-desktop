import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import chatViewSource from '@/views/ChatView.vue?raw'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

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
    sourceMessageId: String,
    requestId: String,
    restoreDispatchId: String,
  },
  template:
    '<div data-testid="task-shell-stub" :data-source-message-id="sourceMessageId" :data-request-id="requestId" :data-dispatch-id="restoreDispatchId" />',
})

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function payload(messageId: string) {
  return {
    dataUrl: `data:image/png;base64,${messageId}`,
    attachment: {
      type: 'image' as const,
      name: `${messageId}.png`,
      mime: 'image/png',
      data: messageId,
    },
    requestId: messageId,
    sourceSessionId: 'session-1',
  }
}

function mountEnhancement(composerImage = payload('image-message-1')) {
  return mount(K12ChatEnhancement, {
    props: {
      agentId: 'mingming',
      agentName: '小明的辅导助手',
      sessionId: 'session-1',
      descriptor: K12_VIEW_DESCRIPTOR,
      composerImage,
    },
    global: {
      plugins: [createPinia(), i18n()],
      stubs: { RecognizeGuardPanel: GuardStub },
    },
    attachTo: document.getElementById('mount')!,
  })
}

describe('BUG-20260726-009 · TaskShell source message anchor', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = `
      <div id="thread">
        <div id="msg-image-message-1">图片一</div>
        <div id="hc-chat-scenario-inline-image-message-1"></div>
        <div id="msg-math-message">后发数学题</div>
        <div id="hc-chat-scenario-inline-math-message"></div>
        <div id="msg-image-message-2">图片二</div>
        <div id="hc-chat-scenario-inline-image-message-2"></div>
      </div>
      <div id="hc-chat-scenario-inline"></div>
      <div id="mount"></div>
    `
  })

  it('通用消息循环在每条消息之后提供稳定 source_message_id 锚点', () => {
    expect(chatViewSource).toMatch(
      /scenarioMessageAnchorId\(msg\.id\)[\s\S]*data-source-message-id/,
    )
  })

  it('图片任务始终位于原图片消息之后、后发数学消息之前', async () => {
    mountEnhancement()
    await flushPromises()

    const shell = document.querySelector<HTMLElement>(
      '#hc-chat-scenario-inline-image-message-1 [data-testid="task-shell-stub"]',
    )
    const laterMessage = document.getElementById('msg-math-message')!
    expect(shell).not.toBeNull()
    expect(shell?.dataset.sourceMessageId).toBe('image-message-1')
    expect(
      shell!.compareDocumentPosition(laterMessage) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(document.querySelector('#hc-chat-scenario-inline [data-testid="task-shell-stub"]')).toBeNull()
  })

  it('同一会话两个并发图片任务分别保留自己的 TaskShell', async () => {
    const wrapper = mountEnhancement()
    await flushPromises()
    await wrapper.setProps({ composerImage: payload('image-message-2') })
    await flushPromises()

    expect(
      document.querySelectorAll('[data-testid="task-shell-stub"]'),
    ).toHaveLength(2)
    expect(
      document.querySelector(
        '#hc-chat-scenario-inline-image-message-1 [data-testid="task-shell-stub"]',
      ),
    ).not.toBeNull()
    expect(
      document.querySelector(
        '#hc-chat-scenario-inline-image-message-2 [data-testid="task-shell-stub"]',
      ),
    ).not.toBeNull()
  })
})
