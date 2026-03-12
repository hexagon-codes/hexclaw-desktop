import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmDialog from '../ConfirmDialog.vue'

describe('ConfirmDialog', () => {
  it('is hidden when open is false', () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: false },
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.find('.fixed').exists()).toBe(false)
  })

  it('shows when open is true', () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.find('.fixed').exists()).toBe(true)
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
      props: { open: true },
      global: { stubs: { Teleport: true } },
    })
    const buttons = wrapper.findAll('button')
    const confirmBtn = buttons[buttons.length - 1]!
    await confirmBtn.trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('emits cancel on cancel click', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    })
    const cancelBtn = wrapper.findAll('button')[0]!
    await cancelBtn.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
