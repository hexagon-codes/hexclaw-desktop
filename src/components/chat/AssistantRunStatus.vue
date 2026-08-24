<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RuntimeEvent } from '@/types/chat'
import ThinkingProgress from './ThinkingProgress.vue'
import {
  deriveAssistantRunPresentation,
  type AssistantReasoningExecution,
  type AssistantReasoningRequest,
  type AssistantReasoningSupport,
  type AssistantRunPresentationLabels,
} from './assistant-run-presentation'

type ReasoningVisibility = 'visible' | 'not_exposed'

const props = withDefaults(
  defineProps<{
    reasoningRequest: AssistantReasoningRequest
    reasoningSupport: AssistantReasoningSupport
    reasoningExecution: AssistantReasoningExecution
    hasVisibleAnswer: boolean
    elapsedSeconds: number
    statusLabel?: string
    reasoning?: string
    visibility?: ReasoningVisibility
    runtimeEvents?: RuntimeEvent[]
    defaultOpen?: boolean
    contentRef?: (element: HTMLDivElement | null) => void
  }>(),
  {
    reasoning: '',
    statusLabel: undefined,
    visibility: 'not_exposed',
    runtimeEvents: () => [],
    defaultOpen: false,
    contentRef: undefined,
  },
)

const { t } = useI18n()

const labels = computed<AssistantRunPresentationLabels>(() => ({
  generating: t('chat.assistantRun.generating'),
  preparing: t('chat.assistantRun.preparing'),
  thinking: (duration) => t('chat.assistantRun.thinking', { duration }),
  thought: (duration) => t('chat.assistantRun.thought', { duration }),
  ignored: t('chat.assistantRun.ignored'),
  rejected: t('chat.assistantRun.rejected'),
  unsupported: t('chat.assistantRun.unsupported'),
}))

const presentation = computed(() =>
  deriveAssistantRunPresentation(
    {
      reasoningRequest: props.reasoningRequest,
      reasoningSupport: props.reasoningSupport,
      reasoningExecution: props.reasoningExecution,
      hasVisibleAnswer: props.hasVisibleAnswer,
      elapsedSeconds: props.elapsedSeconds,
    },
    labels.value,
  ),
)

const thinkingState = computed(() =>
  presentation.value.kind === 'thinking' ? 'running' : 'completed',
)
const usesThinkingProgress = computed(
  () => presentation.value.kind === 'thinking' || presentation.value.kind === 'thought',
)
</script>

<template>
  <ThinkingProgress
    v-if="usesThinkingProgress"
    :state="thinkingState"
    :elapsed-seconds="elapsedSeconds"
    :reasoning="reasoning"
    :visibility="visibility"
    :runtime-events="runtimeEvents"
    :default-open="defaultOpen"
    :content-ref="contentRef"
    :data-reasoning-request="reasoningRequest"
    :data-reasoning-support="reasoningSupport"
    :data-reasoning-execution="reasoningExecution"
  />
  <div
    v-else-if="presentation.kind !== 'hidden'"
    class="hc-assistant-run-status"
    :class="`hc-assistant-run-status--${presentation.kind}`"
    data-component="AssistantRunStatus"
    :data-run-kind="presentation.kind"
    :data-reasoning-request="reasoningRequest"
    :data-reasoning-support="reasoningSupport"
    :data-reasoning-execution="reasoningExecution"
    :role="
      presentation.kind === 'rejected' ||
      (presentation.kind === 'unsupported' && reasoningExecution === 'rejected')
        ? 'alert'
        : 'status'
    "
    :aria-live="
      presentation.kind === 'rejected' ||
      (presentation.kind === 'unsupported' && reasoningExecution === 'rejected')
        ? undefined
        : 'polite'
    "
    aria-atomic="true"
  >
    <span
      v-if="presentation.animated"
      class="hc-assistant-run-status__spinner"
      aria-hidden="true"
    />
    <span>{{ statusLabel || presentation.text }}</span>
  </div>
</template>

<style scoped>
.hc-assistant-run-status {
  display: inline-flex;
  max-width: 720px;
  align-items: center;
  gap: 7px;
  margin: 2px 0 8px;
  padding: 5px 0;
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.hc-assistant-run-status--unsupported,
.hc-assistant-run-status--rejected {
  color: var(--hc-danger, #c33f36);
}

.hc-assistant-run-status__spinner {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  border: 1.5px solid var(--hc-border);
  border-top-color: var(--hc-accent);
  border-radius: 50%;
  animation: hc-assistant-run-status-spin 0.75s linear infinite;
}

@keyframes hc-assistant-run-status-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .hc-assistant-run-status__spinner {
    animation: none;
  }
}
</style>
