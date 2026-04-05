import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import MessageActions from '../MessageActions.vue'

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
