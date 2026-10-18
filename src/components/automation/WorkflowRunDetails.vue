<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, Loader2, XCircle, AlertTriangle } from 'lucide-vue-next'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import type { WorkflowNodeRun, WorkflowRun } from '@/types'
import { workflowErrorText } from '@/utils/workflow-errors'
import { downloadInApp } from '@/utils/download'
import { useToast } from '@/composables'

const props = defineProps<{
  status: string
  runId: string | null
  input?: string
  resourceSnapshots?: WorkflowRun['resource_snapshots']
  deliveryBusy?: string
  outputFileBusy?: string
  result: {
    output?: string
    error?: string
    startedAt?: string
    finishedAt?: string
    nodeResults?: WorkflowNodeRun[]
    messageContent?: WorkflowRun['message_content']
    deliveries?: WorkflowRun['deliveries']
    generatedFiles?: WorkflowRun['generated_files']
  }
}>()
defineEmits<{ 'retry-delivery': [id: string]; 'retry-file': [id: string] }>()
const { t, locale } = useI18n()
const toast = useToast()
async function downloadFile(file: NonNullable<WorkflowRun['generated_files']>[number]) {
  if (!file.download_url) return
  try { await downloadInApp(file.download_url, file.name) }
  catch (error) { toast.error(workflowErrorText(error)) }
}
const running = computed(() => props.status === 'pending' || props.status === 'running')
const headIcon = computed(() => running.value ? Loader2 : props.status === 'completed' ? CheckCircle2 : props.status === 'unavailable' ? AlertTriangle : XCircle)
function statusText(value: string) { return t(`workflow.statusLabels.${value}`, value) }
function displayTime(value?: string) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale.value) : '—'
}
function duration(start?: string, finish?: string) {
  if (!start || !finish || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(finish))) return '—'
  return `${Math.max(0, (Date.parse(finish) - Date.parse(start)) / 1000).toFixed(1)}s`
}
</script>

<template>
  <section class="workflow-result" :class="{ 'workflow-result--failed': status === 'failed' }">
    <header class="workflow-result__head">
      <component :is="headIcon" :size="16" :class="{ 'workflow-result__spin': running }" />
      <strong>{{ statusText(status) }}</strong>
      <span>{{ duration(result.startedAt, result.finishedAt) }}</span>
    </header>
    <div class="workflow-result__content">
      <MarkdownRenderer v-if="result.messageContent || result.output" :content="result.messageContent || result.output || ''" surface="history" />
      <p v-else-if="status === 'completed'" class="workflow-result__note">{{ t('workflow.noOutput') }}</p>
      <p v-if="result.error" role="alert" class="workflow-result__error">{{ workflowErrorText(result.error) }}</p>
      <p v-if="status === 'outcome_unknown'" class="workflow-result__note">{{ t('workflow.inspectionRequired') }}</p>
    </div>
    <div v-if="result.generatedFiles?.length" class="workflow-result__deliveries">
      <strong>{{ t('workflow.outputs.generatedFiles') }}</strong>
      <div v-for="file in result.generatedFiles" :key="file.id" class="workflow-result__node">
        <div class="workflow-result__delivery-head"><span class="workflow-result__filename">{{ file.name }}</span><span>{{ t('workflow.outputs.generationStates.' + file.status) }}</span><button v-if="file.status === 'ready' && file.download_url" type="button" class="hc-resource-action" @click="downloadFile(file)">{{ t('workflow.outputs.download') }}</button><button v-if="file.status === 'failed'" type="button" class="hc-resource-action" :disabled="!!outputFileBusy" @click="$emit('retry-file', file.id)"><Loader2 v-if="outputFileBusy === file.id" :size="14" class="workflow-result__spin" />{{ t('workflow.outputs.retry') }}</button></div>
        <p v-if="file.error" class="workflow-result__error" role="alert">{{ workflowErrorText(file.error, file.error_code) }}</p>
      </div>
    </div>
    <div v-if="result.deliveries?.length" class="workflow-result__deliveries">
      <strong>{{ t('workflow.delivery.title') }}</strong>
      <div v-for="delivery in result.deliveries" :key="delivery.id" class="workflow-result__node">
        <div class="workflow-result__delivery-head"><span>{{ t('workflow.delivery.' + delivery.kind) }}</span><span>{{ t(delivery.kind === 'email' && delivery.status === 'accepted' ? 'workflow.delivery.emailAccepted' : 'workflow.delivery.status.' + delivery.status, delivery.status) }}</span><button v-if="delivery.status === 'failed' || delivery.kind === 'dingtalk' && ['accepted', 'outcome_unknown'].includes(delivery.status)" type="button" class="hc-resource-action" :disabled="!!deliveryBusy" @click="$emit('retry-delivery', delivery.id)"><Loader2 v-if="deliveryBusy === delivery.id" :size="14" class="workflow-result__spin" />{{ t(delivery.status === 'failed' ? 'workflow.delivery.retry' : 'workflow.delivery.query') }}</button></div>
        <p v-if="delivery.error" class="workflow-result__error" role="alert">{{ workflowErrorText(delivery.error, delivery.error_code) }}</p>
        <p v-if="delivery.status === 'failed'" class="workflow-result__note">{{ t('workflow.delivery.retryNote') }}</p>
      </div>
    </div>
    <details class="workflow-result__receipts">
      <summary>{{ t('workflow.runReceipts') }}</summary>
      <p v-if="runId" class="workflow-result__note workflow-result__id">{{ runId }}</p>
      <p class="workflow-result__note">{{ displayTime(result.startedAt) }}</p>
      <div v-if="input !== undefined" class="workflow-result__node">
        <strong>{{ t('workflow.runInputValue') }}</strong>
        <pre>{{ input }}</pre>
      </div>
      <details v-if="resourceSnapshots" class="workflow-result__node"><summary>{{ t('workflow.effectiveResources') }}</summary><pre>{{ JSON.stringify(resourceSnapshots, null, 2) }}</pre></details>
      <details v-for="node in result.nodeResults" :key="node.node_id" class="workflow-result__node">
        <summary>{{ node.label || node.node_id }} · {{ statusText(node.status) }}</summary>
        <p class="workflow-result__note">{{ duration(node.started_at, node.finished_at) }} · {{ node.provider_display_name || '—' }} {{ node.model_id || '' }}</p>
        <pre v-if="node.output">{{ node.output }}</pre>
        <p v-if="node.error" role="alert" class="workflow-result__error">{{ workflowErrorText(node.error) }}</p>
        <details v-if="node.resource_receipts" class="workflow-result__node"><summary>{{ t('workflow.actualResources') }}</summary><pre>{{ JSON.stringify(node.resource_receipts, null, 2) }}</pre></details>
        <div v-for="(branch, index) in node.branches" :key="index" class="workflow-result__branch">
          <strong>{{ branch.agent }} · {{ statusText(branch.status) }}</strong>
          <p v-if="branch.task">{{ branch.task }}</p>
          <p v-if="branch.provider_display_name || branch.model_id" class="workflow-result__note">{{ branch.provider_display_name }} {{ branch.model_id }}</p>
          <pre v-if="branch.output">{{ branch.output }}</pre>
          <p v-if="branch.error" role="alert" class="workflow-result__error">{{ workflowErrorText(branch.error) }}</p>
        </div>
      </details>
    </details>
  </section>
</template>

<style scoped>
.workflow-result { width: 100%; min-width: 0; color: var(--hc-text-primary); }
.workflow-result__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.workflow-result__head > span { color: var(--hc-text-muted); font-size: 12px; }
.workflow-result__content { margin-top: 12px; min-width: 0; overflow-wrap: anywhere; }
.workflow-result__receipts { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--hc-border); }
.workflow-result__deliveries { margin-top: 16px; font-size: 13px; }
.workflow-result__delivery-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.workflow-result__delivery-head > span:nth-child(2) { color: var(--hc-text-secondary); }
.workflow-result__filename { min-width: 0; overflow-wrap: anywhere; }
.workflow-result summary { cursor: pointer; font-size: 13px; overflow-wrap: anywhere; }
.workflow-result__node { margin-top: 12px; padding: 10px 0; border-top: 1px solid var(--hc-border); font-size: 13px; }
.workflow-result__branch { margin-top: 10px; padding-inline-start: 12px; border-inline-start: 1px solid var(--hc-border); }
.workflow-result pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; font-family: inherit; font-size: 12px; line-height: 1.6; }
.workflow-result__note { margin: 8px 0 0; color: var(--hc-text-muted); font-size: 12px; overflow-wrap: anywhere; }
.workflow-result__id { font-family: ui-monospace, SFMono-Regular, monospace; }
.workflow-result__error { margin: 8px 0 0; font-size: 13px; color: var(--hc-error); overflow-wrap: anywhere; }
.workflow-result--failed .workflow-result__head { color: var(--hc-error); }
.workflow-result__spin { animation: workflow-result-spin 0.8s linear infinite; }
@keyframes workflow-result-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .workflow-result__spin { animation: none; } }
</style>
