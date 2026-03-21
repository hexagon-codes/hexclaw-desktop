<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Activity, Zap, AlertTriangle, Clock } from 'lucide-vue-next'
import type { LogStats } from '@/api/logs'

const { t } = useI18n()

defineProps<{
  stats: LogStats
}>()
</script>

<template>
  <div class="grid grid-cols-4 gap-3 p-4">
    <div
      class="rounded-lg p-3"
      :style="{ background: 'var(--hc-bg-card)', border: '1px solid var(--hc-border)' }"
    >
      <div class="flex items-center gap-2 mb-1">
        <Activity :size="14" :style="{ color: 'var(--hc-accent)' }" />
        <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">Total</span>
      </div>
      <div class="text-lg font-semibold tabular-nums" :style="{ color: 'var(--hc-text-primary)' }">
        {{ stats.total.toLocaleString() }}
      </div>
    </div>

    <div
      class="rounded-lg p-3"
      :style="{ background: 'var(--hc-bg-card)', border: '1px solid var(--hc-border)' }"
    >
      <div class="flex items-center gap-2 mb-1">
        <Zap :size="14" :style="{ color: '#3b82f6' }" />
        <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">Info</span>
      </div>
      <div class="text-lg font-semibold tabular-nums" :style="{ color: 'var(--hc-text-primary)' }">
        {{ (stats.by_level?.info || 0).toLocaleString() }}
      </div>
    </div>

    <div
      class="rounded-lg p-3"
      :style="{ background: 'var(--hc-bg-card)', border: '1px solid var(--hc-border)' }"
    >
      <div class="flex items-center gap-2 mb-1">
        <AlertTriangle :size="14" :style="{ color: '#ef4444' }" />
        <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('statusBadge.error') }}</span>
      </div>
      <div class="text-lg font-semibold tabular-nums" :style="{ color: 'var(--hc-text-primary)' }">
        {{ (stats.by_level?.error || 0).toLocaleString() }}
      </div>
    </div>

    <div
      class="rounded-lg p-3"
      :style="{ background: 'var(--hc-bg-card)', border: '1px solid var(--hc-border)' }"
    >
      <div class="flex items-center gap-2 mb-1">
        <Clock :size="14" :style="{ color: 'var(--hc-text-secondary)' }" />
        <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">Req/min</span>
      </div>
      <div class="text-lg font-semibold tabular-nums" :style="{ color: 'var(--hc-text-primary)' }">
        {{ (stats.requests_per_minute || 0).toFixed(1) }}
      </div>
    </div>
  </div>
</template>
