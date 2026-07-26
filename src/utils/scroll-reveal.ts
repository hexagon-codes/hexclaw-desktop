export const SCROLLING_CLASS = 'hc-scrolling'
export const FIXED_THUMB_PX = 168

const TRACK_PX = 10

interface DragState {
  axis: 'x' | 'y'
  pointerId: number
  pointerStart: number
  scrollStart: number
  scrollRange: number
  travel: number
  thumb: HTMLElement
}

interface ControllerState {
  references: number
  dispose(): void
}

type ScrollEventTarget = Pick<
  Document | HTMLElement,
  'addEventListener' | 'removeEventListener'
>

const controllers = new WeakMap<Document, ControllerState>()

function installLegacyScrollClass(
  target: ScrollEventTarget,
  hideDelay: number,
): () => void {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  const onScroll = (event: Event) => {
    const element = event.target
    if (!(element instanceof Element)) return
    element.classList.add(SCROLLING_CLASS)
    const previous = timers.get(element)
    if (previous !== undefined) clearTimeout(previous)
    timers.set(
      element,
      setTimeout(() => {
        element.classList.remove(SCROLLING_CLASS)
        timers.delete(element)
      }, hideDelay),
    )
  }
  target.addEventListener('scroll', onScroll, true)
  return () => target.removeEventListener('scroll', onScroll, true)
}

export function installScrollReveal(
  target: ScrollEventTarget = document,
  opts: { hideDelay?: number } = {},
): () => void {
  const hideDelay = opts.hideDelay ?? 900
  let ownerDocument: Document
  if (typeof Document !== 'undefined' && target instanceof Document) {
    ownerDocument = target
  } else if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) {
    ownerDocument = target.ownerDocument
  } else {
    return installLegacyScrollClass(target, hideDelay)
  }
  const existing = controllers.get(ownerDocument)
  if (existing) {
    existing.references += 1
    return () => {
      existing.references -= 1
      if (existing.references === 0) {
        existing.dispose()
        controllers.delete(ownerDocument)
      }
    }
  }

  const layer = ownerDocument.createElement('div')
  layer.className = 'hc-global-scrollbar-layer'
  layer.setAttribute('aria-hidden', 'true')
  layer.innerHTML =
    '<div class="hc-global-scrollbar hc-global-scrollbar--vertical" data-scrollbar-axis="y"><div class="hc-global-scrollbar__thumb"></div></div>' +
    '<div class="hc-global-scrollbar hc-global-scrollbar--horizontal" data-scrollbar-axis="x"><div class="hc-global-scrollbar__thumb"></div></div>'
  ;(ownerDocument.body ?? ownerDocument.documentElement).appendChild(layer)

  const bars = {
    y: layer.querySelector<HTMLElement>('[data-scrollbar-axis="y"]')!,
    x: layer.querySelector<HTMLElement>('[data-scrollbar-axis="x"]')!,
  }
  const scrollingTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  const scrollingElements = new Set<Element>()
  let active: HTMLElement | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let drag: DragState | null = null
  const view = ownerDocument.defaultView
  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => paint())

  function asScrollable(element: unknown): HTMLElement | null {
    if (!(element instanceof HTMLElement)) return null
    const style = view?.getComputedStyle(element)
    if (!style) return null
    return (
      (/^(auto|scroll|overlay)$/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 1) ||
      (/^(auto|scroll|overlay)$/.test(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1)
    ) ? element : null
  }

  function findScrollable(node: EventTarget | null): HTMLElement | null {
    let element = node instanceof HTMLElement ? node : null
    while (element) {
      const scrollable = asScrollable(element)
      if (scrollable) return scrollable
      element = element.parentElement
    }
    const root = ownerDocument.scrollingElement
    return asScrollable(root)
  }

  function setBar(
    axis: 'x' | 'y',
    visible: boolean,
    start: number,
    cross: number,
    trackLength: number,
    scrollOffset: number,
    scrollRange: number,
  ) {
    const bar = bars[axis]
    const thumb = bar.firstElementChild as HTMLElement
    if (!visible || trackLength <= 0 || scrollRange <= 0) {
      bar.dataset.active = 'false'
      return
    }
    const thumbLength = Math.min(FIXED_THUMB_PX, trackLength)
    const travel = Math.max(0, trackLength - thumbLength)
    const progress = Math.max(0, Math.min(1, scrollOffset / scrollRange))
    bar.dataset.active = 'true'
    if (axis === 'y') {
      Object.assign(bar.style, {
        top: `${start}px`,
        left: `${cross - TRACK_PX}px`,
        height: `${trackLength}px`,
      })
      thumb.style.height = `${thumbLength}px`
      thumb.style.transform = `translateY(${travel * progress}px)`
    } else {
      Object.assign(bar.style, {
        left: `${start}px`,
        top: `${cross - TRACK_PX}px`,
        width: `${trackLength}px`,
      })
      thumb.style.width = `${thumbLength}px`
      thumb.style.transform = `translateX(${travel * progress}px)`
    }
  }

  function hide() {
    if (drag) return
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    layer.classList.remove('is-visible')
    bars.x.dataset.active = 'false'
    bars.y.dataset.active = 'false'
  }

  function paint() {
    if (!active?.isConnected) {
      hide()
      return
    }
    const rect = active.getBoundingClientRect()
    const viewportWidth = view?.innerWidth ?? rect.right
    const viewportHeight = view?.innerHeight ?? rect.bottom
    const top = Math.max(0, rect.top)
    const bottom = Math.min(viewportHeight, rect.bottom)
    const left = Math.max(0, rect.left)
    const right = Math.min(viewportWidth, rect.right)
    setBar(
      'y',
      active.scrollHeight > active.clientHeight + 1,
      top,
      right,
      Math.max(0, bottom - top),
      active.scrollTop,
      active.scrollHeight - active.clientHeight,
    )
    setBar(
      'x',
      active.scrollWidth > active.clientWidth + 1,
      left,
      bottom,
      Math.max(0, right - left),
      active.scrollLeft,
      active.scrollWidth - active.clientWidth,
    )
  }

  function show(element: HTMLElement) {
    if (active !== element) {
      resizeObserver?.disconnect()
      active = element
      resizeObserver?.observe(element)
    }
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    layer.classList.add('is-visible')
    paint()
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (!drag && !active?.matches(':hover')) hide()
    }, hideDelay)
  }

  function markScrolling(element: Element) {
    element.classList.add(SCROLLING_CLASS)
    scrollingElements.add(element)
    const previous = scrollingTimers.get(element)
    if (previous !== undefined) clearTimeout(previous)
    scrollingTimers.set(
      element,
      setTimeout(() => {
        element.classList.remove(SCROLLING_CLASS)
        scrollingElements.delete(element)
        scrollingTimers.delete(element)
      }, hideDelay),
    )
  }

  const onScroll = (event: Event) => {
    if (event.target instanceof Element) markScrolling(event.target)
    const element = asScrollable(event.target) ?? findScrollable(event.target)
    if (!element) return
    show(element)
    scheduleHide()
  }
  const onPointerOver = (event: PointerEvent) => {
    const element = findScrollable(event.target)
    if (element) show(element)
  }
  const onPointerOut = (event: PointerEvent) => {
    if (active && event.relatedTarget instanceof Node && active.contains(event.relatedTarget)) return
    scheduleHide()
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId || !active) return
    const pointer = drag.axis === 'y' ? event.clientY : event.clientX
    const next =
      drag.scrollStart +
      ((pointer - drag.pointerStart) * drag.scrollRange) / drag.travel
    if (drag.axis === 'y') active.scrollTop = next
    else active.scrollLeft = next
    paint()
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.thumb.classList.remove('is-active')
    drag = null
    scheduleHide()
  }

  ownerDocument.addEventListener('scroll', onScroll, true)
  ownerDocument.addEventListener('pointerover', onPointerOver, true)
  ownerDocument.addEventListener('pointerout', onPointerOut, true)
  view?.addEventListener('pointermove', onPointerMove)
  view?.addEventListener('pointerup', onPointerUp)
  view?.addEventListener('resize', paint)
  view?.addEventListener('blur', hide)

  for (const axis of ['x', 'y'] as const) {
    const bar = bars[axis]
    const thumb = bar.firstElementChild as HTMLElement
    thumb.addEventListener('pointerdown', (event) => {
      if (!active) return
      event.preventDefault()
      thumb.setPointerCapture(event.pointerId)
      thumb.classList.add('is-active')
      const trackLength = axis === 'y' ? bar.clientHeight : bar.clientWidth
      const thumbLength = axis === 'y' ? thumb.offsetHeight : thumb.offsetWidth
      drag = {
        axis,
        pointerId: event.pointerId,
        pointerStart: axis === 'y' ? event.clientY : event.clientX,
        scrollStart: axis === 'y' ? active.scrollTop : active.scrollLeft,
        scrollRange:
          axis === 'y'
            ? active.scrollHeight - active.clientHeight
            : active.scrollWidth - active.clientWidth,
        travel: Math.max(1, trackLength - thumbLength),
        thumb,
      }
    })
  }

  const state: ControllerState = {
    references: 1,
    dispose() {
      if (hideTimer) clearTimeout(hideTimer)
      resizeObserver?.disconnect()
      ownerDocument.removeEventListener('scroll', onScroll, true)
      ownerDocument.removeEventListener('pointerover', onPointerOver, true)
      ownerDocument.removeEventListener('pointerout', onPointerOut, true)
      view?.removeEventListener('pointermove', onPointerMove)
      view?.removeEventListener('pointerup', onPointerUp)
      view?.removeEventListener('resize', paint)
      view?.removeEventListener('blur', hide)
      for (const element of scrollingElements) {
        const timer = scrollingTimers.get(element)
        if (timer !== undefined) clearTimeout(timer)
        element.classList.remove(SCROLLING_CLASS)
      }
      scrollingElements.clear()
      layer.remove()
    },
  }
  controllers.set(ownerDocument, state)
  return () => {
    state.references -= 1
    if (state.references === 0) {
      state.dispose()
      controllers.delete(ownerDocument)
    }
  }
}
