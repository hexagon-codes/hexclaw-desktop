/**
 * 全局滚动条「滚动中浮现」（ChatGPT 手感的「随内容一起」）。
 *
 * 纯 CSS `:hover` 只能覆盖「鼠标悬停容器」时浮现；快速滚轮 / 键盘 / 触控板惯性滚动时鼠标可能不在
 * 滚动条一侧，仍需要让滚动条短暂浮现以提供位置反馈。本工具在【捕获阶段】监听一次 scroll，
 * 给正在滚动的元素临时加 `hc-scrolling` 类，停止滚动 hideDelay 后移除——一处监听覆盖全应用
 * 所有滚动容器（scroll 事件不冒泡，故必须用捕获）。配合全局 CSS `.hc-scrolling::-webkit-scrollbar-thumb`
 * 让滚动条在「悬停」之外滚动时也浮现、停下即隐。
 */
export const SCROLLING_CLASS = 'hc-scrolling'

export function installScrollReveal(
  target: Pick<Document | HTMLElement, 'addEventListener' | 'removeEventListener'> = document,
  opts: { hideDelay?: number } = {},
): () => void {
  const hideDelay = opts.hideDelay ?? 900
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

  const onScroll = (e: Event) => {
    const el = e.target
    // window/document 级滚动的 target 不是 Element（或为 document）→ 忽略，仅处理具体滚动容器
    if (!(el instanceof Element)) return
    el.classList.add(SCROLLING_CLASS)
    const prev = timers.get(el)
    if (prev !== undefined) clearTimeout(prev)
    timers.set(
      el,
      setTimeout(() => {
        el.classList.remove(SCROLLING_CLASS)
        timers.delete(el)
      }, hideDelay),
    )
  }

  target.addEventListener('scroll', onScroll, true)
  return () => target.removeEventListener('scroll', onScroll, true)
}
