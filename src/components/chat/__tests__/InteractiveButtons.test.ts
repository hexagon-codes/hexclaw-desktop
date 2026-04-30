import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import InteractiveButtons from '../InteractiveButtons.vue'

describe('InteractiveButtons', () => {
  const buttons = [
    { label: '是', action: 'confirm', variant: 'primary' as const },
    { label: '不是', action: 'reject' },
  ]

  it('渲染按钮 + 可选 prompt', () => {
    const w = mount(InteractiveButtons, {
      props: { prompt: '是这道题吗？', buttons },
    })
    expect(w.text()).toContain('是这道题吗？')
    const btns = w.findAll('button')
    expect(btns).toHaveLength(2)
    expect(btns[0]!.text()).toBe('是')
    expect(btns[0]!.classes()).toContain('is-primary')
    expect(btns[1]!.classes()).toContain('is-secondary')
  })

  it('点击触发 select event 携带 action / label', async () => {
    const w = mount(InteractiveButtons, { props: { buttons } })
    await w.findAll('button')[0]!.trigger('click')
    const events = w.emitted('select')
    expect(events).toHaveLength(1)
    expect(events![0]![0]).toMatchObject({ action: 'confirm', label: '是' })
  })

  it('resolved 后所有按钮禁用 + 显示已选择 hint', () => {
    const w = mount(InteractiveButtons, {
      props: {
        buttons,
        resolved: { action: 'confirm', label: '是' },
      },
    })
    const btns = w.findAll('button')
    btns.forEach(b => expect(b.attributes('disabled')).toBeDefined())
    expect(btns[0]!.classes()).toContain('is-resolved')
    expect(w.text()).toContain('已选择：是')
  })
})
