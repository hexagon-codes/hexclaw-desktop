import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ContextMenu from '../ContextMenu.vue'

describe('ContextMenu anchored interaction', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('anchors to a trigger, focuses the first action, and returns focus on Escape', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'more'
    trigger.getBoundingClientRect = vi.fn(() => ({
      x: 120, y: 40, left: 120, top: 40, right: 160, bottom: 70, width: 40, height: 30,
      toJSON: () => ({}),
    }))
    document.body.appendChild(trigger)

    const wrapper = mount(ContextMenu, {
      attachTo: document.body,
      props: { items: [{ id: 'rename', label: '重命名' }, { id: 'delete', label: '删除', danger: true }] },
    })

    ;(wrapper.vm as unknown as { showAt: (el: HTMLElement) => void }).showAt(trigger)
    await nextTick()
    await nextTick()

    const menu = document.body.querySelector<HTMLElement>('.hc-ctx')
    expect(menu?.getAttribute('role')).toBe('menu')
    expect(menu?.style.top).toBe('76px')
    expect(document.activeElement?.textContent).toContain('重命名')

    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('.hc-ctx')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
