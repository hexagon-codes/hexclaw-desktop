const OVERFLOW_TOLERANCE_PX = 1
const SCROLLABLE_CLASS = 'hc-math-viewport--scrollable'
const MATH_VIEWPORT_SELECTOR = '.hc-math-viewport'

/**
 * The semantic formula shell always keeps visible overflow. Only its dedicated
 * inner viewport may become a horizontal scroll container, so WebKit never
 * clips KaTeX's vertically positioned fraction ink at the formula boundary.
 * Width is the only runtime measurement; formula descendants are deliberately
 * opaque to this adapter.
 */
export function syncMathOverflowAccessibility(root: ParentNode): HTMLElement[] {
  const viewports = Array.from(
    root.querySelectorAll<HTMLElement>(MATH_VIEWPORT_SELECTOR),
  )

  for (const viewport of viewports) {
    const previousScrollLeft = viewport.scrollLeft
    viewport.classList.remove(SCROLLABLE_CLASS)
    viewport.removeAttribute('tabindex')

    const isScrollable =
      viewport.clientWidth > 0 &&
      viewport.scrollWidth > viewport.clientWidth + OVERFLOW_TOLERANCE_PX
    if (!isScrollable) {
      viewport.scrollLeft = 0
      continue
    }

    viewport.classList.add(SCROLLABLE_CLASS)
    viewport.tabIndex = 0
    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    viewport.scrollLeft = Math.max(0, Math.min(previousScrollLeft, maxScrollLeft))
  }

  return viewports
}

/** Move an overflowing LTR equation without delegating arrow keys to the page. */
export function handleMathOverflowKeydown(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  const viewport = target.closest<HTMLElement>(`.${SCROLLABLE_CLASS}`)
  if (!viewport) return false

  const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
  const step = Math.max(40, Math.round(viewport.clientWidth * 0.25))
  let nextScrollLeft: number
  switch (event.key) {
    case 'ArrowLeft':
      nextScrollLeft = viewport.scrollLeft - step
      break
    case 'ArrowRight':
      nextScrollLeft = viewport.scrollLeft + step
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
  viewport.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft))
  return true
}
