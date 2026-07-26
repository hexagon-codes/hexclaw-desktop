import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import SearchInput from '../SearchInput.vue'
import searchSource from '../SearchInput.vue?raw'
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
  it('composes the global clearable-field primitive instead of owning a second clear implementation', () => {
    expect(searchSource).toContain("import HcClearableField from './HcClearableField.vue'")
    expect(searchSource).toContain('<HcClearableField')
    expect(searchSource).not.toContain('<X ')
    expect(searchSource).not.toContain("import { Search, X }")
  })

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

  it('shows clear button when has value', async () => {
    const wrapper = mountSearchInput({ modelValue: 'hello' })
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('button')).toHaveLength(1)
  })

  it('hides clear button when empty', () => {
    const wrapper = mountSearchInput({ modelValue: '' })
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('emits empty string on clear', async () => {
    const wrapper = mountSearchInput({ modelValue: 'hello' })
    await wrapper.vm.$nextTick()
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([''])
  })

  it('uses a pill-shaped embedded clear button', async () => {
    const wrapper = mountSearchInput({ modelValue: 'hello', clearTestId: 'search-clear' })
    await wrapper.vm.$nextTick()
    const root = wrapper.get('.hc-search')
    const clear = wrapper.get('[data-testid="search-clear"]')

    expect(root.classes()).toContain('hc-search')
    expect(clear.classes()).toContain('hc-search__clear')
  })

  it('supports fluid width without changing the embedded clear affordance', async () => {
    const wrapper = mountSearchInput({ modelValue: 'hello', fluid: true })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.hc-search').classes()).toContain('hc-search--fluid')
    expect(wrapper.findAll('.hc-search__clear')).toHaveLength(1)
  })

  it('emits submit on Enter', async () => {
    const wrapper = mountSearchInput({ modelValue: 'hello' })
    await wrapper.find('input').trigger('keydown.enter')
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('forwards non-submit keydown events for composite owners such as command palettes', async () => {
    const wrapper = mountSearchInput({ modelValue: 'hello' })
    await wrapper.find('input').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('keydown')?.[0]?.[0]).toMatchObject({ key: 'Escape' })
  })

  it('exposes focus and derives an accessible name from the visible placeholder', () => {
    const wrapper = mountSearchInput({
      modelValue: '',
      placeholder: '搜索模型',
    })
    const focus = vi.spyOn(wrapper.get('input').element, 'focus')
    ;(wrapper.vm as unknown as { focus: () => void }).focus()
    expect(focus).toHaveBeenCalledOnce()
    expect(wrapper.get('input').attributes('aria-label')).toBe('搜索模型')
  })
})
