<script setup lang="ts">
import { AlertTriangle } from 'lucide-vue-next'

defineProps<{
  title?: string
  message: string
  retryable?: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <AlertTriangle :size="40" class="mb-3" :style="{ color: 'var(--hc-error)' }" />
    <h3 class="text-sm font-medium mb-1" :style="{ color: 'var(--hc-text-primary)' }">
      {{ title || '出错了' }}
    </h3>
    <p class="text-xs mb-4 max-w-xs" :style="{ color: 'var(--hc-text-secondary)' }">
      {{ message }}
    </p>
    <button
      v-if="retryable !== false"
      class="px-3 py-1.5 rounded-lg text-xs text-white"
      :style="{ background: 'var(--hc-accent)' }"
      @click="emit('retry')"
    >
      重试
    </button>
  </div>
</template>
