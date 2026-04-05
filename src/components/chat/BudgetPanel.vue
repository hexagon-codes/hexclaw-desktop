<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Coins, Clock, DollarSign } from 'lucide-vue-next'

const { t } = useI18n()

interface Props {
  maxTokens: number
  usedTokens: number
  maxDuration: string // e.g. "30m"
  elapsedSeconds: number
  maxCost: number
  usedCost: number
}

const props = withDefaults(defineProps<Props>(), {
  maxTokens: 500000,
  usedTokens: 0,
  maxDuration: '30m',
  elapsedSeconds: 0,
  maxCost: 5.0,
  usedCost: 0,
})

const tokenPct = computed(() => props.maxTokens > 0 ? Math.min(100, (props.usedTokens / props.maxTokens) * 100) : 0)
const maxDurSeconds = computed(() => {
  const m = props.maxDuration.match(/^(\d+)m$/)
  return m ? parseInt(m[1]!) * 60 : 1800
})
const durationPct = computed(() => maxDurSeconds.value > 0 ? Math.min(100, (props.elapsedSeconds / maxDurSeconds.value) * 100) : 0)
const costPct = computed(() => props.maxCost > 0 ? Math.min(100, (props.usedCost / props.maxCost) * 100) : 0)

function barColor(pct: number) {
  if (pct >= 90) return 'var(--hc-error, #ef4444)'
  if (pct >= 70) return 'var(--hc-warning, #f59e0b)'
  return 'var(--hc-primary, #3b82f6)'
}

function formatTokens(n: number) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K'
  return String(n)
}

function formatDuration(s: number) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m > 0 ? `${m}m${sec}s` : `${sec}s`
}
</script>

<template>
  <div class="budget-panel">
    <div class="budget-panel__title">{{ t('chat.budget', 'Budget') }}</div>
    <div class="budget-panel__row">
      <Coins :size="12" />
      <span class="budget-panel__label">Tokens</span>
      <div class="budget-panel__bar">
        <div class="budget-panel__fill" :style="{ width: tokenPct + '%', background: barColor(tokenPct) }" />
      </div>
      <span class="budget-panel__value">{{ formatTokens(usedTokens) }}/{{ formatTokens(maxTokens) }}</span>
    </div>
    <div class="budget-panel__row">
      <Clock :size="12" />
      <span class="budget-panel__label">Time</span>
      <div class="budget-panel__bar">
        <div class="budget-panel__fill" :style="{ width: durationPct + '%', background: barColor(durationPct) }" />
      </div>
      <span class="budget-panel__value">{{ formatDuration(elapsedSeconds) }}/{{ maxDuration }}</span>
    </div>
    <div class="budget-panel__row">
      <DollarSign :size="12" />
      <span class="budget-panel__label">Cost</span>
      <div class="budget-panel__bar">
        <div class="budget-panel__fill" :style="{ width: costPct + '%', background: barColor(costPct) }" />
      </div>
      <span class="budget-panel__value">${{ usedCost.toFixed(2) }}/${{ maxCost.toFixed(2) }}</span>
    </div>
  </div>
</template>

<style scoped>
.budget-panel {
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12px;
  background: var(--hc-bg-secondary, #f8f9fa);
}
.budget-panel__title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
}
.budget-panel__row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.budget-panel__label {
  width: 42px;
  color: var(--hc-text-secondary);
}
.budget-panel__bar {
  flex: 1;
  height: 6px;
  background: var(--hc-bg-tertiary, #e5e7eb);
  border-radius: 3px;
  overflow: hidden;
}
.budget-panel__fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s, background 0.3s;
}
.budget-panel__value {
  width: 80px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-secondary);
}
</style>
