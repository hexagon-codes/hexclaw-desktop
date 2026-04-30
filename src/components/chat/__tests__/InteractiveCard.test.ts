import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import InteractiveCard from '../InteractiveCard.vue'

describe('InteractiveCard', () => {
  it('渲染 title/fields/footer/image', () => {
    const w = mount(InteractiveCard, {
      props: {
        card: {
          title: '订单 #1234',
          fields: [
            { label: '状态', value: '待付款', short: true },
            { label: '金额', value: '¥99.00' },
          ],
          image: 'https://example.com/img.png',
          footer: '更新于 2026-04-28',
        },
      },
    })
    expect(w.text()).toContain('订单 #1234')
    expect(w.text()).toContain('状态')
    expect(w.text()).toContain('待付款')
    expect(w.text()).toContain('金额')
    expect(w.text()).toContain('¥99.00')
    expect(w.text()).toContain('更新于 2026-04-28')
    expect(w.find('img').attributes('src')).toBe('https://example.com/img.png')
  })

  it('无按钮时不渲染 button row', () => {
    const w = mount(InteractiveCard, {
      props: { card: { title: 'A', fields: [{ label: 'k', value: 'v' }] } },
    })
    expect(w.findAll('button')).toHaveLength(0)
  })

  it('渲染 buttons + 点击 emit select', async () => {
    const w = mount(InteractiveCard, {
      props: {
        card: {
          title: '审批',
          buttons: [
            { label: '通过', action: 'pass', variant: 'primary' as const },
            { label: '驳回', action: 'fail', variant: 'danger' as const },
          ],
        },
      },
    })
    const btns = w.findAll('button')
    expect(btns).toHaveLength(2)
    expect(btns[0]!.classes()).toContain('is-primary')
    expect(btns[1]!.classes()).toContain('is-danger')

    await btns[0]!.trigger('click')
    expect(w.emitted('select')![0]![0]).toMatchObject({ action: 'pass', label: '通过' })
  })

  it('resolved 后所有按钮禁用 + 显示 ✓ + hint', () => {
    const w = mount(InteractiveCard, {
      props: {
        card: {
          title: '审批',
          buttons: [{ label: '通过', action: 'pass' }],
        },
        resolved: { action: 'pass', label: '通过' },
      },
    })
    const btn = w.find('button')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.classes()).toContain('is-resolved')
    expect(w.text()).toContain('已选择：通过')
  })
})
