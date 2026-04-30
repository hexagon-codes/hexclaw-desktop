import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import InteractiveBlock from '../InteractiveBlock.vue'
import type { InteractivePayload } from '@/types'

describe('InteractiveBlock', () => {
  it('type=buttons 调度到 InteractiveButtons', async () => {
    const payload: InteractivePayload = {
      type: 'buttons',
      prompt: 'pick',
      buttons: [{ label: '是', action: 'yes', variant: 'primary' }],
    }
    const w = mount(InteractiveBlock, { props: { payload } })
    expect(w.text()).toContain('pick')
    expect(w.text()).toContain('是')
    await w.find('button').trigger('click')
    expect(w.emitted('select')![0]![0]).toMatchObject({ action: 'yes', label: '是' })
  })

  it('type=select 调度到 InteractiveSelect', async () => {
    const payload: InteractivePayload = {
      type: 'select',
      prompt: 'choose',
      options: [{ label: 'A', value: 'a' }],
    }
    const w = mount(InteractiveBlock, { props: { payload } })
    expect(w.text()).toContain('choose')
    expect(w.text()).toContain('A')
    await w.find('button[role="option"]').trigger('click')
    expect(w.emitted('select')![0]![0]).toMatchObject({ action: 'a', label: 'A', value: 'a' })
  })

  it('type=approval 调度到 InteractiveApproval', async () => {
    const payload: InteractivePayload = {
      type: 'approval',
      approval: { subject: 'OK?' },
    }
    const w = mount(InteractiveBlock, { props: { payload } })
    expect(w.text()).toContain('OK?')
    await w.findAll('button')[0]!.trigger('click')
    expect(w.emitted('select')![0]![0]).toMatchObject({ approved: true })
  })

  it('type=card 调度到 InteractiveCard', async () => {
    const payload: InteractivePayload = {
      type: 'card',
      card: {
        title: 'T',
        buttons: [{ label: 'B', action: 'b' }],
      },
    }
    const w = mount(InteractiveBlock, { props: { payload } })
    expect(w.text()).toContain('T')
    await w.find('button').trigger('click')
    expect(w.emitted('select')![0]![0]).toMatchObject({ action: 'b' })
  })

  it('payload 无效（buttons 为空）时不渲染任何子组件', () => {
    const payload: InteractivePayload = { type: 'buttons', buttons: [] }
    const w = mount(InteractiveBlock, { props: { payload } })
    expect(w.html()).not.toContain('button')
  })

  it('resolved 透传给 buttons 子组件', () => {
    const payload: InteractivePayload = {
      type: 'buttons',
      buttons: [{ label: 'X', action: 'x' }],
      resolved: { action: 'x', label: 'X' },
    }
    const w = mount(InteractiveBlock, { props: { payload } })
    expect(w.find('button').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('已选择')
  })
})
