<script setup lang="ts">
import { AlertTriangle } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    message?: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
  }>(),
  {
    title: '确认操作',
    message: '此操作不可撤销，确定要继续吗？',
    confirmText: '确认',
    cancelText: '取消',
    danger: true,
  },
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50"
        @click.self="emit('cancel')"
      >
        <div
          class="w-full max-w-sm rounded-2xl border p-6 shadow-2xl"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <div class="flex items-start gap-3 mb-4">
            <div
              class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              :style="{ background: danger ? 'rgba(239,68,68,0.1)' : 'rgba(59,130,246,0.1)' }"
            >
              <AlertTriangle :size="20" :style="{ color: danger ? 'var(--hc-error)' : 'var(--hc-accent)' }" />
            </div>
            <div>
              <h3 class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ title }}</h3>
              <p class="text-xs mt-1" :style="{ color: 'var(--hc-text-secondary)' }">{{ message }}</p>
            </div>
          </div>

          <div class="flex justify-end gap-2">
            <button
              class="px-4 py-1.5 rounded-lg text-sm"
              :style="{ color: 'var(--hc-text-secondary)' }"
              @click="emit('cancel')"
            >
              {{ cancelText }}
            </button>
            <button
              class="px-4 py-1.5 rounded-lg text-sm font-medium text-white"
              :style="{ background: danger ? 'var(--hc-error)' : 'var(--hc-accent)' }"
              @click="emit('confirm')"
            >
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
