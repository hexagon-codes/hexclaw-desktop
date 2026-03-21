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
  gap: 18px;
  align-items: flex-start;
  padding: 18px;
  flex-shrink: 0;
}

.hc-page-header__main {
  flex: 1;
  min-width: 0;
}

.hc-page-header__eyebrow {
  font-size: 11px;
  color: var(--hc-accent);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-weight: 800;
}

.hc-page-header__title {
  margin: 8px 0 0;
  font-size: 26px;
  line-height: 1.15;
  font-weight: 800;
  color: var(--hc-text-primary);
  letter-spacing: -0.01em;
}

.hc-page-header__desc {
  margin: 7px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--hc-text-muted);
}

.hc-page-header__side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-end;
  flex-shrink: 0;
}

.hc-page-header__status {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
}

.hc-page-header__status::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.hc-page-header__status--success {
  background: rgba(50, 213, 131, 0.12);
  color: var(--hc-success);
}

.hc-page-header__status--warning {
  background: rgba(240, 180, 41, 0.12);
  color: var(--hc-warning);
}

.hc-page-header__status--error {
  background: rgba(245, 101, 101, 0.12);
  color: var(--hc-error);
}

.hc-page-header__time {
  font-size: 11px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  color: var(--hc-text-muted);
}
</style>
