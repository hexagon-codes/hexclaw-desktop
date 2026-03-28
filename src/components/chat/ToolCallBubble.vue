<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wrench, Loader2, CheckCircle, XCircle } from 'lucide-vue-next'

const { t } = useI18n()

interface Props {
  name: string
  arguments?: string
  result?: string
  status?: 'running' | 'success' | 'error'
  progress?: string // streaming stdout
}

const props = withDefaults(defineProps<Props>(), {
  status: 'success',
})

const statusIcon = computed(() => {
  switch (props.status) {
    case 'running': return Loader2
    case 'error': return XCircle
    default: return CheckCircle
  }
})

const statusColor = computed(() => {
  switch (props.status) {
    case 'running': return 'var(--hc-primary, #3b82f6)'
    case 'error': return 'var(--hc-error, #ef4444)'
    default: return 'var(--hc-success, #22c55e)'
  }
})
</script>

<template>
  <div class="tool-bubble" :class="`tool-bubble--${status}`">
    <div class="tool-bubble__header">
      <Wrench :size="14" />
      <span class="tool-bubble__name">{{ name }}</span>
      <component :is="statusIcon" :size="14" :style="{ color: statusColor }" :class="{ 'tool-bubble__spin': status === 'running' }" />
    </div>
    <details v-if="arguments" class="tool-bubble__section">
      <summary>{{ t('chat.toolParams', 'Parameters') }}</summary>
      <pre>{{ arguments }}</pre>
    </details>
    <div v-if="progress && status === 'running'" class="tool-bubble__progress">
      <pre>{{ progress }}</pre>
    </div>
    <details v-if="result" class="tool-bubble__section">
      <summary>{{ t('chat.toolResult', 'Result') }}</summary>
      <pre>{{ result }}</pre>
    </details>
  </div>
</template>

<style scoped>
.tool-bubble {
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  padding: 8px 12px;
  margin: 4px 0;
  font-size: 13px;
  background: var(--hc-bg-secondary, #f8f9fa);
}
.tool-bubble__header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tool-bubble__name {
  font-weight: 600;
  font-family: 'SF Mono', monospace;
  flex: 1;
}
.tool-bubble__spin {
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.tool-bubble__section {
  margin-top: 6px;
}
.tool-bubble__section summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.tool-bubble__section pre,
.tool-bubble__progress pre {
  font-size: 11px;
  max-height: 150px;
  overflow-y: auto;
  background: var(--hc-bg-tertiary, #eee);
  padding: 6px 8px;
  border-radius: 6px;
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-all;
}
.tool-bubble__progress pre {
  border-left: 3px solid var(--hc-primary, #3b82f6);
}
</style>
