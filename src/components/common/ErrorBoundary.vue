<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, RotateCcw } from 'lucide-vue-next'
import { logger } from '@/utils/logger'

const { t } = useI18n()
const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err
  logger.error('组件渲染异常', err)
  return false
})

function retry() {
  error.value = null
}
</script>

<template>
  <div v-if="error" class="h-full flex items-center justify-center p-8">
    <div class="text-center max-w-sm">
      <AlertCircle :size="48" class="mx-auto mb-4 opacity-40" :style="{ color: 'var(--hc-error)' }" />
      <h3 class="text-sm font-medium mb-2" :style="{ color: 'var(--hc-text-primary)' }">
        {{ t('error.renderError') }}
      </h3>
      <p class="text-xs mb-4" :style="{ color: 'var(--hc-text-muted)' }">
        {{ error.message }}
      </p>
      <button
        class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white"
        :style="{ background: 'var(--hc-accent)' }"
        @click="retry"
      >
        <RotateCcw :size="14" />
        {{ t('error.retry') }}
      </button>
    </div>
  </div>
  <slot v-else />
</template>
