<script setup lang="ts">
export interface K12BookTab {
  key: string
  label: string
  count?: number
  testId?: string
}

defineProps<{
  modelValue: string
  tabs: readonly K12BookTab[]
  label: string
}>()

const emit = defineEmits<{
  (event: 'select', key: string): void
}>()
</script>

<template>
  <div class="seg k12-book-tabs" role="tablist" :aria-label="label">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.key"
      :aria-label="tab.count === undefined ? tab.label : `${tab.label} ${tab.count}`"
      :class="{ on: modelValue === tab.key }"
      :data-testid="tab.testId"
      @click="emit('select', tab.key)"
    >
      {{ tab.label }}
      <span
        v-if="tab.count !== undefined"
        class="k12-tab-count"
        aria-hidden="true"
        :data-count="tab.count"
      />
    </button>
  </div>
</template>

<style scoped>
.k12-book-tabs {
  display: inline-flex;
  gap: 3px;
  overflow-x: auto;
  max-width: 100%;
  flex: 1 1 auto;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
}
.k12-book-tabs button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  padding: 7px 12px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  box-shadow: none;
  color: var(--hc-text-secondary);
  font: inherit;
  cursor: pointer;
  transition:
    background 0.15s var(--hc-ease-out),
    color 0.15s var(--hc-ease-out);
}
.k12-book-tabs button:hover:not(.on) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12-book-tabs button.on {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  box-shadow: none;
  font-weight: 600;
}
.k12-tab-count {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 999px;
  background: var(--hc-bg-input);
  color: var(--hc-text-muted);
  font-size: 10px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}
.k12-tab-count::before {
  content: attr(data-count);
}
.k12-book-tabs button.on .k12-tab-count {
  background: color-mix(in srgb, var(--hc-accent) 15%, transparent);
  color: var(--hc-accent);
}
</style>
