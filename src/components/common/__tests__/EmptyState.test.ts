import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EmptyState from '../EmptyState.vue'

describe('EmptyState', () => {
  it('renders title and description', () => {
    const wrapper = mount(EmptyState, {
      props: { title: '暂无数据', description: '创建新内容开始使用' },
    })
    expect(wrapper.text()).toContain('暂无数据')
    expect(wrapper.text()).toContain('创建新内容开始使用')
  })

  it('renders without description', () => {
    const wrapper = mount(EmptyState, {
      props: { title: '空' },
    })
    expect(wrapper.text()).toContain('空')
    expect(wrapper.findAll('p')).toHaveLength(0)
  })

  it('renders slot content', () => {
    const wrapper = mount(EmptyState, {
      props: { title: '空' },
      slots: { default: '<button>操作</button>' },
    })
    expect(wrapper.text()).toContain('操作')
  })
})
