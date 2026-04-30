import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import InteractiveSelect from '../InteractiveSelect.vue'

describe('InteractiveSelect', () => {
  const options = [
    { label: '选项 A', value: 'a', description: 'a 的描述' },
    { label: '选项 B', value: 'b' },
  ]

  it('渲染所有选项 + prompt + description', () => {
    const w = mount(InteractiveSelect, {
      props: { prompt: '请选择', options },
    })
    expect(w.text()).toContain('请选择')
    const items = w.findAll('button[role="option"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('选项 A')
    expect(items[0]!.text()).toContain('a 的描述')
    expect(items[1]!.text()).toContain('选项 B')
  })

  it('点击触发 select event 携带 action/label/value', async () => {
    const w = mount(InteractiveSelect, { props: { options } })
    await w.findAll('button[role="option"]')[0]!.trigger('click')
    const events = w.emitted('select')
    expect(events).toHaveLength(1)
    expect(events![0]![0]).toMatchObject({ action: 'a', label: '选项 A', value: 'a' })
  })

  it('resolved 后所有选项禁用 + 显示 ✓ + hint', () => {
    const w = mount(InteractiveSelect, {
      props: { options, resolved: { action: 'a', label: '选项 A', value: 'a' } },
    })
    const items = w.findAll('button[role="option"]')
    items.forEach(b => expect(b.attributes('disabled')).toBeDefined())
    expect(items[0]!.classes()).toContain('is-resolved')
    expect(w.text()).toContain('已选择：选项 A')
  })

  it('resolved 但 label 缺失时回退到 value', () => {
    const w = mount(InteractiveSelect, {
      props: { options, resolved: { action: 'b', value: 'b' } },
    })
    expect(w.text()).toContain('已选择：b')
  })
})
