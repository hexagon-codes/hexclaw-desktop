import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PageHeader from '../PageHeader.vue'

describe('PageHeader', () => {
  it('renders title', () => {
    const wrapper = mount(PageHeader, {
      props: { title: '设置' },
    })
    expect(wrapper.find('h1').text()).toBe('设置')
  })

  it('renders title and description', () => {
    const wrapper = mount(PageHeader, {
      props: { title: '日志', description: '查看系统日志' },
    })
    expect(wrapper.find('h1').text()).toBe('日志')
    expect(wrapper.find('p').text()).toBe('查看系统日志')
  })

  it('renders actions slot', () => {
    const wrapper = mount(PageHeader, {
      props: { title: '测试' },
      slots: { actions: '<button id="btn">按钮</button>' },
    })
    expect(wrapper.find('#btn').exists()).toBe(true)
  })

  it('hides description when not provided', () => {
    const wrapper = mount(PageHeader, {
      props: { title: '标题' },
    })
    expect(wrapper.findAll('p')).toHaveLength(0)
  })
})
