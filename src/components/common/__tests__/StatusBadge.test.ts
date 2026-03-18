import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusBadge from '../StatusBadge.vue'

describe('StatusBadge', () => {
  it('renders online status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'online' } })
    expect(wrapper.text()).toBe('在线')
    // 组件使用 BEM 类名 hc-badge--online 和 hc-badge__dot
    expect(wrapper.find('.hc-badge--online').exists()).toBe(true)
    expect(wrapper.find('.hc-badge__dot').exists()).toBe(true)
  })

  it('renders error status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'error' } })
    expect(wrapper.text()).toBe('错误')
    expect(wrapper.find('.hc-badge--error').exists()).toBe(true)
  })

  it('renders running status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'running' } })
    expect(wrapper.text()).toBe('运行中')
    expect(wrapper.find('.hc-badge--running').exists()).toBe(true)
  })

  it('renders offline status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'offline' } })
    expect(wrapper.text()).toBe('离线')
  })

  it('renders idle status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'idle' } })
    expect(wrapper.text()).toBe('空闲')
  })

  it('renders warning status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'warning' } })
    expect(wrapper.text()).toBe('警告')
    expect(wrapper.find('.hc-badge--warning').exists()).toBe(true)
  })
})
