import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'

const listSessionMessages = vi.hoisted(() => vi.fn())

vi.mock('@/api/chat', () => ({
  listSessions: vi.fn(),
  listSessionMessages,
  createSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  suggestSessionTitle: vi.fn(),
  deleteSession: vi.fn(),
  deleteMessage: vi.fn(),
  appendSessionMessage: vi.fn(),
}))

vi.mock('@/utils/file-parser', () => ({
  isDocumentFile: vi.fn().mockReturnValue(false),
  parseDocument: vi.fn(),
}))

vi.mock('@/composables/useVoice', () => ({
  useVoice: () => ({
    isListening: ref(false),
    transcript: ref(''),
    error: ref(''),
    isSupported: false,
    toggleListening: vi.fn(),
  }),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    thinkingEnabled: false,
  }),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  return Object.fromEntries(Object.keys(original).map((key) => [key, stub]))
})

import { useChatSend } from '@/composables/useChatSend'
import { loadMessages } from '@/services/messageService'

const FULL_SOURCE = String.raw`$1\frac{1}{2} \times \frac{2}{3} =$$2\frac{1}{4} \div \frac{9}{8} =$`

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

describe('BUG-20260723 · complete math source survives send and history replay', () => {
  it('keeps one identical string from ChatInput through optimistic display and reload', async () => {
    const messages: Array<{
      id: string
      role: 'user' | 'assistant'
      content: string
      timestamp: string
    }> = []
    const sendMessage = vi.fn().mockImplementation(async (content: string) => {
      messages.push({ id: 'user-math', role: 'user', content, timestamp: '2026-07-23' })
      return { id: 'assistant-math', role: 'assistant', content: 'ok', timestamp: '2026-07-23' }
    })
    const deps = {
      chatStore: {
        messages,
        sendMessage,
        chatMode: 'chat',
        agentRole: '',
        chatParams: { model: 'test-model' },
      },
      parsedDocument: ref(null),
      attachmentPreview: ref(null),
      clearAttachmentPreview: vi.fn(),
      scrollToBottom: vi.fn(),
      attachConversationAutomationActions: vi.fn().mockResolvedValue(undefined),
    }
    const { handleSend } = useChatSend(deps as never)
    const sendHandler = vi.fn((text: string) => handleSend(text))
    const ChatInput = (await import('../ChatInput.vue')).default
    const wrapper = mount(ChatInput, {
      props: { sendHandler },
      global: {
        plugins: [i18n()],
        stubs: {
          MentionPopup: { template: '<div />' },
          TemplatePopup: { template: '<div />' },
        },
      },
    })

    await wrapper.get('textarea').setValue(FULL_SOURCE)
    await wrapper.get('.hc-composer__send').trigger('click')
    await flushPromises()

    expect(sendHandler).toHaveBeenCalledWith(FULL_SOURCE, [], undefined)
    expect(sendMessage).toHaveBeenCalledWith(
      FULL_SOURCE,
      undefined,
      expect.objectContaining({ backendText: expect.any(Function) }),
    )
    expect(messages[0]?.content).toBe(FULL_SOURCE)

    listSessionMessages.mockResolvedValueOnce({
      messages: [{ ...messages[0], metadata: null }],
      total: 1,
    })
    const reloaded = await loadMessages('session-math')
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]?.role).toBe('user')
    expect(reloaded[0]?.content).toBe(FULL_SOURCE)
  })
})
