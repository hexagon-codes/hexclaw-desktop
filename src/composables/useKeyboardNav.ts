import { onMounted, onUnmounted } from 'vue'

/**
 * 增强键盘导航
 * - Escape: 关闭模态框/弹窗
 * - Tab: 默认焦点管理
 */
export function useKeyboardNav(options?: {
  onEscape?: () => void
}) {
  function handleKeydown(e: KeyboardEvent) {
    // Escape 关闭当前弹窗/模态
    if (e.key === 'Escape' && options?.onEscape) {
      e.preventDefault()
      options.onEscape()
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown)
  })
}

/**
 * 焦点陷阱 — 用于模态框
 * 保证 Tab 焦点在容器内循环
 */
export function trapFocus(container: HTMLElement) {
  const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  const focusableElements = container.querySelectorAll<HTMLElement>(focusableSelector)

  if (focusableElements.length === 0) {
    return () => {} // 无可聚焦元素，返回空清理函数
  }

  const first = focusableElements[0]
  const last = focusableElements[focusableElements.length - 1]

  function handler(e: KeyboardEvent) {
    if (e.key !== 'Tab') return

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
  }

  container.addEventListener('keydown', handler)
  first?.focus()

  return () => container.removeEventListener('keydown', handler)
}
