<script setup lang="ts">
import { Search, X } from 'lucide-vue-next'

defineProps<{
  modelValue: string
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div
    class="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 w-[200px]"
    :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)' }"
  >
    <Search :size="14" class="flex-shrink-0" :style="{ color: 'var(--hc-text-muted)' }" />
    <input
      :value="modelValue"
      type="text"
      class="flex-1 bg-transparent outline-none text-xs min-w-0"
      :style="{ color: 'var(--hc-text-primary)' }"
      :placeholder="placeholder || '搜索...'"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      v-if="modelValue"
      class="flex-shrink-0"
      :style="{ color: 'var(--hc-text-muted)' }"
      @click="emit('update:modelValue', '')"
    >
      <X :size="12" />
    </button>
  </div>
</template>
