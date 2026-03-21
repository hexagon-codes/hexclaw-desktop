import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import SearchInput from '../SearchInput.vue'
import zhCN from '@/i18n/locales/zh-CN'

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountSearchInput(props: { modelValue: string; placeholder?: string }) {
  return mount(SearchInput, {
    props,
    global: {
      plugins: [createTestI18n()],
    },
  })
}

describe('SearchInput', () => {
  it('renders with placeholder', () => {
    const wrapper = mountSearchInput({ modelValue: '', placeholder: '搜索...' })
    const input = wrapper.find('input')
    expect(input.attributes('placeholder')).toBe('搜索...')
  })

  it('emits update:modelValue on input', async () => {
    const wrapper = mountSearchInput({ modelValue: '' })
    const input = wrapper.find('input')
    await input.setValue('test')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['test'])
  })

  it('shows clear button when has value', () => {
    const wrapper = mountSearchInput({ modelValue: 'hello' })
    expect(wrapper.findAll('button')).toHaveLength(1)
  })

  it('hides clear button when empty', () => {
    const wrapper = mountSearchInput({ modelValue: '' })
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('emits empty string on clear', async () => {
    const wrapper = mountSearchInput({ modelValue: 'hello' })
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([''])
  })
})
