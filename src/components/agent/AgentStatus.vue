<script setup lang="ts">
import { Activity, Zap, Clock, DollarSign } from 'lucide-vue-next'

defineProps<{
  rounds?: number
  tokens?: number
  cost?: number
  latency?: number
}>()
</script>

<template>
  <div class="grid grid-cols-2 gap-2">
    <div
      class="flex items-center gap-2 rounded-lg p-2"
      :style="{ background: 'var(--hc-bg-hover)' }"
    >
      <Activity :size="14" :style="{ color: 'var(--hc-accent)' }" />
      <div>
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">轮次</div>
        <div class="text-sm font-medium tabular-nums" :style="{ color: 'var(--hc-text-primary)' }">
          {{ rounds ?? '-' }}
        </div>
      </div>
    </div>
    <div
      class="flex items-center gap-2 rounded-lg p-2"
      :style="{ background: 'var(--hc-bg-hover)' }"
    >
      <Zap :size="14" :style="{ color: 'var(--hc-warning)' }" />
      <div>
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">Tokens</div>
        <div class="text-sm font-medium tabular-nums" :style="{ color: 'var(--hc-text-primary)' }">
          {{ tokens?.toLocaleString() ?? '-' }}
        </div>
      </div>
    </div>
    <div
      class="flex items-center gap-2 rounded-lg p-2"
      :style="{ background: 'var(--hc-bg-hover)' }"
    >
      <DollarSign :size="14" :style="{ color: 'var(--hc-success)' }" />
      <div>
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">费用</div>
        <div class="text-sm font-medium tabular-nums" :style="{ color: 'var(--hc-text-primary)' }">
          ${{ cost?.toFixed(4) ?? '-' }}
        </div>
      </div>
    </div>
    <div
      class="flex items-center gap-2 rounded-lg p-2"
      :style="{ background: 'var(--hc-bg-hover)' }"
    >
      <Clock :size="14" :style="{ color: 'var(--hc-text-secondary)' }" />
      <div>
        <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">延迟</div>
        <div class="text-sm font-medium tabular-nums" :style="{ color: 'var(--hc-text-primary)' }">
          {{ latency ? latency.toFixed(1) + 's' : '-' }}
        </div>
      </div>
    </div>
  </div>
</template>
