<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  icon?: Component
  title: string
  description?: string
}>()
</script>

<template>
  <div class="hc-empty">
    <div class="hc-empty__icon-wrap">
      <component
        :is="icon"
        v-if="icon"
        :size="36"
        class="hc-empty__icon"
      />
    </div>
    <h3 class="hc-empty__title">{{ title }}</h3>
    <p v-if="description" class="hc-empty__desc">{{ description }}</p>
    <div class="hc-empty__action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.hc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
  animation: hc-fade-in 0.4s ease-out;
}

.hc-empty__icon-wrap {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: var(--hc-bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.hc-empty__icon {
  color: var(--hc-text-muted);
  opacity: 0.6;
}

.hc-empty__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0 0 4px;
}

.hc-empty__desc {
  font-size: 13px;
  color: var(--hc-text-muted);
  max-width: 280px;
  line-height: 1.5;
  margin: 0;
}

.hc-empty__action {
  margin-top: 16px;
}
</style>
