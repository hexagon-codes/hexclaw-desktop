<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatMessage, ToolCall } from '@/types/chat'
import type { RenderManifest } from '@/contracts/message-content'
import { splitProcessBlocks } from '@/utils/assistant-process'
import { toolCallStatus, resolveProcessToolName } from '@/utils/tool-call'
import AssistantRunStatus from './AssistantRunStatus.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import ToolCallCard from './ToolCallCard.vue'
import RetrievalActivityRow from './RetrievalActivityRow.vue'
import { deriveAssistantRunPresentation } from './assistant-run-presentation'
import './assistant-process.css'

const props = defineProps<{
  message: ChatMessage
  live?: boolean
  elapsedSeconds: number
  toolCalls?: ToolCall[]
}>()
const emit = defineEmits<{ rendered: [manifest: RenderManifest] }>()
const { t } = useI18n()
const expanded = ref(false)
const bodyID = useId()
const events = computed(() => props.message.metadata?.runtime_events ?? [])
const receipt = computed(() => props.message.metadata?.reasoning_receipt)
const visibleReasoning = computed(
  () =>
    props.message.metadata?.reasoning_visibility === 'visible' ||
    props.message.metadata?.reasoning_disclosure?.visibility === 'visible',
)
const terminal = computed(
  () =>
    [...events.value].reverse().find((event) => event.kind === 'terminal')?.terminal_status ??
    (props.live ? undefined : props.message.metadata?.thinking_state),
)
const calls = computed(() => {
  const source = props.toolCalls ?? props.message.tool_calls ?? []
  const out = source.map((call) => ({ ...call }))
  for (const event of events.value) {
    if (!event.tool_call_id || !event.tool_name) continue
    let call = out.find((item) => item.id === event.tool_call_id)
    if (!call) {
      call = { id: event.tool_call_id, name: event.tool_name, arguments: '' }
      out.push(call)
    }
    // 执行报告优先保留真实失败；事件仅补齐缺失的状态。
    if (toolCallStatus(call) === 'error') call.status = 'error'
    if (call.status !== 'error') {
      if (event.kind === 'tool_failed') call.status = 'error'
      else if (event.kind === 'tool_completed') call.status = 'success'
      else if (!call.status && call.result == null) call.status = 'running'
    }
  }
  return out
})
const ambiguousMCPNames = computed(() => {
  const servers = new Map<string, Set<string>>()
  for (const call of calls.value) {
    const origin = call.origin
    if (origin?.kind !== 'mcp' || !origin.server_name) continue
    if (!servers.has(origin.name)) servers.set(origin.name, new Set())
    servers.get(origin.name)!.add(origin.server_name)
  }
  return new Set([...servers].filter(([, names]) => names.size > 1).map(([name]) => name))
})
const steps = computed(() => {
  const ordered = splitProcessBlocks(props.message.blocks).process.filter(
    (block) => block.type !== 'thinking' || visibleReasoning.value,
  )
  const seen = new Set(
    ordered.filter((block) => block.type === 'tool_use').map((block) => block.id),
  )
  for (const call of calls.value)
    if (!seen.has(call.id))
      ordered.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
  // 旧消息仅有非空命中记录，不推断未记录的阶段顺序或空检索。
  if (!ordered.some((block) => block.type === 'retrieval')) {
    for (const kind of ['knowledge', 'memory'] as const) {
      const hits = props.message.metadata?.[`${kind}_hits`]
      if (Array.isArray(hits) && hits.length)
        ordered.push({
          type: 'retrieval',
          id: `legacy:${kind}`,
          retrieval: { kind, status: 'completed', [`${kind}_hits`]: hits },
        })
    }
  }
  // 仅过滤展示：成功零命中不占行，失败与持久回执保持完整。
  return ordered.filter(
    (block) =>
      block.type !== 'retrieval' ||
      block.retrieval.status !== 'completed' ||
      (block.retrieval.knowledge_hits?.length ?? 0) > 0 ||
      (block.retrieval.memory_hits?.length ?? 0) > 0 ||
      (block.retrieval.resident_hits?.length ?? 0) > 0,
  )
})
const fallbackReasoning = computed(() =>
  visibleReasoning.value && !steps.value.some((block) => block.type === 'thinking')
    ? props.message.reasoning
    : '',
)
const hasDetails = computed(() => !!(steps.value.length || fallbackReasoning.value))
const failed = computed(
  () =>
    terminal.value === 'failed' ||
    calls.value.some((call) => toolCallStatus(call) === 'error') ||
    steps.value.some((block) => block.type === 'retrieval' && block.retrieval.status === 'failed'),
)
const pending = computed(() => calls.value.filter((call) => toolCallStatus(call) === 'running'))
const unknown = computed(() => !props.live && pending.value.length > 0)
const runPresentation = computed(() =>
  deriveAssistantRunPresentation(
    {
      reasoningRequest: receipt.value?.reasoning_request ?? 'off',
      reasoningSupport: receipt.value?.reasoning_support ?? 'unknown',
      reasoningExecution: receipt.value?.reasoning_execution ?? 'unknown',
      hasVisibleAnswer: !!props.message.content.trim(),
      elapsedSeconds: props.elapsedSeconds,
    },
    {
      generating: t('chat.assistantRun.generating'),
      preparing: t('chat.assistantRun.preparing'),
      thinking: (duration) => t('chat.assistantRun.thinking', { duration }),
      thought: (duration) => t('chat.assistantRun.thought', { duration }),
      ignored: t('chat.assistantRun.ignored'),
      rejected: t('chat.assistantRun.rejected'),
      unsupported: t('chat.assistantRun.unsupported'),
    },
  ),
)
const label = computed(() => {
  if (terminal.value === 'cancelled') return 'Cancelled'
  if (failed.value && !props.live)
    return terminal.value === 'failed' ? 'Processing failed' : 'Completed with errors'
  if (unknown.value) return 'Outcome unknown'
  if (props.live && pending.value.length)
    return `Running ${resolveProcessToolName(pending.value[pending.value.length - 1]!, t, ambiguousMCPNames.value.has(pending.value[pending.value.length - 1]!.origin?.name ?? ''))}…`
  if (['ignored', 'rejected', 'unsupported'].includes(runPresentation.value.kind))
    return runPresentation.value.text
  if (props.live)
    return runPresentation.value.kind === 'thinking'
      ? runPresentation.value.text
      : t('chat.assistantRun.generating')
  return '处理过程'
})
const state = computed(() =>
  terminal.value === 'cancelled'
    ? 'cancelled'
    : props.live
      ? 'running'
      : failed.value
        ? 'failed'
        : unknown.value
          ? 'unknown'
          : 'completed',
)
// 总览负责折叠反馈；展开后的实际执行项承接动画，无运行子项时保留总览反馈。
const showSummaryMarker = computed(() =>
  state.value === 'running'
    ? !expanded.value || pending.value.length === 0
    : state.value !== 'completed',
)
function callFor(id: string, name: string, input: string): ToolCall {
  return calls.value.find((call) => call.id === id) ?? { id, name, arguments: input }
}
</script>

<template>
  <section
    v-if="hasDetails"
    class="hc-process"
    data-component="AssistantProcess"
    :data-state="state"
  >
    <button
      class="hc-process__toggle"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="bodyID"
      @click="expanded = !expanded"
    >
      <span v-if="showSummaryMarker" class="hc-process__marker" aria-hidden="true">
        <span v-if="state === 'running'" class="hc-process__spinner" />
        <span v-else>!</span>
      </span>
      <span>{{ label }}</span>
      <svg class="hc-process__chevron" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m6 3 5 5-5 5" />
      </svg>
    </button>
    <div :id="bodyID" class="hc-process__body" :hidden="!expanded">
      <div v-if="fallbackReasoning" class="hc-process__step hc-process__reasoning">
        <span class="hc-process-tool__meta">Summary</span>
        <MarkdownRenderer :content="fallbackReasoning" surface="desktop" />
      </div>
      <div
        v-for="(block, index) in steps"
        :key="block.type === 'tool_use' || block.type === 'retrieval' ? block.id : index"
        class="hc-process__step"
        :class="{ 'hc-process__reasoning': block.type === 'thinking' || block.type === 'text' }"
      >
        <RetrievalActivityRow
          v-if="block.type === 'retrieval'"
          :activity="block.retrieval"
          :historical="block.id.startsWith('legacy:')"
        />
        <ToolCallCard
          v-else-if="block.type === 'tool_use'"
          :call="callFor(block.id, block.name, block.input)"
          appearance="activity"
          :settled="!live"
          :show-server="
            ambiguousMCPNames.has(callFor(block.id, block.name, block.input).origin?.name ?? '')
          "
          @rendered="emit('rendered', $event)"
        />
        <MarkdownRenderer
          v-else-if="block.type === 'thinking'"
          :content="block.thinking"
          surface="desktop"
        />
        <MarkdownRenderer
          v-else-if="block.type === 'text'"
          :content="block.message_content ?? block.text"
          surface="desktop"
          @rendered="emit('rendered', $event)"
        />
      </div>
    </div>
  </section>
  <AssistantRunStatus
    v-else-if="live || receipt"
    :reasoning-request="receipt?.reasoning_request ?? 'off'"
    :reasoning-support="receipt?.reasoning_support ?? 'unknown'"
    :reasoning-execution="receipt?.reasoning_execution ?? 'unknown'"
    :has-visible-answer="!!message.content.trim()"
    :elapsed-seconds="elapsedSeconds"
  />
</template>
