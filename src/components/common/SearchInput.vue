<script setup lang="ts">
import { Search, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  modelValue: string
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="hc-search">
    <Search :size="14" class="hc-search__icon" />
    <input
      :value="modelValue"
      type="text"
      class="hc-search__input"
      :placeholder="placeholder || `${t('common.search')}...`"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      v-if="modelValue"
      class="hc-search__clear"
      @click="emit('update:modelValue', '')"
    >
      <X :size="12" />
    </button>
  </div>
</template>

<style scoped>
.hc-search {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--hc-radius-sm);
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  padding: 0 10px;
  height: 32px;
  width: 200px;
  box-sizing: border-box;
  transition: border-color 0.2s, box-shadow 0.2s;
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

.hc-search__clear {
  flex-shrink: 0;
  padding: 2px;
  border-radius: 50%;
  border: none;
  background: var(--hc-bg-hover);
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.hc-search__clear:hover {
  background: var(--hc-bg-active);
  color: var(--hc-text-secondary);
}
</style>
