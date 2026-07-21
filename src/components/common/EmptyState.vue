<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  icon?: Component
  emoji?: string
  title: string
  description?: string
  actionLabel?: string
}>()

const emit = defineEmits<{
  action: []
}>()
</script>

<template>
  <div class="hc-empty">
    <div class="hc-empty__icon-wrap">
      <component :is="icon" v-if="icon" :size="34" class="hc-empty__icon" />
      <span v-else-if="emoji" class="hc-empty__emoji">{{ emoji }}</span>
    </div>
    <h3 class="hc-empty__title">{{ title }}</h3>
    <p v-if="description" class="hc-empty__desc">{{ description }}</p>
    <div class="hc-empty__action">
      <button v-if="actionLabel" class="hc-btn hc-btn-primary" @click="emit('action')">
        {{ actionLabel }}
      </button>
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
  gap: 6px;
  padding: 72px 20px;
  text-align: center;
}

.hc-empty__icon-wrap {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 6px;
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
}

.hc-empty__icon {
  color: var(--hc-text-muted);
}

.hc-empty__emoji {
  font-size: 32px;
}

.hc-empty__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 2px 0 0;
}

.hc-empty__desc {
  font-size: 13px;
  color: var(--hc-text-muted);
  max-width: 440px;
  line-height: 1.5;
  margin: 0;
}

.hc-empty__action {
  margin-top: 14px;
}
</style>
