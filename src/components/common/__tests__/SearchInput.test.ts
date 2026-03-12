import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SearchInput from '../SearchInput.vue'

describe('SearchInput', () => {
  it('renders with placeholder', () => {
    const wrapper = mount(SearchInput, {
      props: { modelValue: '', placeholder: '搜索...' },
    })
    const input = wrapper.find('input')
    expect(input.attributes('placeholder')).toBe('搜索...')
  })

  it('emits update:modelValue on input', async () => {
    const wrapper = mount(SearchInput, {
      props: { modelValue: '' },
    })
    const input = wrapper.find('input')
    await input.setValue('test')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['test'])
  })

  it('shows clear button when has value', () => {
    const wrapper = mount(SearchInput, {
      props: { modelValue: 'hello' },
    })
    expect(wrapper.findAll('button')).toHaveLength(1)
  })

  it('hides clear button when empty', () => {
    const wrapper = mount(SearchInput, {
      props: { modelValue: '' },
    })
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('emits empty string on clear', async () => {
    const wrapper = mount(SearchInput, {
      props: { modelValue: 'hello' },
    })
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([''])
  })
})
