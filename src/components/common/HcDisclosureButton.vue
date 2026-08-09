<script setup lang="ts">
const props = defineProps<{
  expanded: boolean
  expandedLabel: string
  collapsedLabel: string
}>()

const emit = defineEmits<{
  toggle: []
}>()
</script>

<template>
  <button
    type="button"
    class="hc-disclosure-button"
    :aria-expanded="props.expanded"
    :aria-label="props.expanded ? props.expandedLabel : props.collapsedLabel"
    :title="props.expanded ? props.expandedLabel : props.collapsedLabel"
    @click="emit('toggle')"
  >
    <svg viewBox="0 0 20 20" aria-hidden="true" :class="{ 'is-expanded': props.expanded }">
      <path d="m6 8 4 4 4-4" />
    </svg>
  </button>
</template>

<style scoped>
.hc-disclosure-button {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
}

.hc-disclosure-button:hover,
.hc-disclosure-button:focus-visible {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-disclosure-button svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
  transition: transform 0.15s ease;
}

.hc-disclosure-button svg.is-expanded {
  transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
  .hc-disclosure-button svg {
    transition: none;
  }
}
</style>
