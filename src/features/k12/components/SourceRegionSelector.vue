<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import type { SourceRegion } from '../source-issue'

type ResizeMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'

const props = defineProps<{
  pageAssetId: string
  sourceImageUrl: string
  sourceWidth: number
  sourceHeight: number
  currentRegion?: SourceRegion
  modelValue: SourceRegion
  displayLabel: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', region: SourceRegion): void
  (event: 'escape'): void
}>()

const stage = ref<HTMLElement | null>(null)
const selection = ref<HTMLElement | null>(null)
let releasePointerListeners: (() => void) | null = null

const sourceBounds = computed(() => ({
  width: Math.max(0, Math.floor(props.sourceWidth)),
  height: Math.max(0, Math.floor(props.sourceHeight)),
}))

function clampRegion(region: Partial<SourceRegion> | undefined): SourceRegion {
  const bounds = sourceBounds.value
  if (bounds.width < 1 || bounds.height < 1) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.max(0, Math.min(bounds.width - 1, Math.round(Number(region?.x) || 0)))
  const y = Math.max(0, Math.min(bounds.height - 1, Math.round(Number(region?.y) || 0)))
  const width = Math.max(
    1,
    Math.min(bounds.width - x, Math.round(Number(region?.width) || bounds.width)),
  )
  const height = Math.max(
    1,
    Math.min(bounds.height - y, Math.round(Number(region?.height) || bounds.height)),
  )
  return { x, y, width, height }
}

const canonicalRegion = computed(() => clampRegion(props.currentRegion))
const draftRegion = computed(() => clampRegion(props.modelValue))
const selectionStyle = computed(() => {
  const bounds = sourceBounds.value
  const region = draftRegion.value
  if (bounds.width < 1 || bounds.height < 1) return undefined
  return {
    left: `${(region.x / bounds.width) * 100}%`,
    top: `${(region.y / bounds.height) * 100}%`,
    width: `${(region.width / bounds.width) * 100}%`,
    height: `${(region.height / bounds.height) * 100}%`,
  }
})

function updateDraft(region: SourceRegion): void {
  if (props.disabled) return
  emit('update:modelValue', clampRegion(region))
}

function endPointerInteraction(): void {
  releasePointerListeners?.()
  releasePointerListeners = null
  if (!props.disabled) selection.value?.focus()
}

function beginPointerInteraction(event: PointerEvent, mode: ResizeMode): void {
  if (props.disabled || event.button !== 0 || !stage.value) return
  const rect = stage.value.getBoundingClientRect()
  const bounds = sourceBounds.value
  if (rect.width <= 0 || rect.height <= 0 || bounds.width < 1 || bounds.height < 1) return

  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
  endPointerInteraction()

  const startX = event.clientX
  const startY = event.clientY
  const original = { ...draftRegion.value }
  const onMove = (moveEvent: PointerEvent) => {
    const dx = Math.round(((moveEvent.clientX - startX) * bounds.width) / rect.width)
    const dy = Math.round(((moveEvent.clientY - startY) * bounds.height) / rect.height)
    if (mode === 'move') {
      updateDraft({
        ...original,
        x: Math.max(0, Math.min(bounds.width - original.width, original.x + dx)),
        y: Math.max(0, Math.min(bounds.height - original.height, original.y + dy)),
      })
      return
    }

    let left = original.x
    let top = original.y
    let right = original.x + original.width
    let bottom = original.y + original.height
    if (mode.includes('w')) left = Math.max(0, Math.min(right - 1, original.x + dx))
    if (mode.includes('e')) {
      right = Math.min(bounds.width, Math.max(left + 1, original.x + original.width + dx))
    }
    if (mode.includes('n')) top = Math.max(0, Math.min(bottom - 1, original.y + dy))
    if (mode.includes('s')) {
      bottom = Math.min(bounds.height, Math.max(top + 1, original.y + original.height + dy))
    }
    updateDraft({ x: left, y: top, width: right - left, height: bottom - top })
  }
  const onEnd = () => endPointerInteraction()
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onEnd)
  window.addEventListener('pointercancel', onEnd)
  releasePointerListeners = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
  }
}

function adjustByKeyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('escape')
    return
  }
  if (
    props.disabled ||
    !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
  ) {
    return
  }
  event.preventDefault()
  const bounds = sourceBounds.value
  const next = { ...draftRegion.value }
  if (event.shiftKey) {
    if (event.key === 'ArrowLeft' && next.width > 1) next.width -= 1
    if (event.key === 'ArrowRight' && next.x + next.width < bounds.width) next.width += 1
    if (event.key === 'ArrowUp' && next.height > 1) next.height -= 1
    if (event.key === 'ArrowDown' && next.y + next.height < bounds.height) next.height += 1
  } else {
    if (event.key === 'ArrowLeft' && next.x > 0) next.x -= 1
    if (event.key === 'ArrowRight' && next.x + next.width < bounds.width) next.x += 1
    if (event.key === 'ArrowUp' && next.y > 0) next.y -= 1
    if (event.key === 'ArrowDown' && next.y + next.height < bounds.height) next.y += 1
  }
  updateDraft(next)
}

function focus(): void {
  selection.value?.focus()
}

defineExpose({ focus })
onBeforeUnmount(endPointerInteraction)
</script>

<template>
  <div
    class="k12-source-region-editor"
    data-source-region-editor
    :data-page-asset-id="pageAssetId"
    :data-source-width="sourceWidth"
    :data-source-height="sourceHeight"
    :data-current-region="JSON.stringify(canonicalRegion)"
  >
    <div ref="stage" class="k12-source-region-stage" data-source-region-stage>
      <img :src="sourceImageUrl" alt="当前作业原图" draggable="false" />
      <div
        ref="selection"
        class="k12-source-region-selection"
        data-source-region-selection
        :data-source-region="JSON.stringify(draftRegion)"
        :style="selectionStyle"
        :tabindex="disabled ? -1 : 0"
        role="group"
        :aria-label="`${displayLabel}题源区域；方向键移动，Shift 加方向键调整大小`"
        :aria-disabled="disabled || undefined"
        @pointerdown="beginPointerInteraction($event, 'move')"
        @keydown="adjustByKeyboard"
      >
        <span
          v-for="handle in (['nw', 'ne', 'sw', 'se'] as const)"
          :key="handle"
          class="k12-source-region-handle"
          data-source-region-handle
          :data-handle="handle"
          aria-hidden="true"
          @pointerdown.stop="beginPointerInteraction($event, handle)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.k12-source-region-editor {
  display: flex;
  justify-content: center;
  margin: 9px 0;
}
.k12-source-region-stage {
  position: relative;
  display: inline-block;
  max-width: 100%;
  overflow: visible;
  border-radius: 9px;
  background: var(--hc-bg-input);
  line-height: 0;
}
.k12-source-region-stage > img {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 320px;
  border-radius: 9px;
  user-select: none;
  -webkit-user-drag: none;
}
.k12-source-region-selection {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid var(--hc-accent);
  outline: none;
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  cursor: move;
  touch-action: none;
}
.k12-source-region-selection:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--hc-accent) 32%, transparent);
}
.k12-source-region-handle {
  position: absolute;
  width: 24px;
  height: 24px;
  transform: translate(-50%, -50%);
  background: transparent;
  touch-action: none;
}
.k12-source-region-handle::after {
  position: absolute;
  top: 6px;
  left: 6px;
  box-sizing: border-box;
  width: 12px;
  height: 12px;
  border: 2px solid var(--hc-bg-card);
  border-radius: 50%;
  background: var(--hc-accent);
  content: '';
}
.k12-source-region-handle[data-handle='nw'] {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}
.k12-source-region-handle[data-handle='ne'] {
  top: 0;
  left: 100%;
  cursor: nesw-resize;
}
.k12-source-region-handle[data-handle='sw'] {
  top: 100%;
  left: 0;
  cursor: nesw-resize;
}
.k12-source-region-handle[data-handle='se'] {
  top: 100%;
  left: 100%;
  cursor: nwse-resize;
}
</style>
