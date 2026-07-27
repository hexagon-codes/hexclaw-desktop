<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: number | null
  min: number
  max: number
  label: string
  track: 'textbook_consolidation' | 'arithmetic_warmup'
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: number | null): void
}>()

const draft = ref(props.modelValue === null ? '' : String(props.modelValue))

watch(
  () => props.modelValue,
  (value) => {
    const next = value === null ? '' : String(value)
    if (draft.value !== next) draft.value = next
  },
)

const parsed = computed(() => {
  if (!/^\d+$/.test(draft.value.trim())) return null
  const value = Number(draft.value)
  return Number.isInteger(value) && value >= props.min && value <= props.max
    ? value
    : null
})
const invalid = computed(() => parsed.value === null)

function updateDraft(value: string) {
  draft.value = value
  emit('update:modelValue', parsed.value)
}

function step(delta: number) {
  if (props.disabled) return
  const base = parsed.value ?? props.modelValue ?? props.min
  const next = Math.min(props.max, Math.max(props.min, base + delta))
  draft.value = String(next)
  emit('update:modelValue', next)
}
</script>

<template>
  <div
    class="manual-count"
    :class="{ 'manual-count--invalid': invalid }"
    role="group"
    :aria-label="label"
    :data-testid="`manual-count-${track}`"
  >
    <span class="manual-count__label">题数</span>
    <button
      type="button"
      class="manual-count__step"
      :disabled="disabled || parsed === min"
      :aria-label="`${label}减少 1 道`"
      @click="step(-1)"
    >
      −
    </button>
    <input
      :value="draft"
      type="number"
      inputmode="numeric"
      :min="min"
      :max="max"
      step="1"
      :disabled="disabled"
      :aria-invalid="invalid"
      @input="updateDraft(($event.target as HTMLInputElement).value)"
    />
    <span class="manual-count__unit">道</span>
    <button
      type="button"
      class="manual-count__step"
      :disabled="disabled || parsed === max"
      :aria-label="`${label}增加 1 道`"
      @click="step(1)"
    >
      +
    </button>
    <small v-if="invalid" role="alert">请输入 {{ min }}–{{ max }} 的整数</small>
  </div>
</template>

<style scoped>
.manual-count {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.manual-count__label,
.manual-count__unit {
  color: var(--hc-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.manual-count input {
  width: 50px;
  height: 30px;
  box-sizing: border-box;
  border: 0.5px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: center;
  outline: none;
}
.manual-count input:focus {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--hc-accent) 16%, transparent);
}
.manual-count input::-webkit-inner-spin-button,
.manual-count input::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}
.manual-count__step {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  margin: 0;
  padding: 0;
  border: 0.5px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  font: inherit;
  cursor: pointer;
}
.manual-count__step:disabled,
.manual-count input:disabled {
  cursor: default;
  opacity: 0.5;
}
.manual-count small {
  color: var(--hc-error);
  font-size: 11px;
  white-space: nowrap;
}
.manual-count--invalid input {
  border-color: var(--hc-error);
}
</style>
