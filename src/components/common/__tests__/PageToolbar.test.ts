import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import PageToolbar from '../PageToolbar.vue'
import zhCN from '@/i18n/locales/zh-CN'

function mountPageToolbar() {
  return mount(PageToolbar, {
    props: { searchPlaceholder: '搜索...' },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: 'zh-CN',
          fallbackLocale: 'zh-CN',
          messages: { 'zh-CN': zhCN, zh: zhCN },
        }),
      ],
    },
  })
}

describe('PageToolbar', () => {
  it('uses the shared search input with an embedded clear button', async () => {
    const wrapper = mountPageToolbar()

    const input = wrapper.get('input')
    await input.setValue('keyword')

    expect(wrapper.findAll('.hc-search__clear')).toHaveLength(1)
    const clear = wrapper.get('.hc-search__clear')

    await clear.trigger('click')

    const events = wrapper.emitted('search') ?? []
    expect(events[events.length - 1]).toEqual([''])
  })

  it('forwards Enter from the shared search input as a toolbar submit', async () => {
    const wrapper = mountPageToolbar()

    await wrapper.get('input').trigger('keydown.enter')

    expect(wrapper.emitted('search-submit')).toHaveLength(1)
  })
})
