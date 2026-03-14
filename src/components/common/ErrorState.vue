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
  <div class="hc-error-state">
    <div class="hc-error-state__icon-wrap">
      <AlertTriangle :size="24" class="hc-error-state__icon" />
    </div>
    <h3 class="hc-error-state__title">{{ title || '出错了' }}</h3>
    <p class="hc-error-state__msg">{{ message }}</p>
    <button
      v-if="retryable !== false"
      class="hc-btn hc-btn-primary"
      @click="emit('retry')"
    >
      重试
    </button>
  </div>
</template>

<style scoped>
.hc-error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
  animation: hc-fade-in 0.4s ease-out;
}

.hc-error-state__icon-wrap {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: rgba(245, 101, 101, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}

.hc-error-state__icon {
  color: var(--hc-error);
}

.hc-error-state__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0 0 4px;
}

.hc-error-state__msg {
  font-size: 13px;
  color: var(--hc-text-secondary);
  max-width: 300px;
  margin: 0 0 16px;
}
</style>
