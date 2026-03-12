<script setup lang="ts">
defineProps<{
  text?: string
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12">
    <div class="loading-spinner mb-3" />
    <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ text || '加载中...' }}</span>
  </div>
</template>

<style scoped>
.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--hc-border);
  border-top-color: var(--hc-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
