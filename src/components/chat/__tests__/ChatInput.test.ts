import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'

vi.mock('@/composables/useVoice', () => ({
  useVoice: () => ({
    isListening: ref(false),
    transcript: ref(''),
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
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

async function mountChatInput(props: Record<string, unknown> = {}) {
  const ChatInput = (await import('../ChatInput.vue')).default
  return mount(ChatInput, {
    props,
    global: {
      plugins: [createTestI18n()],
      stubs: {
        MentionPopup: { template: '<div />' },
        TemplatePopup: { template: '<div />' },
      },
    },
  })
}

describe('ChatInput attachment capability gating', () => {
  it('omits image extensions when the selected model does not allow images', async () => {
    const wrapper = await mountChatInput({
      allowImage: false,
      allowVideo: false,
    })

    const input = wrapper.find('input[type="file"]')
    expect(input.attributes('accept')).not.toContain('.png')
    expect(input.attributes('accept')).not.toContain('.jpg')
  })

  it('includes video extensions only when video support is enabled', async () => {
    const wrapper = await mountChatInput({
      allowImage: true,
      allowVideo: true,
    })

    const input = wrapper.find('input[type="file"]')
    expect(input.attributes('accept')).toContain('.mp4')
    expect(input.attributes('accept')).toContain('.webm')
  })

  it('keeps the draft when sendHandler rejects the send request', async () => {
    const sendHandler = vi.fn().mockResolvedValue(false)
    const wrapper = await mountChatInput({ sendHandler })

    const textarea = wrapper.get('textarea')
    await textarea.setValue('draft message')
    await wrapper.get('.hc-composer__send').trigger('click')
    await flushPromises()

    expect(sendHandler).toHaveBeenCalledWith('draft message', [])
    expect((textarea.element as HTMLTextAreaElement).value).toBe('draft message')
  })

  it('clears the draft only after sendHandler accepts the send request', async () => {
    const sendHandler = vi.fn().mockResolvedValue(true)
    const wrapper = await mountChatInput({ sendHandler })

    const textarea = wrapper.get('textarea')
    await textarea.setValue('draft message')
    await wrapper.get('.hc-composer__send').trigger('click')
    await flushPromises()

    expect(sendHandler).toHaveBeenCalledWith('draft message', [])
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('does not submit twice while an async sendHandler is still pending', async () => {
    let resolveSend: ((value: boolean) => void) | null = null
    const sendHandler = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        }),
    )
    const wrapper = await mountChatInput({ sendHandler })

    const textarea = wrapper.get('textarea')
    await textarea.setValue('draft message')
    await wrapper.get('.hc-composer__send').trigger('click')
    await wrapper.get('.hc-composer__send').trigger('click')

    expect(sendHandler).toHaveBeenCalledTimes(1)

    resolveSend?.(true)
    await flushPromises()
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })
})
