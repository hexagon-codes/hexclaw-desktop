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

function mountSearchInput(props: { modelValue: string; placeholder?: string; fluid?: boolean; inputTestId?: string; clearTestId?: string }) {
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

  it('renders an embedded search icon before the input', () => {
    const wrapper = mountSearchInput({ modelValue: '' })
    const root = wrapper.get('.hc-search')
    const icon = root.get('.hc-search__icon')
    const input = root.get('input')

    expect(wrapper.findAll('.hc-search__icon')).toHaveLength(1)
    expect(icon.element.compareDocumentPosition(input.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  it('uses a pill-shaped embedded clear button', () => {
    const wrapper = mountSearchInput({ modelValue: 'hello', clearTestId: 'search-clear' })
    const root = wrapper.get('.hc-search')
    const clear = wrapper.get('[data-testid="search-clear"]')

    expect(root.classes()).toContain('hc-search')
    expect(clear.classes()).toContain('hc-search__clear')
  })

  it('supports fluid width without changing the embedded clear affordance', () => {
    const wrapper = mountSearchInput({ modelValue: 'hello', fluid: true })
    expect(wrapper.get('.hc-search').classes()).toContain('hc-search--fluid')
    expect(wrapper.findAll('.hc-search__clear')).toHaveLength(1)
  })

  it('emits submit on Enter', async () => {
    const wrapper = mountSearchInput({ modelValue: 'hello' })
    await wrapper.find('input').trigger('keydown.enter')
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })
})
