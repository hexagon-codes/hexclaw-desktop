<script setup lang="ts">
import { ref } from 'vue'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-vue-next'
import type { Toast } from '@/types'

const toasts = ref<Toast[]>([])
let nextId = 0

function addToast(type: Toast['type'], message: string, duration = 3000) {
  const id = nextId++
  toasts.value.push({ id, type, message })
  if (duration > 0) {
    setTimeout(() => removeToast(id), duration)
  }
}

function removeToast(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

const iconMap = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
} as const

const colorMap = {
  success: 'var(--hc-success)',
  error: 'var(--hc-error)',
  warning: 'var(--hc-warning)',
  info: 'var(--hc-accent)',
} as const

defineExpose({
  success: (msg: string) => addToast('success', msg),
  error: (msg: string) => addToast('error', msg),
  warning: (msg: string) => addToast('warning', msg),
  info: (msg: string) => addToast('info', msg),
})
</script>

<template>
  <Teleport to="body">
    <div class="hc-toast-container">
      <TransitionGroup
        enter-active-class="hc-toast--enter"
        leave-active-class="hc-toast--leave"
        enter-from-class="hc-toast--hidden"
        leave-to-class="hc-toast--hidden"
      >
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="hc-toast"
        >
          <component
            :is="iconMap[toast.type]"
            :size="17"
            :style="{ color: colorMap[toast.type] }"
            class="hc-toast__icon"
          />
          <span class="hc-toast__msg">{{ toast.message }}</span>
          <button class="hc-toast__close" @click="removeToast(toast.id)">
            <X :size="13" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.hc-toast-container {
  position: fixed;
  top: calc(var(--hc-titlebar-height) + var(--hc-space-2));
  right: var(--hc-space-4);
  z-index: var(--hc-z-toast);
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.hc-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--hc-space-3);
  padding: var(--hc-space-3) var(--hc-space-4);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-lg);
  backdrop-filter: saturate(180%) blur(var(--hc-blur));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur));
  min-width: 260px;
  max-width: 400px;
}

.hc-toast__icon {
  flex-shrink: 0;
}

.hc-toast__msg {
  flex: 1;
  font-size: 13px;
  color: var(--hc-text-primary);
  line-height: 1.4;
}

.hc-toast__close {
  flex-shrink: 0;
  padding: 3px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: background 0.15s;
}

.hc-toast__close:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.hc-toast--enter {
  transition: all 0.3s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-toast--leave {
  transition: all 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-toast--hidden {
  opacity: 0;
  transform: translateX(16px) scale(0.96);
}
</style>
