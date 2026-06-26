import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installScrollReveal, SCROLLING_CLASS } from '../scroll-reveal'

describe('scroll-reveal（滚动中浮现）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="a" class="box"></div><div id="b" class="box"></div>'
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('滚动时给该元素加 hc-scrolling，停止 hideDelay 后移除', () => {
    const teardown = installScrollReveal(document, { hideDelay: 500 })
    const a = document.getElementById('a')!

    a.dispatchEvent(new Event('scroll', { bubbles: false }))
    expect(a.classList.contains(SCROLLING_CLASS)).toBe(true)

    vi.advanceTimersByTime(499)
    expect(a.classList.contains(SCROLLING_CLASS), '未到 hideDelay 不应移除').toBe(true)

    vi.advanceTimersByTime(1)
    expect(a.classList.contains(SCROLLING_CLASS), '到 hideDelay 应移除').toBe(false)

    teardown()
  })

  it('持续滚动会重置计时（debounce），不闪烁', () => {
    const teardown = installScrollReveal(document, { hideDelay: 500 })
    const a = document.getElementById('a')!

    a.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(400)
    a.dispatchEvent(new Event('scroll')) // 重置
    vi.advanceTimersByTime(400)
    expect(a.classList.contains(SCROLLING_CLASS), '持续滚动期间应保持浮现').toBe(true)
    vi.advanceTimersByTime(100)
    expect(a.classList.contains(SCROLLING_CLASS)).toBe(false)
    teardown()
  })

  it('多个容器各自独立计时，互不影响', () => {
    const teardown = installScrollReveal(document, { hideDelay: 500 })
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!

    a.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(300)
    b.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(200) // a 到 500 移除，b 才 200
    expect(a.classList.contains(SCROLLING_CLASS)).toBe(false)
    expect(b.classList.contains(SCROLLING_CLASS)).toBe(true)
    teardown()
  })

  it('teardown 后不再响应 scroll', () => {
    const teardown = installScrollReveal(document, { hideDelay: 500 })
    teardown()
    const a = document.getElementById('a')!
    a.dispatchEvent(new Event('scroll'))
    expect(a.classList.contains(SCROLLING_CLASS)).toBe(false)
  })
})
