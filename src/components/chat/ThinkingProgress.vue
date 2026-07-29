<script setup lang="ts">
import { computed, onBeforeUnmount, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RuntimeEvent } from '@/types/chat'
import { resolveToolDisplayName } from '@/utils/tool-call'
import ActivityTimeline from './ActivityTimeline.vue'
import type { ActivityTimelineItem } from './activity-timeline'
import ReasoningRenderer from './ReasoningRenderer.vue'
import { normalizeAssistantReasoning } from '@/utils/assistant-reply'

type ThinkingState = 'running' | 'completed' | 'failed' | 'cancelled'
type ReasoningVisibility = 'visible' | 'not_exposed'

const props = withDefaults(
  defineProps<{
    state: ThinkingState
    elapsedSeconds: number
    reasoning?: string
    visibility?: ReasoningVisibility
    defaultOpen?: boolean
    contentRef?: (element: HTMLDivElement | null) => void
    runtimeEvents?: RuntimeEvent[]
  }>(),
  {
    reasoning: '',
    visibility: 'not_exposed',
    defaultOpen: false,
    contentRef: undefined,
    runtimeEvents: () => [],
  },
)

const { t } = useI18n()

const normalizedElapsedSeconds = computed(() => {
  const seconds = Number(props.elapsedSeconds)
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0
})

const elapsedLabel = computed(() => {
  const seconds = normalizedElapsedSeconds.value
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
})

const publicReasoning = computed(() =>
  props.visibility === 'visible' ? normalizeAssistantReasoning(props.reasoning) : '',
)

function translateToolName(key: string, fallback?: string): string {
  const translated = t(key)
  return translated === key ? (fallback ?? key) : translated
}

const activityItems = computed<ActivityTimelineItem[]>(() => {
  const eventsByCall = new Map<string, RuntimeEvent>()
  const eventIDs = new Set<string>()
  const events = [...props.runtimeEvents].sort((left, right) => left.sequence - right.sequence)
  for (const event of events) {
    if (
      event.kind === 'terminal' ||
      !event.tool_call_id ||
      !event.tool_name ||
      eventIDs.has(event.event_id)
    ) {
      continue
    }
    eventIDs.add(event.event_id)
    eventsByCall.set(event.tool_call_id, event)
  }
  return [...eventsByCall.values()].map((event) => {
    const name = resolveToolDisplayName(event.tool_name ?? '', translateToolName)
    if (event.kind === 'tool_completed') {
      return {
        id: event.tool_call_id ?? event.event_id,
        state: 'completed',
        label: t('chat.toolActivity.completed', { name }),
      }
    }
    if (event.kind === 'tool_failed') {
      return {
        id: event.tool_call_id ?? event.event_id,
        state: 'failed',
        label: t('chat.toolActivity.failed', { name }),
      }
    }
    return {
      id: event.tool_call_id ?? event.event_id,
      state: 'running',
      label: t('chat.toolActivity.running', { name }),
    }
  })
})

const hasPublicDetails = computed(
  () => !!publicReasoning.value || activityItems.value.length > 0,
)

const terminalLabel = computed(() =>
  props.state === 'completed' ? t('chat.thoughtFor') : t('chat.thoughtProcess'),
)

function bindContentElement(element: Element | ComponentPublicInstance | null) {
  props.contentRef?.(element instanceof HTMLDivElement ? element : null)
}

onBeforeUnmount(() => props.contentRef?.(null))
</script>

<template>
  <div class="hc-thinking" :data-thinking-state="state">
    <template v-if="state === 'running'">
      <div class="hc-thinking__header">
        <span class="hc-thinking__activity hc-thinking__spinner" aria-hidden="true" />
        <span class="hc-thinking__label">{{ t('chat.thinking') }}</span>
        <span class="hc-thinking__elapsed">{{ elapsedLabel }}</span>
      </div>
      <div
        v-if="hasPublicDetails"
        :ref="bindContentElement"
        class="hc-thinking__content"
      >
        <ReasoningRenderer v-if="publicReasoning" :content="publicReasoning" />
        <ActivityTimeline :items="activityItems" />
      </div>
    </template>

    <details
      v-else-if="hasPublicDetails"
      class="hc-thinking__details"
      :open="defaultOpen || undefined"
    >
      <summary
        class="hc-thinking__summary"
        :aria-label="state === 'completed' ? t('chat.thoughtCompletedAria') : undefined"
      >
        <span class="hc-thinking__activity hc-thinking__icon ti" aria-hidden="true">
          <svg v-if="state === 'completed'" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="m8 12 2.5 2.5L16 9" />
          </svg>
          <template v-else>●</template>
        </span>
        <span class="hc-thinking__label">{{ terminalLabel }}</span>
        <span class="hc-thinking__elapsed">{{ elapsedLabel }}</span>
        <span class="cv" aria-hidden="true" />
      </summary>
      <div
        :ref="bindContentElement"
        class="hc-thinking__content"
      >
        <ReasoningRenderer v-if="publicReasoning" :content="publicReasoning" />
        <ActivityTimeline :items="activityItems" />
      </div>
    </details>
    <div v-else class="hc-thinking__summary hc-thinking__summary--static" role="status">
      <span class="hc-thinking__activity hc-thinking__icon ti" aria-hidden="true">
        <svg v-if="state === 'completed'" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 2.5 2.5L16 9" />
        </svg>
        <template v-else>●</template>
      </span>
      <span class="hc-thinking__label">{{ terminalLabel }}</span>
      <span class="hc-thinking__elapsed">{{ elapsedLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.hc-thinking {
  margin: 2px 0 8px;
  max-width: 720px;
}

.hc-thinking__header,
.hc-thinking__summary {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 0;
  color: var(--hc-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.hc-thinking__summary {
  cursor: pointer;
  list-style: none;
}

.hc-thinking__summary--static {
  cursor: default;
}

.hc-thinking__summary::-webkit-details-marker {
  display: none;
}

.hc-thinking__activity {
  display: inline-flex;
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  align-items: center;
  justify-content: center;
  color: var(--hc-text-muted);
}

.ti svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.cv {
  width: 10px;
  height: 10px;
  background: currentColor;
  opacity: 0.4;
  transition: transform 0.2s var(--hc-ease-out);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") center/contain no-repeat;
}

.hc-thinking__details[open] .cv {
  transform: rotate(180deg);
}

.hc-thinking__spinner {
  border: 1.5px solid var(--hc-border);
  border-top-color: var(--hc-accent);
  border-radius: 50%;
  animation: hc-thinking-spin 0.75s linear infinite;
}

.hc-thinking__elapsed {
  color: var(--hc-text-muted);
  font-variant-numeric: tabular-nums;
}

.hc-thinking__content {
  display: grid;
  gap: 8px;
  margin-left: 7px;
  padding: 6px 0 4px 16px;
  border-left: 1px solid var(--hc-border);
  color: var(--hc-text-secondary);
  font-size: 13px;
  line-height: 1.65;
}

@keyframes hc-thinking-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .hc-thinking__spinner {
    animation: none;
  }
}
</style>
