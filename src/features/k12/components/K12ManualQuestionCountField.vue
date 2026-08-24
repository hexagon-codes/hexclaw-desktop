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
  return Number.isInteger(value) && value >= props.min && value <= props.max ? value : null
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
    class="manual-count k12-manual-count-control"
    :class="{ 'manual-count--invalid': invalid }"
    role="group"
    :aria-label="label"
    :data-testid="`manual-count-${track}`"
  >
    <span class="manual-count__label k12-manual-count-control__label">题数</span>
    <span class="manual-count__stepper k12-manual-count-stepper">
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
      <button
        type="button"
        class="manual-count__step"
        :disabled="disabled || parsed === max"
        :aria-label="`${label}增加 1 道`"
        @click="step(1)"
      >
        +
      </button>
    </span>
    <span class="manual-count__unit k12-manual-count-control__unit">道</span>
    <small class="k12-manual-count-control__error" role="alert">
      {{ invalid ? `请输入 ${min}–${max} 的整数` : '' }}
    </small>
  </div>
</template>

<style scoped>
.manual-count {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.manual-count__label {
  font-weight: 600;
  white-space: nowrap;
}
.manual-count__unit {
  color: var(--hc-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.manual-count__stepper {
  display: grid;
  grid-template-columns: 28px 48px 28px;
  width: 106px;
  box-sizing: border-box;
  height: 30px;
  overflow: hidden;
  border: 0.5px solid var(--hc-border);
  border-radius: 9px;
  background: var(--hc-bg-input);
}
.manual-count input {
  min-width: 0;
  width: auto;
  height: auto;
  box-sizing: border-box;
  border: 0;
  border-inline: 0.5px solid var(--hc-divider);
  border-radius: 0;
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  font: 600 12px/1 var(--hc-font);
  font-variant-numeric: tabular-nums;
  text-align: center;
  outline: none;
}
.manual-count input:focus {
  box-shadow: none;
}
.manual-count input::-webkit-inner-spin-button,
.manual-count input::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}
.manual-count__step {
  display: grid;
  width: auto;
  height: auto;
  place-items: center;
  margin: 0;
  padding: 1px 6px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--hc-text-secondary);
  font: 500 15px/1 var(--hc-font);
  cursor: pointer;
}
.manual-count__step:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.manual-count__step:disabled,
.manual-count input:disabled {
  cursor: default;
  opacity: 0.5;
}
.manual-count small {
  color: var(--hc-error);
  font-size: 11px;
  line-height: 1.25;
  white-space: nowrap;
}
.manual-count--invalid input {
  border-color: var(--hc-error);
}

@supports (font: -apple-system-body) {
  /* WebKit 的半像素边框按同引擎原型收敛为 105px 总宽。 */
  .manual-count__stepper {
    width: 105px;
  }
}
</style>
