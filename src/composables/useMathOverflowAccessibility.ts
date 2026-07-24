import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  type Ref,
} from 'vue'
import {
  handleMathOverflowKeydown,
  syncMathOverflowAccessibility,
} from '@/utils/math-overflow-accessibility'

/**
 * Re-evaluate formula overflow after Vue updates and container resizes.
 * Both production render boundaries use this one lifecycle adapter.
 */
export function useMathOverflowAccessibility(root: Ref<HTMLElement | null>) {
  let resizeObserver: ResizeObserver | undefined
  let animationFrame: number | undefined
  let disposed = false

  const syncAndObserve = () => {
    animationFrame = undefined
    const element = root.value
    if (!element) return
    syncMathOverflowAccessibility(element)
    resizeObserver?.observe(element)
  }

  const scheduleSync = () => {
    void nextTick(() => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(syncAndObserve)
    })
  }

  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleSync)
    }
    root.value?.addEventListener('keydown', handleMathOverflowKeydown)
    scheduleSync()
    void document.fonts?.ready.then(() => {
      if (!disposed) scheduleSync()
    })
  })

  onUpdated(scheduleSync)

  onBeforeUnmount(() => {
    disposed = true
    root.value?.removeEventListener('keydown', handleMathOverflowKeydown)
    resizeObserver?.disconnect()
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
  })

  return { refreshMathOverflowAccessibility: scheduleSync }
}
