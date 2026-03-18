<script setup lang="ts">
import SearchInput from '@/components/common/SearchInput.vue'

defineProps<{
  level: string
  keyword: string
}>()

const emit = defineEmits<{
  'update:level': [value: string]
  'update:keyword': [value: string]
}>()

const levels = [
  { key: '', label: '全部' },
  { key: 'debug', label: 'Debug' },
  { key: 'info', label: 'Info' },
  { key: 'warn', label: 'Warn' },
  { key: 'error', label: 'Error' },
] as const
</script>

<template>
  <div class="flex items-center gap-3">
    <div class="flex gap-1">
      <button
        v-for="l in levels"
        :key="l.key"
        class="px-3 py-1 rounded-md text-xs font-medium transition-colors"
        :style="{
          background: level === l.key ? 'var(--hc-accent)' : 'transparent',
          color: level === l.key ? '#fff' : 'var(--hc-text-secondary)',
        }"
        @click="emit('update:level', l.key)"
      >
        {{ l.label }}
      </button>
    </div>
    <div class="flex-1" />
    <SearchInput
      :model-value="keyword"
      placeholder="搜索日志..."
      @update:model-value="emit('update:keyword', $event)"
    />
  </div>
</template>
