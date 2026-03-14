<script setup lang="ts">
defineProps<{
  text?: string
}>()
</script>

<template>
  <div class="hc-loading">
    <div class="hc-loading__spinner" />
    <span class="hc-loading__text">{{ text || '...' }}</span>
  </div>
</template>

<style scoped>
.hc-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  gap: 12px;
}

.hc-loading__spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--hc-border);
  border-top-color: var(--hc-accent);
  border-radius: 50%;
  animation: hc-spin 0.7s linear infinite;
}

.hc-loading__text {
  font-size: 12px;
  color: var(--hc-text-muted);
}
</style>
