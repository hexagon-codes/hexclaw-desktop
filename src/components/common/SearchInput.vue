<script setup lang="ts">
import { Search, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  fluid?: boolean
  inputTestId?: string
  clearTestId?: string
  disabled?: boolean
}>(), {
  fluid: false,
  inputTestId: undefined,
  clearTestId: undefined,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  submit: []
}>()
</script>

<template>
  <div class="hc-search" :class="{ 'hc-search--fluid': fluid }">
    <Search :size="14" class="hc-search__icon" />
    <input
      :value="modelValue"
      :data-testid="inputTestId"
      type="text"
      class="hc-search__input"
      :disabled="disabled"
      :placeholder="placeholder || `${t('common.search')}...`"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('submit')"
    />
    <button
      v-if="modelValue"
      type="button"
      :data-testid="clearTestId"
      class="hc-search__clear"
      aria-label="Clear search"
      @click.stop="emit('update:modelValue', '')"
    >
      <X :size="13" />
    </button>
  </div>
</template>

<style scoped>
.hc-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 999px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  padding: 0 8px 0 12px;
  height: 32px;
  width: 200px;
  box-sizing: border-box;
  transition:
    border-color 0.2s,
    box-shadow 0.2s,
    background-color 0.15s;
}

.hc-search--fluid {
  width: 100%;
}

.hc-search:focus-within {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-search__icon {
  flex-shrink: 0;
  color: var(--hc-text-muted);
}

.hc-search__input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 13px;
  color: var(--hc-text-primary);
  min-width: 0;
}

.hc-search__input::placeholder {
  color: var(--hc-text-muted);
}

.hc-search__input:disabled {
  cursor: not-allowed;
}

.hc-search:has(.hc-search__input:disabled) {
  opacity: 0.55;
}

.hc-search__clear {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.82;
  transition:
    background-color 150ms cubic-bezier(0.16, 1, 0.3, 1),
    color 150ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 150ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hc-search__clear:hover {
  background: color-mix(in srgb, var(--hc-text-muted) 14%, transparent);
  color: var(--hc-text-secondary);
  opacity: 1;
  transform: scale(1.03);
}

.hc-search__clear:focus-visible {
  outline: none;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--hc-accent) 22%, transparent);
}

.hc-search__clear:active {
  transform: scale(0.94);
}
</style>
