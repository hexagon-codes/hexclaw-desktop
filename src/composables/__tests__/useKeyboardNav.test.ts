import { describe, it, expect, vi } from 'vitest'
import { trapFocus } from '../useKeyboardNav'

describe('trapFocus', () => {
  function createContainer(elements: string[]): HTMLElement {
    const container = document.createElement('div')
    elements.forEach((tag) => {
      const el = document.createElement(tag)
      container.appendChild(el)
    })
    return container
  }

  it('focuses first focusable element', () => {
    const container = createContainer(['button', 'input', 'button'])
    const firstBtn = container.querySelector('button') as HTMLButtonElement
    const focusSpy = vi.spyOn(firstBtn, 'focus')

    trapFocus(container)
    expect(focusSpy).toHaveBeenCalled()
  })

  it('returns cleanup function', () => {
    const container = createContainer(['button', 'input'])
    const cleanup = trapFocus(container)
    expect(typeof cleanup).toBe('function')
    cleanup()
  })

  it('wraps focus forward from last to first', () => {
    const container = createContainer(['button', 'input', 'button'])
    const buttons = container.querySelectorAll('button')
    const firstBtn = buttons[0] as HTMLButtonElement
    const lastBtn = buttons[1] as HTMLButtonElement

    trapFocus(container)

    // 模拟焦点在最后一个元素
    Object.defineProperty(document, 'activeElement', { value: lastBtn, configurable: true })
    const focusSpy = vi.spyOn(firstBtn, 'focus')

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
    Object.defineProperty(tabEvent, 'preventDefault', { value: vi.fn() })
    container.dispatchEvent(tabEvent)

    expect(focusSpy).toHaveBeenCalled()
  })

  it('wraps focus backward from first to last', () => {
    const container = createContainer(['button', 'input', 'button'])
    const buttons = container.querySelectorAll('button')
    const firstBtn = buttons[0] as HTMLButtonElement
    const lastBtn = buttons[1] as HTMLButtonElement

    trapFocus(container)

    // 模拟焦点在第一个元素
    Object.defineProperty(document, 'activeElement', { value: firstBtn, configurable: true })
    const focusSpy = vi.spyOn(lastBtn, 'focus')

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
    Object.defineProperty(tabEvent, 'preventDefault', { value: vi.fn() })
    container.dispatchEvent(tabEvent)

    expect(focusSpy).toHaveBeenCalled()
  })

  it('ignores non-tab keys', () => {
    const container = createContainer(['button', 'input'])
    trapFocus(container)

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    // Should not throw
    container.dispatchEvent(enterEvent)
  })
})
