/** 输入来源由应用入口统一维护，避免把程序化焦点恢复误判为键盘导航。 */
export function installFocusOrigin() {
  const root = document.documentElement
  root.dataset.hcFocusOrigin = 'pointer'
  // 失焦窗口的提示应隐藏，但实际焦点仍用于返回应用后的键盘导航。
  const setWindowActive = (active: boolean) => {
    root.dataset.hcWindowActive = String(active)
  }
  const windowBlur = () => setWindowActive(false)
  const windowFocus = () => setWindowActive(document.visibilityState !== 'hidden')
  const visibility = () =>
    setWindowActive(document.hasFocus() && document.visibilityState !== 'hidden')
  visibility()
  const pointer = () => {
    root.dataset.hcFocusOrigin = 'pointer'
  }
  const keyboard = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      (event.altKey && event.key !== 'Tab')
    )
      return
    const editing =
      event.target instanceof Element &&
      !!event.target.closest('input,textarea,[contenteditable="true"]')
    if (
      event.key === 'Tab' ||
      event.key === 'Escape' ||
      (!editing &&
        ['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
          event.key,
        ))
    ) {
      root.dataset.hcFocusOrigin = 'keyboard'
    }
  }
  document.addEventListener('pointerdown', pointer, true)
  document.addEventListener('keydown', keyboard, true)
  window.addEventListener('blur', windowBlur)
  window.addEventListener('focus', windowFocus)
  document.addEventListener('visibilitychange', visibility)
  return () => {
    document.removeEventListener('pointerdown', pointer, true)
    document.removeEventListener('keydown', keyboard, true)
    window.removeEventListener('blur', windowBlur)
    window.removeEventListener('focus', windowFocus)
    document.removeEventListener('visibilitychange', visibility)
    delete root.dataset.hcFocusOrigin
    delete root.dataset.hcWindowActive
  }
}
