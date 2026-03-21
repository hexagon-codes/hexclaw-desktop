<script setup lang="ts">
defineProps<{
  label: string
  value: string
}>()
</script>

<template>
  <div class="hc-kv-row">
    <span class="hc-kv-row__label">{{ label }}</span>
    <span class="hc-kv-row__value">{{ value }}</span>
  </div>
</template>

<style scoped>
.hc-kv-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  line-height: 1.4;
}

.hc-kv-row__label {
  flex-shrink: 0;
  color: var(--hc-text-secondary);
}

.hc-kv-row__value {
  text-align: right;
  color: var(--hc-text-primary);
  word-break: break-word;
}
</style>
