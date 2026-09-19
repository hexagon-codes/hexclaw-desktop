<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PreviewImage } from '@/composables/useImagePreview'

const props = defineProps<{
  images: PreviewImage[]
  initialKey: string
  returnFocus?: HTMLElement
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const dialog = ref<HTMLDialogElement>()
const stage = ref<HTMLDivElement>()
const index = ref(
  Math.max(
    0,
    props.images.findIndex((image) => image.key === props.initialKey),
  ),
)
const current = computed(() => props.images[index.value])
const scale = ref(1),
  fit = ref(1),
  panX = ref(0),
  panY = ref(0)
const dragging = ref(false),
  failed = ref(false)
let drag: { id: number; x: number; y: number } | undefined
let suppressBackdropClick = false
let gestureScale = 1
let observer: ResizeObserver | undefined
const paths = {
  close: 'M6 6l12 12M6 18L18 6',
  previous: 'm11 18-6-6 6-6M5 12h14',
  next: 'm13 6 6 6-6 6M5 12h14',
  out: 'M5 12h14',
  in: 'M5 12h14M12 5v14',
  fit: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
}
const imageStyle = computed(() => ({
  width: `${current.value?.width ?? 0}px`,
  height: `${current.value?.height ?? 0}px`,
  transform: `translate(calc(-50% + ${panX.value}px), calc(-50% + ${panY.value}px)) scale(${scale.value})`,
  cursor: scale.value > fit.value + 0.001 ? (dragging.value ? 'grabbing' : 'grab') : 'zoom-in',
}))

function constrain() {
  if (!stage.value || !current.value) return
  const maxX = Math.max(0, (current.value.width * scale.value - stage.value.clientWidth) / 2)
  const maxY = Math.max(0, (current.value.height * scale.value - stage.value.clientHeight) / 2)
  panX.value = Math.max(-maxX, Math.min(maxX, panX.value))
  panY.value = Math.max(-maxY, Math.min(maxY, panY.value))
}
function reset() {
  if (!stage.value || !current.value) return
  fit.value = Math.min(
    1,
    stage.value.clientWidth / current.value.width,
    stage.value.clientHeight / current.value.height,
  )
  scale.value = fit.value
  panX.value = panY.value = 0
  drag = undefined
  dragging.value = false
  suppressBackdropClick = false
}
function zoom(next: number, clientX?: number, clientY?: number) {
  if (!stage.value || failed.value) return
  const bounds = stage.value.getBoundingClientRect()
  const x = (clientX ?? bounds.left + bounds.width / 2) - bounds.left - bounds.width / 2
  const y = (clientY ?? bounds.top + bounds.height / 2) - bounds.top - bounds.height / 2
  const previous = scale.value
  scale.value = Math.max(fit.value, Math.min(8, next))
  panX.value = ((panX.value - x) * scale.value) / previous + x
  panY.value = ((panY.value - y) * scale.value) / previous + y
  constrain()
}
function wheel(event: WheelEvent) {
  const delta =
    event.deltaY *
    (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (stage.value?.clientHeight ?? 1) : 1)
  zoom(scale.value * Math.exp(-delta * 0.002), event.clientX, event.clientY)
}
function select(next: number) {
  if (next < 0 || next >= props.images.length || next === index.value) return
  index.value = next
  failed.value = false
  reset()
}
function pointerDown(event: PointerEvent) {
  if (
    event.button !== 0 ||
    scale.value <= fit.value + 0.001 ||
    !(event.target as HTMLElement).closest('.hc-image-viewer__image')
  )
    return
  event.preventDefault()
  drag = { id: event.pointerId, x: event.clientX - panX.value, y: event.clientY - panY.value }
  dragging.value = true
  suppressBackdropClick = true
  stage.value?.setPointerCapture(event.pointerId)
}
function pointerMove(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  panX.value = event.clientX - drag.x
  panY.value = event.clientY - drag.y
  constrain()
}
function pointerEnd(event: PointerEvent) {
  if (drag?.id !== event.pointerId) return
  if (stage.value?.hasPointerCapture(event.pointerId))
    stage.value.releasePointerCapture(event.pointerId)
  drag = undefined
  dragging.value = false
  if (event.type === 'pointercancel') suppressBackdropClick = false
}
function backdrop(event: MouseEvent) {
  if (suppressBackdropClick) {
    suppressBackdropClick = false
    return
  }
  if (event.target === dialog.value || event.target === stage.value) emit('close')
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    event.preventDefault()
    const buttons = Array.from(
      dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    )
    const active = buttons.findIndex((button) => button === document.activeElement)
    const next =
      active < 0
        ? event.shiftKey
          ? buttons.length - 1
          : 0
        : (active + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus()
    return
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (['ArrowLeft', 'ArrowRight', '+', '=', '-', '0'].includes(event.key)) event.preventDefault()
  if (event.key === 'ArrowLeft') select(index.value - 1)
  if (event.key === 'ArrowRight') select(index.value + 1)
  if (event.key === '+' || event.key === '=') zoom(scale.value * 1.25)
  if (event.key === '-') zoom(scale.value / 1.25)
  if (event.key === '0') reset()
}
// WebKit 将触控板捏合投影为 gesture 事件，Chromium 使用带 ctrlKey 的 wheel。
function gestureStart(event: Event) {
  event.preventDefault()
  gestureScale = scale.value
}
function gestureChange(event: Event) {
  event.preventDefault()
  const gesture = event as Event & { scale: number; clientX?: number; clientY?: number }
  if (Number.isFinite(gesture.scale))
    zoom(gestureScale * gesture.scale, gesture.clientX, gesture.clientY)
}
watch(
  () => props.images,
  () => {
    if (!current.value) emit('close')
  },
)
onMounted(async () => {
  dialog.value?.showModal()
  await nextTick()
  reset()
  if (stage.value) {
    observer = new ResizeObserver(reset)
    observer.observe(stage.value)
    stage.value.addEventListener('gesturestart', gestureStart, { passive: false })
    stage.value.addEventListener('gesturechange', gestureChange, { passive: false })
  }
})
onBeforeUnmount(() => {
  observer?.disconnect()
  stage.value?.removeEventListener('gesturestart', gestureStart)
  stage.value?.removeEventListener('gesturechange', gestureChange)
  dialog.value?.close()
  if (props.returnFocus?.isConnected) props.returnFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="hc-image-viewer"
      :aria-label="t('chat.previewTitle')"
      :data-scale="scale"
      :data-pan-x="panX"
      :data-pan-y="panY"
      @cancel.prevent="emit('close')"
      @click="backdrop"
      @keydown.stop="keyboard"
    >
      <header class="hc-image-viewer__header">
        <span class="hc-image-viewer__title">{{ current?.label }}</span>
        <span class="hc-image-viewer__count" aria-live="polite">{{
          images.length > 1 ? `${index + 1} / ${images.length}` : ''
        }}</span>
      </header>
      <button
        class="hc-image-viewer__button hc-image-viewer__close"
        :aria-label="t('chat.previewClose')"
        :title="t('chat.previewClose')"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="paths.close" /></svg>
      </button>
      <button
        v-if="images.length > 1"
        class="hc-image-viewer__button hc-image-viewer__previous"
        :disabled="index === 0"
        :aria-label="t('chat.previewPrevious')"
        :title="t('chat.previewPrevious')"
        @click="select(index - 1)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="paths.previous" /></svg>
      </button>
      <div
        ref="stage"
        class="hc-image-viewer__stage"
        @dblclick="zoom(Math.abs(scale - fit) < 0.001 ? Math.max(1, fit * 2) : fit)"
        @wheel.prevent="wheel"
        @pointerdown="pointerDown"
        @pointermove="pointerMove"
        @pointerup="pointerEnd"
        @pointercancel="pointerEnd"
      >
        <div v-if="current && !failed" class="hc-image-viewer__image" :style="imageStyle">
          <img
            :key="current.key"
            :src="current.src"
            :alt="current.label"
            draggable="false"
            @error="failed = true"
          />
          <span
            v-for="(mark, i) in current.marks"
            :key="i"
            class="hc-image-viewer__mark"
            :style="{
              left: mark.left,
              top: mark.top,
              transform: mark.transform,
              width: `${mark.width}px`,
              height: `${mark.height}px`,
            }"
          >
            <span :style="mark.style">{{ mark.text }}</span>
          </span>
        </div>
        <div v-if="failed" class="hc-image-viewer__error" role="status">Image unavailable</div>
      </div>
      <button
        v-if="images.length > 1"
        class="hc-image-viewer__button hc-image-viewer__next"
        :disabled="index === images.length - 1"
        :aria-label="t('chat.previewNext')"
        :title="t('chat.previewNext')"
        @click="select(index + 1)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="paths.next" /></svg>
      </button>
      <div class="hc-image-viewer__tools" role="group" :aria-label="t('chat.previewZoom')">
        <button
          class="hc-image-viewer__button"
          data-action="out"
          :disabled="failed || scale <= fit + 0.001"
          :aria-label="t('chat.previewZoomOut')"
          :title="t('chat.previewZoomOut')"
          @click="zoom(scale / 1.25)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="paths.out" /></svg>
        </button>
        <span class="hc-image-viewer__scale">{{ Math.round(scale * 100) }}%</span>
        <button
          class="hc-image-viewer__button"
          data-action="in"
          :disabled="failed || scale >= 8"
          :aria-label="t('chat.previewZoomIn')"
          :title="t('chat.previewZoomIn')"
          @click="zoom(scale * 1.25)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="paths.in" /></svg>
        </button>
        <span class="hc-image-viewer__divider"></span>
        <button
          class="hc-image-viewer__button"
          data-action="fit"
          :disabled="failed"
          :aria-label="t('chat.previewFit')"
          :title="t('chat.previewFit')"
          @click="reset"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="paths.fit" /></svg>
        </button>
      </div>
    </dialog>
  </Teleport>
</template>

<style src="./image-preview.css"></style>
