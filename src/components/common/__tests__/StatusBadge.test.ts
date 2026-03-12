import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusBadge from '../StatusBadge.vue'

describe('StatusBadge', () => {
  it('renders online status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'online' } })
    expect(wrapper.text()).toBe('在线')
    const dot = wrapper.find('span.w-1\\.5')
    // jsdom 会将 hex 转为 rgb
    expect(dot.attributes('style')).toContain('rgb(34, 197, 94)')
  })

  it('renders error status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'error' } })
    expect(wrapper.text()).toBe('错误')
  })

  it('renders running status', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'running' } })
    expect(wrapper.text()).toBe('运行中')
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
  })
})
