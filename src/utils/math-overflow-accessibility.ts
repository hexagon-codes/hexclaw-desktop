const OVERFLOW_TOLERANCE_PX = 1

/**
 * Keep ordinary inline formulas out of the tab order. When an equation is
 * wider than its own viewport, make that local scroll container focusable so
 * keyboard users can reach it without changing the formula's MathML tree.
 */
export function syncMathOverflowAccessibility(root: ParentNode): HTMLElement[] {
  const formulas = Array.from(
    root.querySelectorAll<HTMLElement>('.hc-math-inline'),
  )

  for (const formula of formulas) {
    const isScrollable = formula.clientWidth > 0
      && formula.scrollWidth > formula.clientWidth + OVERFLOW_TOLERANCE_PX

    formula.classList.toggle('hc-math-inline--scrollable', isScrollable)
    if (isScrollable) {
      formula.tabIndex = 0
    } else {
      formula.removeAttribute('tabindex')
    }
  }

  return formulas
}

/** Move an overflowing LTR equation without delegating arrow keys to the page. */
export function handleMathOverflowKeydown(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  const formula = target.closest<HTMLElement>(
    '.hc-math-inline.hc-math-inline--scrollable',
  )
  if (!formula) return false

  const maxScrollLeft = Math.max(0, formula.scrollWidth - formula.clientWidth)
  const step = Math.max(40, Math.round(formula.clientWidth * 0.25))
  let nextScrollLeft: number
  switch (event.key) {
    case 'ArrowLeft':
      nextScrollLeft = formula.scrollLeft - step
      break
    case 'ArrowRight':
      nextScrollLeft = formula.scrollLeft + step
      break
    case 'Home':
      nextScrollLeft = 0
      break
    case 'End':
      nextScrollLeft = maxScrollLeft
      break
    default:
      return false
  }

  event.preventDefault()
  formula.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft))
  return true
}
