import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import K12MistakeReviewMenu from '../components/K12MistakeReviewMenu.vue'

const source = readFileSync(
  resolve(process.cwd(), 'src/features/k12/components/K12MistakeReviewMenu.vue'),
  'utf8',
)

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('BUG-20260816-006 到期复习更多菜单视觉合同', () => {
  it('按权威原型把展开菜单钳制到视口内，并保持 170px fixed 浮层样式', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('mistake-more__menu') ? 170 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('mistake-more__menu') ? 49.5 : 0
    })
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)

    const wrapper = mount(K12MistakeReviewMenu, {
      attachTo: document.body,
      props: { suppressed: false },
    })
    const trigger = wrapper.get<HTMLButtonElement>('[aria-label="更多错题操作"]')
    vi.spyOn(trigger.element, 'getBoundingClientRect').mockReturnValue({
      x: 1406.625,
      y: 395.25,
      top: 395.25,
      right: 1436.625,
      bottom: 413.25,
      left: 1406.625,
      width: 30,
      height: 18,
      toJSON: () => ({}),
    })

    await trigger.trigger('click')
    await nextTick()

    const menu = wrapper.get<HTMLElement>('.mistake-more__menu')
    expect(menu.text()).toBe('不再复习')
    expect(menu.element.style.left).toBe('1258px')
    expect(menu.element.style.top).toBe('421.25px')
    expect(menu.element.style.maxHeight).toBe('300px')

    const menuRule = source.match(/\.mistake-more__menu\s*\{([\s\S]*?)\n\}/u)?.[1] ?? ''
    expect(menuRule).toMatch(/position:\s*fixed/u)
    expect(menuRule).toMatch(/width:\s*170px/u)
    expect(menuRule).toMatch(/padding:\s*6px/u)
    expect(menuRule).toMatch(/font-size:\s*14px/u)
    expect(menuRule).toMatch(/line-height:\s*1\.5/u)
    expect(menuRule).toMatch(/color:\s*var\(--hc-text-primary\)/u)

    const menuItemRule = source.match(/\.mistake-more__menu button\s*\{([\s\S]*?)\n\}/u)?.[1] ?? ''
    expect(menuItemRule).toMatch(/display:\s*flex/u)
    expect(menuItemRule).toMatch(/padding:\s*8px 10px/u)
    expect(menuItemRule).toMatch(/font:\s*inherit/u)
    expect(menuItemRule).toMatch(/font-size:\s*13px/u)

    wrapper.unmount()
  })
})
