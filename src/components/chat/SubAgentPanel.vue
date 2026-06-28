<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Users, Check, X, Clock } from 'lucide-vue-next'
import type { SubAgentReport } from '@/utils/subagents'

const props = defineProps<{ reports: SubAgentReport[] }>()
const { t } = useI18n()

const hasIssue = computed(() => props.reports.some((r) => r.status !== 'ok'))

/** 折叠时的一行状态摘要：「researcher ✓ · coder ✓ · analyst ⏱」。 */
function statusGlyph(status: SubAgentReport['status']): string {
  switch (status) {
    case 'ok':
      return '✓'
    case 'timeout':
      return '⏱'
    default:
      return '✗'
  }
}

const summaryLine = computed(() =>
  props.reports.map((r) => `${r.agent} ${statusGlyph(r.status)}`).join(' · '),
)

function statusLabel(status: SubAgentReport['status']): string {
  return t(`chat.subAgent.status.${status}`, status)
}
</script>

<template>
  <div class="hc-subagent">
    <details class="hc-subagent__details">
      <summary class="hc-subagent__summary">
        <Users :size="14" class="hc-subagent__head-icon" />
        <span class="hc-subagent__label">
          {{ t('chat.subAgent.title', '子 Agent 协作') }}
          <span class="hc-subagent__count">({{ reports.length }})</span>
        </span>
        <span class="hc-subagent__digest" :class="{ 'hc-subagent__digest--warn': hasIssue }">
          {{ summaryLine }}
        </span>
      </summary>
      <div class="hc-subagent__body">
        <div
          v-for="(r, i) in reports"
          :key="`${r.agent}-${i}`"
          class="hc-subagent__row"
          :class="`hc-subagent__row--${r.status}`"
        >
          <div class="hc-subagent__row-head">
            <Check v-if="r.status === 'ok'" :size="13" class="hc-subagent__status hc-subagent__status--ok" />
            <Clock v-else-if="r.status === 'timeout'" :size="13" class="hc-subagent__status hc-subagent__status--timeout" />
            <X v-else :size="13" class="hc-subagent__status hc-subagent__status--error" />
            <span class="hc-subagent__agent">{{ r.agent }}</span>
            <span class="hc-subagent__status-text">{{ statusLabel(r.status) }}</span>
            <span v-if="r.duration" class="hc-subagent__duration">{{ r.duration }}</span>
          </div>
          <pre v-if="r.output" class="hc-subagent__output">{{ r.output }}</pre>
          <div v-if="r.error" class="hc-subagent__error">{{ r.error }}</div>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.hc-subagent {
  margin: 4px 0 8px;
}

.hc-subagent__details {
  border: 1px solid var(--hc-border, rgba(0, 0, 0, 0.08));
  border-radius: 10px;
  background: var(--hc-surface-2, rgba(0, 0, 0, 0.02));
  overflow: hidden;
}

.hc-subagent__summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  user-select: none;
  list-style: none;
}

.hc-subagent__summary::-webkit-details-marker {
  display: none;
}

.hc-subagent__summary::after {
  content: '';
  width: 9px;
  height: 9px;
  margin-left: auto;
  flex-shrink: 0;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.15s ease;
  opacity: 0.5;
}

.hc-subagent__details[open] .hc-subagent__summary::after {
  transform: rotate(45deg);
}

.hc-subagent__head-icon {
  color: var(--hc-accent);
  flex-shrink: 0;
}

.hc-subagent__label {
  flex-shrink: 0;
}

.hc-subagent__count {
  color: var(--hc-text-tertiary, var(--hc-text-secondary));
  font-weight: 400;
}

.hc-subagent__digest {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 400;
  color: var(--hc-text-tertiary, var(--hc-text-secondary));
}

.hc-subagent__digest--warn {
  color: var(--hc-warning, #c2731a);
}

.hc-subagent__body {
  padding: 4px 12px 10px;
  border-top: 1px solid var(--hc-border, rgba(0, 0, 0, 0.06));
}

.hc-subagent__row {
  padding: 8px 0;
}

.hc-subagent__row + .hc-subagent__row {
  border-top: 1px dashed var(--hc-border, rgba(0, 0, 0, 0.06));
}

.hc-subagent__row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

.hc-subagent__status {
  flex-shrink: 0;
}
.hc-subagent__status--ok {
  color: var(--hc-success, #2f9e44);
}
.hc-subagent__status--timeout {
  color: var(--hc-warning, #c2731a);
}
.hc-subagent__status--error {
  color: var(--hc-danger, #e03131);
}

.hc-subagent__agent {
  font-weight: 600;
  color: var(--hc-text);
}

.hc-subagent__status-text {
  color: var(--hc-text-secondary);
  font-size: 11.5px;
}

.hc-subagent__duration {
  margin-left: auto;
  color: var(--hc-text-tertiary, var(--hc-text-secondary));
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.hc-subagent__output {
  margin: 6px 0 0;
  padding: 8px 10px;
  max-height: 220px;
  overflow: auto;
  background: var(--hc-surface, rgba(0, 0, 0, 0.03));
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--hc-text);
}

.hc-subagent__error {
  margin-top: 6px;
  padding: 6px 10px;
  background: var(--hc-danger-soft, rgba(224, 49, 49, 0.08));
  border-radius: 6px;
  font-size: 12px;
  color: var(--hc-danger, #e03131);
}
</style>
