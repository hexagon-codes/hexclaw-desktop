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

  const syncAndObserve = () => {
    animationFrame = undefined
    const element = root.value
    if (!element) return
    const formulas = syncMathOverflowAccessibility(element)
    resizeObserver?.observe(element)
    formulas.forEach((formula) => resizeObserver?.observe(formula))
  }

  const scheduleSync = () => {
    void nextTick(() => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(syncAndObserve)
    })
  }

  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        const element = root.value
        if (element) syncMathOverflowAccessibility(element)
      })
    }
    root.value?.addEventListener('keydown', handleMathOverflowKeydown)
    scheduleSync()
  })

  onUpdated(scheduleSync)

  onBeforeUnmount(() => {
    root.value?.removeEventListener('keydown', handleMathOverflowKeydown)
    resizeObserver?.disconnect()
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
  })

  return { refreshMathOverflowAccessibility: scheduleSync }
}
