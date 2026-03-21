<script setup lang="ts">
defineProps<{
  eyebrow?: string
  title: string
  description?: string
  status?: string
  statusVariant?: 'success' | 'warning' | 'error'
  timestamp?: string
}>()
</script>

<template>
  <div class="hc-page-header">
    <div class="hc-page-header__main">
      <div v-if="eyebrow" class="hc-page-header__eyebrow">{{ eyebrow }}</div>
      <h1 class="hc-page-header__title">{{ title }}</h1>
      <p v-if="description" class="hc-page-header__desc">{{ description }}</p>
    </div>
    <div class="hc-page-header__side">
      <div
        v-if="status"
        class="hc-page-header__status"
        :class="`hc-page-header__status--${statusVariant || 'success'}`"
      >
        {{ status }}
      </div>
      <div v-if="timestamp" class="hc-page-header__time">{{ timestamp }}</div>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.hc-page-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 12px 18px;
  flex-shrink: 0;
}

.hc-page-header__main {
  flex: 1;
  min-width: 0;
}

.hc-page-header__eyebrow {
  font-size: 10px;
  color: var(--hc-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-weight: 600;
}

.hc-page-header__title {
  margin: 2px 0 0;
  font-size: 20px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--hc-text-primary);
  letter-spacing: -0.01em;
}

.hc-page-header__desc {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-muted);
}

.hc-page-header__side {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.hc-page-header__status {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}

.hc-page-header__status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.hc-page-header__status--success {
  background: rgba(50, 213, 131, 0.1);
  color: var(--hc-success);
}

.hc-page-header__status--warning {
  background: rgba(240, 180, 41, 0.1);
  color: var(--hc-warning);
}

.hc-page-header__status--error {
  background: rgba(245, 101, 101, 0.1);
  color: var(--hc-error);
}

.hc-page-header__time {
  font-size: 10px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  color: var(--hc-text-muted);
  opacity: 0.7;
}
</style>
