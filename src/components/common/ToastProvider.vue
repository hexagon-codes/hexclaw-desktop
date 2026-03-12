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
    <div class="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      <TransitionGroup
        enter-active-class="transition-all duration-300 ease-out"
        leave-active-class="transition-all duration-200 ease-in"
        enter-from-class="opacity-0 translate-x-8"
        leave-to-class="opacity-0 translate-x-8"
      >
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-lg min-w-[280px] max-w-[400px]"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <component :is="iconMap[toast.type]" :size="18" :style="{ color: colorMap[toast.type] }" class="flex-shrink-0" />
          <span class="flex-1 text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ toast.message }}</span>
          <button
            class="flex-shrink-0 p-0.5 rounded hover:bg-white/5 transition-colors"
            :style="{ color: 'var(--hc-text-muted)' }"
            @click="removeToast(toast.id)"
          >
            <X :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
