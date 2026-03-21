<script setup lang="ts">
interface Segment {
  key: string
  label: string
}

defineProps<{
  segments: Segment[]
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="hc-segmented" role="tablist">
    <button
      v-for="seg in segments"
      :key="seg.key"
      type="button"
      role="tab"
      :aria-selected="modelValue === seg.key"
      class="hc-segmented__btn"
      :class="{ 'hc-segmented__btn--active': modelValue === seg.key }"
      @click="emit('update:modelValue', seg.key)"
    >
      {{ seg.label }}
    </button>
  </div>
</template>

<style scoped>
.hc-segmented {
  display: inline-flex;
  gap: 4px;
  border-radius: 12px;
  padding: 4px;
  border: 1px solid var(--hc-border);
  background: rgba(255, 255, 255, 0.04);
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
}

.hc-segmented__btn {
  padding: 6px 10px;
  border-radius: 9px;
  font-size: 12px;
  color: var(--hc-text-muted);
  border: none;
  background: transparent;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}

.hc-segmented__btn:hover {
  color: var(--hc-text-secondary);
}

.hc-segmented__btn--active {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
  font-weight: 700;
}
</style>
