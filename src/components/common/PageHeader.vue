<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <div class="hc-page-header">
    <div>
      <h1 class="hc-page-header__title">{{ title }}</h1>
      <p v-if="description" class="hc-page-header__desc">{{ description }}</p>
    </div>
    <div class="hc-page-header__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.hc-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 16px;
  flex-shrink: 0;
}

.hc-page-header__title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-page-header__desc {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin: 2px 0 0;
}

.hc-page-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
