<script setup lang="ts">
import { AlertTriangle, Info } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    message?: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
    confirmDelayMs?: number
    /** Distinguishes destructive targets while the same dialog instance stays open. */
    confirmationKey?: string | number | null
  }>(),
  {
    title: '确认操作',
    message: '此操作不可撤销，确定要继续吗？',
    confirmText: '确认',
    cancelText: '取消',
    danger: true,
    confirmDelayMs: 0,
    confirmationKey: null,
  },
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const confirmLocked = ref(false)
const confirmCommitted = ref(false)
let confirmUnlockTimer: ReturnType<typeof setTimeout> | null = null

function clearConfirmDelay() {
  if (confirmUnlockTimer) clearTimeout(confirmUnlockTimer)
  confirmUnlockTimer = null
}

function restartConfirmDelay() {
  clearConfirmDelay()
  confirmCommitted.value = false
  const delay = Math.max(0, props.confirmDelayMs)
  confirmLocked.value = props.open && delay > 0
  if (!confirmLocked.value) return
  confirmUnlockTimer = setTimeout(() => {
    confirmLocked.value = false
    confirmUnlockTimer = null
  }, delay)
}

function handleCancel() {
  clearConfirmDelay()
  emit('cancel')
}

function handleConfirm() {
  if (confirmLocked.value || confirmCommitted.value) return
  confirmCommitted.value = true
  clearConfirmDelay()
  emit('confirm')
}

watch(
  [() => props.open, () => props.confirmDelayMs, () => props.confirmationKey],
  restartConfirmDelay,
  { immediate: true, flush: 'sync' },
)

function handleKeydown(event: KeyboardEvent) {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  handleCancel()
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => {
  clearConfirmDelay()
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="hc-dialog">
      <div
        v-if="open"
        class="hc-dialog-overlay"
        @click.self="handleCancel"
      >
        <div class="hc-dialog" role="alertdialog" aria-modal="true" aria-labelledby="hc-confirm-dialog-title">
          <div class="hc-dialog__header">
            <div class="hc-dialog__icon" :class="danger ? 'hc-dialog__icon--danger' : 'hc-dialog__icon--info'">
              <AlertTriangle v-if="danger" :size="20" />
              <Info v-else :size="20" />
            </div>
            <div>
              <h3 id="hc-confirm-dialog-title" class="hc-dialog__title">{{ title }}</h3>
              <p class="hc-dialog__msg">{{ message }}</p>
            </div>
          </div>
          <div class="hc-dialog__actions">
            <button class="hc-btn hc-btn-secondary" @click="handleCancel">{{ cancelText }}</button>
            <button
              class="hc-btn"
              :class="danger ? 'hc-dialog__btn--danger' : 'hc-btn-primary'"
              :disabled="confirmLocked || confirmCommitted"
              @click="handleConfirm"
            >
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hc-dialog-overlay {
  position: fixed;
  top: var(--hc-titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.hc-dialog {
  width: 100%;
  max-width: 380px;
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  padding: 24px;
  animation: hc-scale-in 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-dialog__header {
  display: flex;
  gap: 14px;
  margin-bottom: 20px;
}

.hc-dialog__icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.hc-dialog__icon--danger {
  background: rgba(245, 101, 101, 0.1);
  color: var(--hc-error);
}

.hc-dialog__icon--info {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}

.hc-dialog__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-dialog__msg {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin: 4px 0 0;
  line-height: 1.5;
}

.hc-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.hc-dialog__btn--danger {
  background: var(--hc-error);
  color: #fff;
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--hc-radius-sm);
}

.hc-dialog__btn--danger:hover:not(:disabled) {
  opacity: 0.9;
}

.hc-dialog__btn--danger:disabled,
.hc-dialog__btn--danger:disabled:hover {
  cursor: not-allowed;
  background: var(--hc-error);
  color: #fff;
  opacity: 0.45;
  transform: none;
  box-shadow: none;
  transition: none;
}

/* Transitions */
.hc-dialog-enter-active {
  transition: opacity 0.2s ease-out;
}
.hc-dialog-leave-active {
  transition: opacity 0.15s ease-in;
}
.hc-dialog-enter-from,
.hc-dialog-leave-to {
  opacity: 0;
}
</style>
