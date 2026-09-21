<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wrench, CircleCheck, CircleX, LoaderCircle } from 'lucide-vue-next'
import type { ToolCall } from '@/types/chat'
import MarkdownRenderer from './MarkdownRenderer.vue'
import type { RenderManifest } from '@/contracts/message-content'
import {
  toolCallStatus,
  resolveToolDisplayName,
  resolveProcessToolName,
  summarizeToolResult,
  prettyToolJson,
  toolDurationLabel,
} from '@/utils/tool-call'

const props = defineProps<{
  call: ToolCall
  appearance?: 'activity'
  settled?: boolean
  showServer?: boolean
}>()
const emit = defineEmits<{ rendered: [manifest: RenderManifest] }>()
const { t } = useI18n()

const status = computed(() => toolCallStatus(props.call))
const outcome = computed(() =>
  props.settled && status.value === 'running' ? 'unknown' : status.value,
)
const displayName = computed(() =>
  props.appearance === 'activity'
    ? resolveProcessToolName(props.call, t, props.showServer)
    : resolveToolDisplayName(props.call.name, t),
)
const toolKind = computed(() => {
  const call = props.call
  if (call.origin?.kind === 'mcp') return 'MCP'
  if (call.execution || call.name === 'code_exec') return 'Sandbox'
  return call.origin?.kind === 'skill' ? 'Skill' : ''
})
const summary = computed(() => summarizeToolResult(props.call))
const durationLabel = computed(() => toolDurationLabel(props.call.duration_ms))
const prettyArgs = computed(() => prettyToolJson(props.call.arguments))
const prettyResult = computed(() => prettyToolJson(props.call.result))

const statusIcon = computed(() =>
  status.value === 'success' ? CircleCheck : status.value === 'error' ? CircleX : LoaderCircle,
)
/** 成功态图标已自明，不再叠文字徽标；运行/失败才给词。 */
const statusLabel = computed(() =>
  status.value === 'error'
    ? t('chat.toolFailed', '失败')
    : status.value === 'running'
      ? t('chat.toolRunning', '运行中')
      : '',
)
</script>

<template>
  <details v-if="appearance === 'activity'" class="hc-process-tool" :data-status="outcome">
    <summary>
      <span class="hc-process__marker" aria-hidden="true">
        <span v-if="outcome === 'running'" class="hc-process__spinner" />
        <span v-else-if="outcome === 'error' || outcome === 'unknown'">!</span>
        <svg v-else viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 2.5 2.5L16 9" />
        </svg>
      </span>
      <span class="hc-process-tool__name"
        ><span v-if="toolKind" class="hc-process-tool__kind">{{ toolKind }} · </span
        >{{ displayName }}</span
      >
      <span v-if="outcome === 'unknown'" class="hc-process-tool__meta">Outcome unknown</span>
      <span v-else-if="outcome === 'error'" class="hc-process-tool__meta">{{ statusLabel }}</span>
      <span class="hc-process-tool__meta hc-process-tool__duration">{{
        outcome === 'running' || outcome === 'unknown' ? '' : durationLabel
      }}</span>
    </summary>
    <div class="hc-process-tool__detail">
      <div class="hc-process-tool__meta">{{ call.name }}</div>
      <div v-if="call.origin?.kind === 'mcp'" class="hc-process-tool__meta">
        {{ [call.origin.server_name, call.origin.name].filter(Boolean).join(' · ') }}
      </div>
      <template v-if="call.arguments"
        ><div>{{ t('chat.toolParams') }}</div>
        <pre>{{ prettyArgs }}</pre>
      </template>
      <template v-if="call.execution">
        <div>{{ call.execution.language }} · Exit code: {{ call.execution.exit_code }}</div>
        <pre v-if="call.execution.command?.length">{{ call.execution.command.join(' ') }}</pre>
        <p v-if="call.execution.timeout">Execution timed out</p>
        <pre v-if="call.execution.error">{{ call.execution.error }}</pre>
        <ul v-if="call.execution.artifacts?.length">
          <li v-for="artifact in call.execution.artifacts" :key="artifact.id">
            {{ artifact.name }} · {{ artifact.size }} B
          </li>
        </ul>
      </template>
      <template v-if="call.result || call.message_content">
        <div>{{ t('chat.toolResult') }}</div>
        <MarkdownRenderer
          v-if="call.message_content"
          :content="call.message_content"
          surface="desktop"
          @rendered="emit('rendered', $event)"
        />
        <pre v-else>{{ prettyResult }}</pre>
      </template>
    </div>
  </details>
  <div v-else class="hc-tool" :class="`hc-tool--${status}`">
    <div class="hc-tool__head">
      <component
        :is="statusIcon"
        :size="13"
        class="hc-tool__status"
        :class="{ 'hc-tool__status--spin': status === 'running' }"
      />
      <Wrench :size="12" class="hc-tool__wrench" />
      <span class="hc-tool__name">{{ displayName }}</span>
      <span v-if="statusLabel" class="hc-tool__badge">{{ statusLabel }}</span>
      <span v-if="durationLabel" class="hc-tool__dur">{{ durationLabel }}</span>
    </div>
    <div v-if="summary" class="hc-tool__summary">{{ summary }}</div>
    <details v-if="call.arguments" class="hc-tool__detail">
      <summary>{{ t('chat.toolParams') }}</summary>
      <pre>{{ prettyArgs }}</pre>
    </details>
    <details v-if="call.result || call.message_content" class="hc-tool__detail">
      <summary>{{ t('chat.toolResult') }}</summary>
      <MarkdownRenderer
        v-if="call.message_content"
        class="hc-tool__result-markdown"
        :content="call.message_content"
        surface="desktop"
        @rendered="emit('rendered', $event)"
      />
      <pre v-else>{{ prettyResult }}</pre>
    </details>
  </div>
</template>

<style scoped>
.hc-tool {
  border-radius: 8px;
  border: 1px solid var(--hc-border-subtle, var(--hc-border));
  background: var(--hc-bg-sidebar);
  overflow: hidden;
}

.hc-tool__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-secondary);
}

.hc-tool__status {
  flex-shrink: 0;
}
.hc-tool--success .hc-tool__status {
  color: var(--hc-success, #2f9e44);
}
.hc-tool--error .hc-tool__status {
  color: var(--hc-danger, #e03131);
}
.hc-tool--running .hc-tool__status {
  color: var(--hc-accent);
}
.hc-tool__status--spin {
  animation: hc-tool-spin 0.9s linear infinite;
}
@keyframes hc-tool-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .hc-tool__status--spin {
    animation: none;
  }
}

.hc-tool__wrench {
  flex-shrink: 0;
  color: var(--hc-text-tertiary, var(--hc-text-secondary));
}

.hc-tool__name {
  color: var(--hc-accent);
}

.hc-tool__badge {
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 16px;
}
.hc-tool--error .hc-tool__badge {
  color: var(--hc-danger, #e03131);
  background: var(--hc-danger-soft, rgba(224, 49, 49, 0.1));
}
.hc-tool--running .hc-tool__badge {
  color: var(--hc-accent);
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
}

.hc-tool__dur {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--hc-text-tertiary, var(--hc-text-secondary));
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

/* 卡面一行摘要：不展开即可读，灰一档与正文区隔 */
.hc-tool__summary {
  padding: 0 10px 7px 28px;
  margin-top: -2px;
  font-size: 11.5px;
  font-weight: 400;
  line-height: 1.45;
  color: var(--hc-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-tool__detail {
  border-top: 1px solid var(--hc-border-subtle, var(--hc-border));
}
.hc-tool__detail > summary {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--hc-text-muted, var(--hc-text-tertiary, var(--hc-text-secondary)));
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.hc-tool__detail > summary::-webkit-details-marker {
  display: none;
}
.hc-tool__detail > pre {
  margin: 0;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--hc-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  max-height: 200px;
  overflow-y: auto;
}

.hc-tool__result-markdown {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--hc-text-secondary);
  max-height: 240px;
  overflow-y: auto;
}
</style>
