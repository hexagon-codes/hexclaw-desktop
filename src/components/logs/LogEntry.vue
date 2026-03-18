<script setup lang="ts">
import type { LogEntry } from '@/api/logs'

defineProps<{
  entry: LogEntry
}>()

const levelColors: Record<string, string> = {
  debug: 'var(--hc-text-muted)',
  info: 'var(--hc-accent)',
  warn: 'var(--hc-warning)',
  error: 'var(--hc-error)',
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
  <div class="hc-log-entry">
    <span class="hc-log-entry__time">{{ formatTime(entry.timestamp) }}</span>
    <span class="hc-log-entry__level" :style="{ color: levelColors[entry.level] || 'var(--hc-text-secondary)' }">
      {{ entry.level }}
    </span>
    <span class="hc-log-entry__source">{{ entry.source }}</span>
    <span class="hc-log-entry__msg">{{ entry.message }}</span>
    <span v-if="entry.trace_id" class="hc-log-entry__trace">{{ entry.trace_id.slice(0, 8) }}</span>
  </div>
</template>

<style scoped>
.hc-log-entry {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 4px 20px;
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 12px;
  line-height: 1.6;
  border-bottom: 1px solid var(--hc-border-subtle);
  transition: background 0.1s;
}

.hc-log-entry:hover {
  background: var(--hc-bg-hover);
}

.hc-log-entry__time {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
  flex-shrink: 0;
  padding-top: 1px;
}

.hc-log-entry__level {
  width: 44px;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  flex-shrink: 0;
  padding-top: 2px;
}

.hc-log-entry__source {
  font-size: 11px;
  color: var(--hc-text-muted);
  flex-shrink: 0;
  width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-top: 1px;
}

.hc-log-entry__msg {
  flex: 1;
  color: var(--hc-text-primary);
  word-break: break-all;
}

.hc-log-entry__trace {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
  flex-shrink: 0;
  padding-top: 2px;
}
</style>
