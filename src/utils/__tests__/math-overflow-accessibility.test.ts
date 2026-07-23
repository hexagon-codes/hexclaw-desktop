import { describe, expect, it } from 'vitest'
import {
  handleMathOverflowKeydown,
  syncMathOverflowAccessibility,
} from '../math-overflow-accessibility'

function setGeometry(element: HTMLElement, clientWidth: number, scrollWidth: number) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  })
}

describe('math overflow keyboard accessibility', () => {
  it('keeps short formulas out of the tab order', () => {
    const root = document.createElement('div')
    root.innerHTML = '<span class="hc-math-inline">short</span>'
    const formula = root.querySelector<HTMLElement>('.hc-math-inline')!
    setGeometry(formula, 140, 140)

    syncMathOverflowAccessibility(root)

    expect(formula.hasAttribute('tabindex')).toBe(false)
    expect(formula.classList.contains('hc-math-inline--scrollable')).toBe(false)
  })

  it('makes only genuinely overflowing formulas keyboard-focusable', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<span class="hc-math-inline" id="short">short</span>',
      '<span class="hc-math-inline" id="long">long</span>',
    ].join('')
    const shortFormula = root.querySelector<HTMLElement>('#short')!
    const longFormula = root.querySelector<HTMLElement>('#long')!
    setGeometry(shortFormula, 140, 140)
    setGeometry(longFormula, 140, 360)

    syncMathOverflowAccessibility(root)

    expect(shortFormula.hasAttribute('tabindex')).toBe(false)
    expect(longFormula.tabIndex).toBe(0)
    expect(longFormula.classList.contains('hc-math-inline--scrollable')).toBe(true)
  })

  it('removes stale focusability when a resize eliminates overflow', () => {
    const root = document.createElement('div')
    root.innerHTML = '<span class="hc-math-inline">formula</span>'
    const formula = root.querySelector<HTMLElement>('.hc-math-inline')!
    setGeometry(formula, 100, 260)
    syncMathOverflowAccessibility(root)
    expect(formula.tabIndex).toBe(0)

    setGeometry(formula, 300, 260)
    syncMathOverflowAccessibility(root)

    expect(formula.hasAttribute('tabindex')).toBe(false)
    expect(formula.classList.contains('hc-math-inline--scrollable')).toBe(false)
  })

  it('scrolls an overflowing LTR formula with arrow, Home and End keys', () => {
    const formula = document.createElement('span')
    formula.className = 'hc-math-inline hc-math-inline--scrollable'
    formula.tabIndex = 0
    setGeometry(formula, 100, 500)

    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      Object.defineProperty(event, 'target', { configurable: true, value: formula })
      expect(handleMathOverflowKeydown(event)).toBe(true)
      expect(event.defaultPrevented).toBe(true)
    }

    press('ArrowRight')
    expect(formula.scrollLeft).toBe(40)
    press('End')
    expect(formula.scrollLeft).toBe(400)
    press('ArrowLeft')
    expect(formula.scrollLeft).toBe(360)
    press('Home')
    expect(formula.scrollLeft).toBe(0)
  })
})
