<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  status: 'online' | 'offline' | 'error' | 'warning' | 'idle' | 'running'
}>()

const config = computed(() => {
  const map: Record<string, { color: string; label: string }> = {
    online: { color: '#22c55e', label: '在线' },
    offline: { color: '#6b7280', label: '离线' },
    error: { color: '#ef4444', label: '错误' },
    warning: { color: '#eab308', label: '警告' },
    idle: { color: '#6b7280', label: '空闲' },
    running: { color: '#3b82f6', label: '运行中' },
  }
  return map[props.status] ?? { color: '#6b7280', label: '离线' }
})
</script>

<template>
  <span class="inline-flex items-center gap-1">
    <span
      class="w-1.5 h-1.5 rounded-full"
      :style="{ background: config.color }"
    />
    <span class="text-[10px]" :style="{ color: config.color }">{{ config.label }}</span>
  </span>
</template>
