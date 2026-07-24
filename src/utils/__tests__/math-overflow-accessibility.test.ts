import { describe, expect, it } from 'vitest'
import {
  handleMathOverflowKeydown,
  syncMathOverflowAccessibility,
} from '../math-overflow-accessibility'

const SCROLLABLE_CLASS = 'hc-math-viewport--scrollable'

function setGeometry(element: HTMLElement, clientWidth: number, scrollWidth: number) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  })
}

function formulaFixture() {
  const root = document.createElement('div')
  root.innerHTML = `
    <span class="hc-math-inline">
      <span class="hc-math-viewport hc-math-viewport--inline">
        <span class="katex"><span class="katex-html">formula</span></span>
      </span>
    </span>
  `
  return {
    root,
    shell: root.querySelector<HTMLElement>('.hc-math-inline')!,
    viewport: root.querySelector<HTMLElement>('.hc-math-viewport')!,
  }
}

describe('math overflow keyboard accessibility', () => {
  it('keeps a fitting viewport visible and out of the tab order', () => {
    const { root, shell, viewport } = formulaFixture()
    setGeometry(viewport, 140, 140)

    expect(syncMathOverflowAccessibility(root)).toEqual([viewport])
    expect(viewport.hasAttribute('tabindex')).toBe(false)
    expect(viewport.classList.contains(SCROLLABLE_CLASS)).toBe(false)
    expect(shell.className).toBe('hc-math-inline')
  })

  it('makes only genuinely wide inner viewports focusable without mutating formula shells', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <span class="hc-math-inline" id="short-shell">
        <span class="hc-math-viewport hc-math-viewport--inline" id="short">short</span>
      </span>
      <span class="hc-msg__math hc-msg__math--display" id="long-shell">
        <span class="hc-math-viewport hc-math-viewport--display" id="long">long</span>
      </span>
    `
    const shortViewport = root.querySelector<HTMLElement>('#short')!
    const longViewport = root.querySelector<HTMLElement>('#long')!
    setGeometry(shortViewport, 140, 140)
    setGeometry(longViewport, 140, 360)

    expect(syncMathOverflowAccessibility(root)).toEqual([shortViewport, longViewport])
    expect(shortViewport.hasAttribute('tabindex')).toBe(false)
    expect(shortViewport.classList.contains(SCROLLABLE_CLASS)).toBe(false)
    expect(longViewport.tabIndex).toBe(0)
    expect(longViewport.classList.contains(SCROLLABLE_CLASS)).toBe(true)
    expect(root.querySelector('#short-shell')!.getAttribute('class')).toBe('hc-math-inline')
    expect(root.querySelector('#long-shell')!.getAttribute('class')).toBe(
      'hc-msg__math hc-msg__math--display',
    )
  })

  it('ignores KaTeX descendants and legacy outer containers', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <span class="hc-math-inline"></span>
      <span class="katex-display"></span>
      <span class="hc-math-viewport"><span class="katex"></span></span>
    `
    const viewport = root.querySelector<HTMLElement>('.hc-math-viewport')!
    setGeometry(viewport, 100, 100)

    expect(syncMathOverflowAccessibility(root)).toEqual([viewport])
  })

  it('removes stale focusability and resets scroll when a resize eliminates overflow', () => {
    const { root, viewport } = formulaFixture()
    setGeometry(viewport, 100, 260)
    syncMathOverflowAccessibility(root)
    viewport.scrollLeft = 80
    expect(viewport.tabIndex).toBe(0)

    setGeometry(viewport, 300, 260)
    syncMathOverflowAccessibility(root)

    expect(viewport.hasAttribute('tabindex')).toBe(false)
    expect(viewport.classList.contains(SCROLLABLE_CLASS)).toBe(false)
    expect(viewport.scrollLeft).toBe(0)
  })

  it('preserves and clamps the horizontal position across overflow rechecks', () => {
    const { root, viewport } = formulaFixture()
    setGeometry(viewport, 100, 500)
    syncMathOverflowAccessibility(root)
    viewport.scrollLeft = 320

    setGeometry(viewport, 200, 420)
    syncMathOverflowAccessibility(root)

    expect(viewport.scrollLeft).toBe(220)
    expect(viewport.classList.contains(SCROLLABLE_CLASS)).toBe(true)
  })

  it('scrolls an overflowing LTR viewport with arrow, Home and End keys', () => {
    const viewport = document.createElement('span')
    viewport.className = `hc-math-viewport ${SCROLLABLE_CLASS}`
    viewport.tabIndex = 0
    setGeometry(viewport, 100, 500)

    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      Object.defineProperty(event, 'target', { configurable: true, value: viewport })
      expect(handleMathOverflowKeydown(event)).toBe(true)
      expect(event.defaultPrevented).toBe(true)
    }

    press('ArrowRight')
    expect(viewport.scrollLeft).toBe(40)
    press('End')
    expect(viewport.scrollLeft).toBe(400)
    press('ArrowLeft')
    expect(viewport.scrollLeft).toBe(360)
    press('Home')
    expect(viewport.scrollLeft).toBe(0)
  })

  it('does not consume keys outside a scrollable math viewport', () => {
    const target = document.createElement('span')
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'target', { configurable: true, value: target })

    expect(handleMathOverflowKeydown(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })
})
