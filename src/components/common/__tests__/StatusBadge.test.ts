import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import StatusBadge from '../StatusBadge.vue'
import zhCN from '@/i18n/locales/zh-CN'

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountStatusBadge(status: 'online' | 'offline' | 'error' | 'warning' | 'idle' | 'running') {
  return mount(StatusBadge, {
    props: { status },
    global: {
      plugins: [createTestI18n()],
    },
  })
}

describe('StatusBadge', () => {
  it('renders online status', () => {
    const wrapper = mountStatusBadge('online')
    expect(wrapper.text()).toBe('在线')
    expect(wrapper.find('.hc-badge--online').exists()).toBe(true)
    expect(wrapper.find('.hc-badge__dot').exists()).toBe(true)
  })

  it('renders error status', () => {
    const wrapper = mountStatusBadge('error')
    expect(wrapper.text()).toBe('错误')
    expect(wrapper.find('.hc-badge--error').exists()).toBe(true)
  })

  it('renders running status', () => {
    const wrapper = mountStatusBadge('running')
    expect(wrapper.text()).toBe('运行中')
    expect(wrapper.find('.hc-badge--running').exists()).toBe(true)
  })

  it('renders offline status', () => {
    const wrapper = mountStatusBadge('offline')
    expect(wrapper.text()).toBe('离线')
  })

  it('renders idle status', () => {
    const wrapper = mountStatusBadge('idle')
    expect(wrapper.text()).toBe('空闲')
  })

  it('renders warning status', () => {
    const wrapper = mountStatusBadge('warning')
    expect(wrapper.text()).toBe('警告')
    expect(wrapper.find('.hc-badge--warning').exists()).toBe(true)
  })
})
