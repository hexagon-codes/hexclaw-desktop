<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  lead: string
  message: string
  confirmText: string
  cancelText: string
  closeLabel: string
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const dialogRef = ref<HTMLElement | null>(null)
const overlayRef = ref<HTMLElement | null>(null)
const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const titleId = `kb-rebuild-cancel-title-${instanceId}`
const descriptionId = `kb-rebuild-cancel-description-${instanceId}`
const backgroundInertStates = new Map<HTMLElement, boolean>()

function setBackgroundInert(inert: boolean) {
  if (!inert) {
    for (const [element, previous] of backgroundInertStates) element.inert = previous
    backgroundInertStates.clear()
    return
  }

  const overlay = overlayRef.value
  if (!overlay || backgroundInertStates.size > 0) return
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement)) continue
    if (child === overlay || child.contains(overlay) || child.matches('.hc-toast-container')) continue
    backgroundInertStates.set(child, Boolean(child.inert))
    child.inert = true
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      setBackgroundInert(false)
      return
    }
    await nextTick()
    setBackgroundInert(true)
    dialogRef.value?.focus()
  },
  { flush: 'post' },
)

onBeforeUnmount(() => setBackgroundInert(false))

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return

  const dialog = dialogRef.value
  if (!dialog) return
  const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href]')]
  if (!focusable.length) {
    event.preventDefault()
    dialog.focus()
    return
  }
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault()
    last.focus()
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || document.activeElement === dialog)
  ) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="kb-rebuild-dialog">
      <div
        v-if="open"
        ref="overlayRef"
        class="kb-rebuild-dialog__overlay"
        @click.self="emit('cancel')"
      >
        <div
          ref="dialogRef"
          class="kb-rebuild-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="descriptionId"
          tabindex="-1"
          @keydown="onKeydown"
        >
          <div class="kb-rebuild-dialog__header">
            <b :id="titleId">{{ title }}</b>
            <button
              type="button"
              class="kb-rebuild-dialog__close"
              :aria-label="closeLabel"
              @click="emit('cancel')"
            >
              ×
            </button>
          </div>
          <div class="kb-rebuild-dialog__body">
            <div :id="descriptionId" class="kb-rebuild-dialog__notice">
              <strong>{{ lead }}</strong>
              <br />{{ message }}
            </div>
          </div>
          <div class="kb-rebuild-dialog__footer">
            <button type="button" class="hc-btn" @click="emit('cancel')">
              {{ cancelText }}
            </button>
            <button type="button" class="hc-btn hc-btn-primary" @click="emit('confirm')">
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.kb-rebuild-dialog__overlay {
  position: fixed;
  z-index: var(--hc-z-modal);
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 11vh;
  background: rgba(8, 18, 32, 0.4);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
  backdrop-filter: blur(3px) saturate(120%);
}

.kb-rebuild-dialog {
  width: 478px;
  max-width: 92vw;
  overflow: hidden;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  outline: none;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
}

.kb-rebuild-dialog:focus-visible {
  box-shadow:
    0 0 0 3px var(--hc-accent-subtle),
    var(--hc-shadow-float);
}

.kb-rebuild-dialog__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 0.5px solid var(--hc-border);
}

.kb-rebuild-dialog__header b {
  color: var(--hc-text-primary);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.kb-rebuild-dialog__close {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  margin-left: auto;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--hc-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 18px;
  line-height: 1;
}

.kb-rebuild-dialog__close:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.kb-rebuild-dialog__close:focus-visible {
  outline: 3px solid var(--hc-accent-subtle);
  outline-offset: 1px;
}

.kb-rebuild-dialog__body {
  max-height: 62vh;
  overflow: auto;
  padding: 18px;
}

.kb-rebuild-dialog__notice {
  padding: 11px 13px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.kb-rebuild-dialog__notice strong {
  color: var(--hc-text-primary);
}

.kb-rebuild-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 0.5px solid var(--hc-border);
}

.kb-rebuild-dialog-enter-active,
.kb-rebuild-dialog-leave-active {
  transition: opacity 0.18s var(--hc-ease-out, ease-out);
}

.kb-rebuild-dialog-enter-from,
.kb-rebuild-dialog-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .kb-rebuild-dialog {
    animation: kb-rebuild-dialog-pop 0.32s var(--hc-ease-out, ease-out);
  }
}

@keyframes kb-rebuild-dialog-pop {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(8px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
