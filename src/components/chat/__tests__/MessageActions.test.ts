import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import MessageActions from '../MessageActions.vue'

const { speakMock, stopMock, toastError, voiceError, isSpeaking } = vi.hoisted(() => ({
  speakMock: vi.fn(),
  stopMock: vi.fn(),
  toastError: vi.fn(),
  voiceError: { value: null as string | null },
  isSpeaking: { value: false },
}))

vi.mock('@/composables/useVoice', () => ({
  useVoice: () => ({
    isSpeaking,
    error: voiceError,
    speak: speakMock,
    stopSpeaking: stopMock,
  }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
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

function mountMessageActions(feedback: 'like' | 'dislike' | null) {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })

  return mount(MessageActions, {
    props: {
      role: 'assistant',
      content: 'test',
      feedback,
    },
    global: {
      plugins: [i18n],
    },
  })
}

describe('MessageActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    voiceError.value = null
    isSpeaking.value = false
  })

  it('replays persisted like state', () => {
    const wrapper = mountMessageActions('like')
    const buttons = wrapper.findAll('button')
    expect(buttons[0]?.classes()).toContain('hc-msg-actions__btn--active')
    expect(buttons[1]?.classes()).not.toContain('hc-msg-actions__btn--active-bad')
  })

  it('replays persisted dislike state', () => {
    const wrapper = mountMessageActions('dislike')
    const buttons = wrapper.findAll('button')
    expect(buttons[1]?.classes()).toContain('hc-msg-actions__btn--active-bad')
  })

  // Bug 复现(2026-06-25): 喇叭点了没反应 —— speak() 把后端错误(如 TTS 未配置)静默吞掉、零反馈。
  it('surfaces TTS failure via toast when speak fails', async () => {
    speakMock.mockImplementation(async () => { voiceError.value = 'TTS 服务未配置' })
    const wrapper = mountMessageActions(null)
    // 顺序: like(0) dislike(1) copy(2) speak(3) retry(4)
    const speakBtn = wrapper.findAll('button')[3]
    await speakBtn?.trigger('click')
    await flushPromises()
    expect(speakMock).toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })

  it('does not toast when speak succeeds', async () => {
    speakMock.mockImplementation(async () => { /* success: no error set */ })
    const wrapper = mountMessageActions(null)
    await wrapper.findAll('button')[3]?.trigger('click')
    await flushPromises()
    expect(speakMock).toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  // 重新生成（retry）按钮：对齐 ChatGPT/Claude/豆包/DeepSeek 的「重新生成」。
  // 顺序: like(0) dislike(1) copy(2) speak(3) retry(4)
  it('renders the regenerate (retry) button for assistant messages and emits retry', async () => {
    const wrapper = mountMessageActions(null)
    const retryBtn = wrapper.findAll('button')[4]
    expect(retryBtn?.attributes('title')).toBe(zhCN.chat.regenerate)
    await retryBtn?.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('copy button degrades gracefully when clipboard API is unavailable', async () => {
    const wrapper = mountMessageActions(null)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    const copyButton = wrapper.findAll('button')[2]
    await expect(copyButton?.trigger('click')).resolves.toBeUndefined()
    expect(wrapper.emitted('copy')).toHaveLength(1)
  })
})
