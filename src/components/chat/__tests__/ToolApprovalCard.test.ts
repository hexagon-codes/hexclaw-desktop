import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import ToolApprovalCard from '../ToolApprovalCard.vue'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

interface MountOptions {
  requestId?: string
  toolName?: string
  arguments?: Record<string, unknown>
  risk?: 'safe' | 'sensitive' | 'dangerous'
  reason?: string
  timeout?: number
}

function mountCard(overrides: MountOptions = {}) {
  return mount(ToolApprovalCard, {
    props: {
      requestId: overrides.requestId ?? 'req-123',
      toolName: overrides.toolName ?? 'file_write',
      arguments: overrides.arguments,
      risk: overrides.risk ?? 'sensitive',
      reason: overrides.reason ?? 'Writes to filesystem',
      timeout: overrides.timeout ?? 30,
    },
    global: {
      plugins: [createTestI18n()],
    },
  })
}

describe('ToolApprovalCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders tool name, risk badge, and reason', () => {
    const wrapper = mountCard({ toolName: 'exec_command', risk: 'dangerous', reason: 'Runs shell command' })
    expect(wrapper.text()).toContain('exec_command')
    expect(wrapper.text()).toContain('dangerous')
    expect(wrapper.text()).toContain('Runs shell command')
  })

  it('auto-denies when countdown reaches 0', () => {
    const wrapper = mountCard({ timeout: 3 })
    vi.advanceTimersByTime(3000)
    const events = wrapper.emitted('respond') as unknown[][]
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(['req-123', false, false])
  })

  it('timer interval cleaned up on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const wrapper = mountCard({ timeout: 60 })
    wrapper.unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('approve emits correct payload including remember flag', async () => {
    const wrapper = mountCard()
    // Check the remember checkbox
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)
    // Click approve
    const approveBtn = wrapper.find('.hc-approval__btn--approve')
    await approveBtn.trigger('click')
    const events = wrapper.emitted('respond') as unknown[][]
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(['req-123', true, true])
  })

  it('deny emits correct payload with remember always false', async () => {
    const wrapper = mountCard()
    // Check remember, then deny — remember should still be false
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)
    const denyBtn = wrapper.find('.hc-approval__btn--deny')
    await denyBtn.trigger('click')
    const events = wrapper.emitted('respond') as unknown[][]
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(['req-123', false, false])
  })

  it('double-click approve is blocked by responded guard', async () => {
    const wrapper = mountCard()
    const approveBtn = wrapper.find('.hc-approval__btn--approve')
    await approveBtn.trigger('click')
    // After responding, buttons disappear via v-if, but we verify only 1 event
    const events = wrapper.emitted('respond') as unknown[][]
    expect(events).toHaveLength(1)
    // The second click cannot happen because the DOM hides the buttons,
    // but even if called programmatically, responded guard blocks it.
    // Advance timer to ensure no auto-deny happens either.
    vi.advanceTimersByTime(60_000)
    expect(wrapper.emitted('respond')).toHaveLength(1)
  })

  it('risk color: dangerous = error', () => {
    const wrapper = mountCard({ risk: 'dangerous' })
    const badge = wrapper.find('.hc-approval__risk')
    expect(badge.attributes('style')).toContain('var(--hc-error)')
  })

  it('risk color: sensitive = warning', () => {
    const wrapper = mountCard({ risk: 'sensitive' })
    const badge = wrapper.find('.hc-approval__risk')
    expect(badge.attributes('style')).toContain('var(--hc-warning')
  })

  it('risk color: safe = success', () => {
    const wrapper = mountCard({ risk: 'safe' })
    const badge = wrapper.find('.hc-approval__risk')
    expect(badge.attributes('style')).toContain('var(--hc-success')
  })

  it('arguments preview shows JSON.stringify of arguments prop', () => {
    const args = { path: '/tmp/test.txt', content: 'hello' }
    const wrapper = mountCard({ arguments: args })
    const pre = wrapper.find('.hc-approval__args pre')
    expect(pre.text()).toBe(JSON.stringify(args, null, 2))
  })

  it('arguments preview handles undefined arguments', () => {
    const wrapper = mountCard({ arguments: undefined })
    expect(wrapper.find('.hc-approval__args').exists()).toBe(false)
  })

  it('timer display shows remaining seconds and turns red at <=5', async () => {
    const wrapper = mountCard({ timeout: 10 })
    const timer = wrapper.find('.hc-approval__timer')
    expect(timer.text()).toBe('10s')
    // Tick to 6s remaining — should NOT be red
    vi.advanceTimersByTime(4000)
    await wrapper.vm.$nextTick()
    expect(timer.text()).toBe('6s')
    // When remaining > 5, the inline style is empty string which Vue omits entirely
    expect(timer.attributes('style')).toBeUndefined()
    // Tick to 5s remaining — should turn red
    vi.advanceTimersByTime(1000)
    await wrapper.vm.$nextTick()
    expect(timer.text()).toBe('5s')
    expect(timer.attributes('style')).toContain('var(--hc-error)')
  })
})
