<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'

const props = withDefaults(defineProps<{
  open: boolean
  bodyId?: string
  gap?: number
}>(), { gap: 0 })

type Frame = { height: number; opacity: number; marginTop: number }
type Motion = { element: HTMLElement; animation: Animation; done: () => void }
let active: Motion | undefined
let carried: Frame | undefined

function readFrame(element: HTMLElement): Frame {
  const style = getComputedStyle(element)
  return {
    height: element.getBoundingClientRect().height,
    opacity: Number.parseFloat(style.opacity) || 0,
    marginTop: Number.parseFloat(style.marginTop) || 0,
  }
}

function applyFrame(element: HTMLElement, frame: Frame) {
  element.style.height = `${frame.height}px`
  element.style.opacity = String(frame.opacity)
  element.style.marginTop = `${frame.marginTop}px`
  element.style.overflow = 'hidden'
}

function clearFrame(element: HTMLElement) {
  for (const property of ['height', 'opacity', 'margin-top', 'overflow']) {
    element.style.removeProperty(property)
  }
}

// 反向时先冻结当前画面，再结束旧 Transition；新节点从该帧续行。
function interrupt(element?: Element) {
  if (!active || (element && active.element !== element)) return
  const previous = active
  carried = readFrame(previous.element)
  active = undefined
  previous.animation.onfinish = null
  previous.animation.cancel()
  previous.done()
}

watch(() => props.open, () => interrupt(), { flush: 'sync' })

function beforeEnter(element: Element) {
  const panel = element as HTMLElement
  panel.inert = false
  panel.removeAttribute('aria-hidden')
  applyFrame(panel, carried ?? { height: 0, opacity: 0, marginTop: -props.gap })
}

function beforeLeave(element: Element) {
  const panel = element as HTMLElement
  // 离场节点仍会短暂留在 DOM，立即退出键盘与辅助技术交互。
  panel.inert = true
  panel.setAttribute('aria-hidden', 'true')
}

function run(element: Element, done: () => void, entering: boolean) {
  const panel = element as HTMLElement
  const from = carried ?? readFrame(panel)
  carried = undefined
  clearFrame(panel)
  const to: Frame = {
    height: entering ? panel.scrollHeight : 0,
    opacity: entering ? 1 : 0,
    marginTop: entering ? 0 : -props.gap,
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    done()
    return
  }
  applyFrame(panel, from)
  const easing = getComputedStyle(panel).getPropertyValue('--hc-ease-out').trim() || 'ease-out'
  const keyframe = (frame: Frame) => ({
    height: `${frame.height}px`, opacity: frame.opacity, marginTop: `${frame.marginTop}px`,
  })
  const animation = panel.animate([keyframe(from), keyframe(to)], {
    duration: entering ? 220 : 180, easing, fill: 'both',
  })
  const motion = { element: panel, animation, done }
  active = motion
  // 取消时的 finished 拒绝只属于视觉中断，不传播为页面错误。
  void animation.finished.catch(() => {})
  animation.onfinish = () => {
    if (active !== motion) return
    active = undefined
    animation.onfinish = null
    animation.cancel()
    clearFrame(panel)
    done()
  }
}

onBeforeUnmount(() => {
  if (active) {
    active.animation.onfinish = null
    active.animation.cancel()
    clearFrame(active.element)
  }
  active = undefined
  carried = undefined
})
</script>

<template>
  <Transition
    :css="false"
    @before-enter="beforeEnter"
    @enter="(element, done) => run(element, done, true)"
    @before-leave="beforeLeave"
    @leave="(element, done) => run(element, done, false)"
    @enter-cancelled="interrupt"
    @leave-cancelled="interrupt"
  >
    <div v-if="open" :id="bodyId" class="hc-collapse-panel">
      <slot />
    </div>
  </Transition>
</template>

<style scoped>
/* flow-root 将正文外边距纳入自然高度，动效结束后仍维持原静态几何。 */
.hc-collapse-panel {
  display: flow-root;
  min-width: 0;
}
</style>
