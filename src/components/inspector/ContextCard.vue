<script setup lang="ts">
defineProps<{
  eyebrow?: string
  title: string
  description?: string
}>()
</script>

<template>
  <section class="hc-context-card">
    <p v-if="eyebrow" class="hc-context-card__eyebrow">{{ eyebrow }}</p>
    <h3 class="hc-context-card__title">{{ title }}</h3>
    <p v-if="description" class="hc-context-card__desc">{{ description }}</p>
    <div v-if="$slots.default" class="hc-context-card__slot">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.hc-context-card {
  border: 1px solid var(--hc-border-subtle);
  border-radius: var(--hc-radius-md);
  padding: 12px 14px;
  background: var(--hc-bg-card);
}

.hc-context-card__eyebrow {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--hc-accent);
}

.hc-context-card__title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--hc-text-primary);
}

.hc-context-card__desc {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--hc-text-secondary);
}

.hc-context-card__slot {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-context-card__desc:last-child {
  margin-bottom: 0;
}

.hc-context-card__title:last-child {
  margin-bottom: 0;
}
</style>
