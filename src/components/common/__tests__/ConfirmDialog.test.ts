import { afterEach, describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConfirmDialog from '../ConfirmDialog.vue'
import confirmDialogSource from '../ConfirmDialog.vue?raw'
import { DESTRUCTIVE_CONFIRM_COOLDOWN_MS } from '@/config/destructive-actions'

describe('ConfirmDialog', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is hidden when open is false', () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: false },
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.find('.hc-dialog-overlay').exists()).toBe(false)
  })

  it('shows when open is true', () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.find('.hc-dialog-overlay').exists()).toBe(true)
  })

  it('renders custom title and message', () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, title: '删除确认', message: '确定删除？' },
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.text()).toContain('删除确认')
    expect(wrapper.text()).toContain('确定删除？')
  })

  it('emits confirm on confirm click', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, danger: false },
      global: { stubs: { Teleport: true } },
    })
    const buttons = wrapper.findAll('button')
    const confirmBtn = buttons[buttons.length - 1]!
    await confirmBtn.trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('uses the global 1500ms cooldown for destructive actions by default', async () => {
    vi.useFakeTimers()
    expect(DESTRUCTIVE_CONFIRM_COOLDOWN_MS).toBe(1_500)
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, danger: true },
      global: { stubs: { Teleport: true } },
    })
    const buttons = wrapper.findAll('button')
    const confirmBtn = buttons[buttons.length - 1]!

    expect(confirmBtn.attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS - 1)
    expect(confirmBtn.attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(confirmBtn.attributes('disabled')).toBeUndefined()
  })

  it('never applies the destructive cooldown to recoverable informational actions', () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, danger: false },
      global: { stubs: { Teleport: true } },
    })
    const buttons = wrapper.findAll('button')
    expect(buttons[buttons.length - 1]!.attributes('disabled')).toBeUndefined()
  })

  it('emits cancel on cancel click', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    })
    const cancelBtn = wrapper.get('.hc-dialog__actions .hc-btn-secondary')
    await cancelBtn.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('provides the approved header close control and restores the invoking focus', async () => {
    const invoker = document.createElement('button')
    invoker.textContent = 'open'
    document.body.appendChild(invoker)
    invoker.focus()

    const wrapper = mount(ConfirmDialog, {
      props: { open: false },
      attachTo: document.body,
      global: { stubs: { Teleport: true } },
    })
    await wrapper.setProps({ open: true })
    await nextTick()

    const dialog = wrapper.get('[role="alertdialog"]')
    expect(dialog.element.contains(document.activeElement)).toBe(true)
    const close = wrapper.get('button[aria-label="Close dialog"]')
    await close.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)

    await wrapper.setProps({ open: false })
    await nextTick()
    expect(document.activeElement).toBe(invoker)

    wrapper.unmount()
    invoker.remove()
  })

  it('traps forward and backward Tab navigation inside the open dialog', async () => {
    const invoker = document.createElement('button')
    document.body.appendChild(invoker)
    invoker.focus()

    const wrapper = mount(ConfirmDialog, {
      props: { open: false, danger: false },
      attachTo: document.body,
      global: { stubs: { Teleport: true } },
    })
    await wrapper.setProps({ open: true })
    await nextTick()

    const buttons = wrapper.findAll('button')
    const first = buttons[0]!.element
    const last = buttons[buttons.length - 1]!.element

    last.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(first)

    first.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(document.activeElement).toBe(last)

    wrapper.unmount()
    invoker.remove()
  })

  it('restores the invoking focus when the parent closes the dialog directly', async () => {
    const invoker = document.createElement('button')
    document.body.appendChild(invoker)
    invoker.focus()

    const wrapper = mount(ConfirmDialog, {
      props: { open: false },
      attachTo: document.body,
      global: { stubs: { Teleport: true } },
    })
    await wrapper.setProps({ open: true })
    await nextTick()
    expect(wrapper.get('[role="alertdialog"]').element.contains(document.activeElement)).toBe(true)
    await wrapper.setProps({ open: false })

    expect(document.activeElement).toBe(invoker)

    wrapper.unmount()
    invoker.remove()
  })

  it('restores the invoking focus when the open dialog unmounts', async () => {
    const invoker = document.createElement('button')
    document.body.appendChild(invoker)
    invoker.focus()

    const wrapper = mount(ConfirmDialog, {
      props: { open: false },
      attachTo: document.body,
      global: { stubs: { Teleport: true } },
    })
    await wrapper.setProps({ open: true })
    await nextTick()
    expect(wrapper.get('[role="alertdialog"]').element.contains(document.activeElement)).toBe(true)
    wrapper.unmount()

    expect(document.activeElement).toBe(invoker)
    invoker.remove()
  })

  it('routes overlay dismissal through the shared cancel event', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    })

    await wrapper.get('.hc-dialog-overlay').trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('locks only the final confirm action until the configured delay elapses', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, confirmDelayMs: 5_000 },
      global: { stubs: { Teleport: true } },
    })
    const buttons = wrapper.findAll('button')
    const cancelBtn = wrapper.get('.hc-dialog__actions .hc-btn-secondary')
    const confirmBtn = buttons[buttons.length - 1]!

    expect(cancelBtn.attributes('disabled')).toBeUndefined()
    expect(confirmBtn.attributes('disabled')).toBeDefined()
    await confirmBtn.trigger('click')
    expect(wrapper.emitted('confirm')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(confirmBtn.attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(confirmBtn.attributes('disabled')).toBeUndefined()

    await confirmBtn.trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('clears an old delay and restarts the full delay whenever the dialog reopens', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ConfirmDialog, {
      props: { open: false, confirmDelayMs: 5_000 },
      global: { stubs: { Teleport: true } },
    })

    await wrapper.setProps({ open: true })
    await vi.advanceTimersByTimeAsync(4_000)
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })

    const currentConfirm = () => {
      const buttons = wrapper.findAll('button')
      return buttons[buttons.length - 1]!
    }
    expect(currentConfirm().attributes('disabled')).toBeDefined()

    // The stale first timer would fire here; it must not unlock the reopened dialog.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(currentConfirm().attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(currentConfirm().attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(1)
    await wrapper.vm.$nextTick()
    expect(currentConfirm().attributes('disabled')).toBeUndefined()
  })

  it('restarts the full delay when an open dialog switches to a different target', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, confirmDelayMs: 5_000, confirmationKey: 'session-1' },
      global: { stubs: { Teleport: true } },
    })
    const currentConfirm = () => {
      const buttons = wrapper.findAll('button')
      return buttons[buttons.length - 1]!
    }

    await vi.advanceTimersByTimeAsync(4_000)
    await wrapper.setProps({ confirmationKey: 'session-2' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(currentConfirm().attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(currentConfirm().attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(currentConfirm().attributes('disabled')).toBeUndefined()
  })

  it('cancels the open dialog with Escape and never confirms twice from rapid clicks', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, danger: false, confirmationKey: 'session-1' },
      attachTo: document.body,
      global: { stubs: { Teleport: true } },
    })
    const buttons = wrapper.findAll('button')
    const confirmBtn = buttons[buttons.length - 1]!
    await confirmBtn.trigger('click')
    await confirmBtn.trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)

    await wrapper.setProps({ confirmationKey: 'session-2' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps the delayed danger action visually inert while it is disabled', () => {
    const disabledDangerRule =
      confirmDialogSource.match(
        /\.hc-dialog__btn--danger:disabled,\s*\.hc-dialog__btn--danger:disabled:hover\s*\{([^}]*)\}/s,
      )?.[1] ?? ''

    expect(disabledDangerRule).toMatch(/background:\s*var\(--hc-error\)/)
    expect(disabledDangerRule).toMatch(/color:\s*#fff/)
    expect(disabledDangerRule).toMatch(/opacity:\s*0\.45/)
    expect(disabledDangerRule).toMatch(/transform:\s*none/)
    expect(disabledDangerRule).toMatch(/box-shadow:\s*none/)
    expect(disabledDangerRule).toMatch(/transition:\s*none/)
  })
})
