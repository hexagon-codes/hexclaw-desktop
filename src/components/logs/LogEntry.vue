<script setup lang="ts">
import type { LogEntry } from '@/api/logs'

const props = defineProps<{
  entry: LogEntry
}>()

const levelColors: Record<string, string> = {
  debug: '#8b8b8b',
  info: '#3b82f6',
  warn: '#eab308',
  error: '#ef4444',
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return (
      d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      '.' +
      String(d.getMilliseconds()).padStart(3, '0')
    )
  } catch {
    return ts
  }
}
</script>

<template>
  <div class="flex items-start gap-3 px-6 py-1.5 hover:bg-white/[0.02] border-b border-white/[0.03] font-mono text-xs">
    <span class="text-[10px] tabular-nums shrink-0 pt-0.5" :style="{ color: 'var(--hc-text-muted)' }">
      {{ formatTime(entry.timestamp) }}
    </span>
    <span
      class="w-11 text-center text-[10px] font-bold uppercase shrink-0 pt-0.5"
      :style="{ color: levelColors[entry.level] || 'var(--hc-text-secondary)' }"
    >
      {{ entry.level }}
    </span>
    <span class="text-[10px] shrink-0 pt-0.5 w-16 truncate" :style="{ color: 'var(--hc-text-muted)' }">
      {{ entry.source }}
    </span>
    <span class="flex-1 break-all" :style="{ color: 'var(--hc-text-primary)' }">
      {{ entry.message }}
    </span>
    <span
      v-if="entry.trace_id"
      class="text-[9px] shrink-0 pt-0.5 tabular-nums"
      :style="{ color: 'var(--hc-text-muted)' }"
    >
      {{ entry.trace_id.slice(0, 8) }}
    </span>
  </div>
</template>
