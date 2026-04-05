import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ChatSearchDialog from '../ChatSearchDialog.vue'
import zhCN from '@/i18n/locales/zh-CN'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
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

describe('ChatSearchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps scroll target valid when results shrink after navigating to a later match', async () => {
    const wrapper = mount(ChatSearchDialog, {
      props: {
        messages: [
          { id: 'm1', role: 'assistant', content: 'alpha one', timestamp: '2026-01-01' },
          { id: 'm2', role: 'assistant', content: 'alpha two', timestamp: '2026-01-02' },
        ],
      },
      global: {
        plugins: [createTestI18n()],
      },
    })

    await flushPromises()

    const input = wrapper.get('input')
    await input.setValue('alpha')
    await flushPromises()

    const nextBtn = wrapper.findAll('button')[1]!
    await nextBtn.trigger('click')
    await flushPromises()

    const scrollTo1 = wrapper.emitted('scrollTo')!
    expect(scrollTo1[scrollTo1.length - 1]).toEqual(['m2'])

    await wrapper.setProps({
      messages: [{ id: 'm2', role: 'assistant', content: 'alpha two', timestamp: '2026-01-02' }],
    })
    await flushPromises()

    const scrollTo2 = wrapper.emitted('scrollTo')!
    expect(scrollTo2[scrollTo2.length - 1]).toEqual(['m2'])
  })
})
