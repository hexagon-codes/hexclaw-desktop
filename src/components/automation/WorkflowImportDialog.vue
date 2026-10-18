<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Loader2, Upload } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import HcModal from '@/components/common/HcModal.vue'
import {
  importWorkflowDefinition,
  previewWorkflowImport,
  type WorkflowImportFormat,
  type WorkflowImportPreview,
  type WorkflowTransferIssue,
} from '@/api/workflow-transfer'
import type { Workflow } from '@/types'
import { workflowErrorText, workflowIssueText } from '@/utils/workflow-errors'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; imported: [workflow: Workflow] }>()
const { t } = useI18n()
const inputId = `workflow-import-${useId()}`
const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const preview = ref<WorkflowImportPreview | null>(null)
const checking = ref(false)
const submitting = ref(false)
const error = ref<unknown>(null)
const errorText = computed(() => error.value ? workflowErrorText(error.value) : '')
let requestTicket = 0
let previewController: AbortController | null = null

const errors = computed(() => preview.value?.issues.filter(issue => issue.severity === 'error') ?? [])
const warnings = computed(() => preview.value?.issues.filter(issue => issue.severity === 'warning') ?? [])
const canImport = computed(() => Boolean(file.value && preview.value?.can_import
  && preview.value.workflow && !checking.value && !submitting.value && errors.value.length === 0))
const formatKey: Record<WorkflowImportFormat, string> = {
  'hexclaw-json': 'workflow.transfer.formatHexclaw',
  'coze-yaml': 'workflow.transfer.formatCozeYaml',
  'coze-zip': 'workflow.transfer.formatCozeZip',
  unknown: 'workflow.transfer.formatUnknown',
}
const format = computed(() => t(formatKey[preview.value?.format ?? 'unknown'] ?? formatKey.unknown))

function invalidatePreview() {
  requestTicket += 1
  previewController?.abort()
  previewController = null
  checking.value = false
}

function reset() {
  invalidatePreview()
  file.value = null
  preview.value = null
  error.value = ''
  if (fileInput.value) fileInput.value.value = ''
}

watch(() => props.open, open => {
  if (open) reset()
  else invalidatePreview()
}, { immediate: true })
onBeforeUnmount(invalidatePreview)

function close() {
  if (submitting.value) return
  invalidatePreview()
  emit('close')
}

async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement
  const selected = input.files?.[0]
  input.value = ''
  if (!selected || submitting.value) return
  invalidatePreview()
  const ticket = requestTicket
  const controller = new AbortController()
  previewController = controller
  file.value = selected
  preview.value = null
  error.value = ''
  checking.value = true
  try {
    const result = await previewWorkflowImport(selected, controller.signal)
    if (ticket !== requestTicket || !props.open) return
    preview.value = result
  } catch (failure) {
    if (ticket !== requestTicket || !props.open || controller.signal.aborted) return
    error.value = failure
  } finally {
    if (ticket === requestTicket) {
      checking.value = false
      previewController = null
    }
  }
}

async function confirmImport() {
  if (!canImport.value || !file.value) return
  const selected = file.value
  const ticket = ++requestTicket
  submitting.value = true
  error.value = ''
  try {
    const result = await importWorkflowDefinition(selected)
    if (ticket !== requestTicket || !props.open) return
    preview.value = result
    if (!result.can_import || !result.workflow || result.issues.some(issue => issue.severity === 'error')) {
      if (!result.issues.length) error.value = { code: 'WORKFLOW_IMPORT_INVALID_RESPONSE', message: 'The import response is missing a workflow definition' }
      return
    }
    emit('imported', result.workflow)
    emit('close')
  } catch (failure) {
    if (ticket !== requestTicket || !props.open) return
    error.value = failure
  } finally {
    submitting.value = false
  }
}

function issueLocation(issue: WorkflowTransferIssue): string {
  return [issue.node_id ? t('workflow.transfer.node', { id: issue.node_id }) : '', issue.path]
    .filter(Boolean).join(' · ')
}
</script>

<template>
  <HcModal
    :open="open"
    :title="t('workflow.transfer.importTitle')"
    :width="600"
    :busy="submitting"
    initial-focus="[data-workflow-choose-file]"
    @close="close"
  >
    <div class="wfi-content">
      <p class="wfi-note">{{ t('workflow.transfer.description') }}</p>
      <p class="wfi-note">{{ t('workflow.transfer.cozeCompatibility') }}</p>
      <div class="wfi-picker">
        <input
          :id="inputId"
          ref="fileInput"
          type="file"
          accept=".json,.yaml,.yml,.zip,application/json,application/zip"
          hidden
          :disabled="submitting"
          @change="selectFile"
        >
        <button
          type="button"
          class="hc-btn"
          data-workflow-choose-file
          :disabled="submitting"
          :aria-controls="inputId"
          @click="fileInput?.click()"
        >
          <Upload :size="16" aria-hidden="true" />
          {{ t(file ? 'workflow.transfer.changeFile' : 'workflow.transfer.chooseFile') }}
        </button>
        <span class="wfi-file">{{ file?.name || t('workflow.transfer.noFile') }}</span>
      </div>

      <p v-if="checking" class="wfi-status" role="status">
        <Loader2 :size="16" class="wfi-spin" aria-hidden="true" />
        {{ t('workflow.transfer.checking') }}
      </p>
      <p v-if="errorText" class="wfi-error" role="alert">{{ errorText }}</p>

      <template v-if="preview">
        <dl class="wfi-summary">
          <div><dt>{{ t('workflow.transfer.format') }}</dt><dd>{{ format }}</dd></div>
          <div><dt>{{ t('workflow.transfer.version') }}</dt><dd>{{ preview.schema_version || '—' }}</dd></div>
          <div><dt>{{ t('workflow.transfer.workflowName') }}</dt><dd>{{ preview.workflow?.name || '—' }}</dd></div>
          <div>
            <dt>{{ t('workflow.transfer.stepCount') }}</dt>
            <dd>{{ preview.workflow ? preview.workflow.nodes.length : '—' }}</dd>
          </div>
        </dl>

        <section v-if="errors.length" class="wfi-issues wfi-issues--errors" role="alert">
          <h3>{{ t('workflow.transfer.errors') }}</h3>
          <ul>
            <li v-for="(issue, index) in errors" :key="`${issue.code}-${index}`">
              <p>{{ workflowIssueText(issue) }}</p>
              <small v-if="issueLocation(issue)">{{ issueLocation(issue) }}</small>
            </li>
          </ul>
        </section>
        <section v-if="warnings.length" class="wfi-issues" role="status">
          <h3>{{ t('workflow.transfer.warnings') }}</h3>
          <ul>
            <li v-for="(issue, index) in warnings" :key="`${issue.code}-${index}`">
              <p>{{ workflowIssueText(issue) }}</p>
              <small v-if="issueLocation(issue)">{{ issueLocation(issue) }}</small>
            </li>
          </ul>
        </section>
        <p v-if="canImport" class="wfi-ready" role="status">{{ t('workflow.transfer.ready') }}</p>
      </template>
      <p class="wfi-note">{{ t('workflow.transfer.definitionOnly') }}</p>
    </div>
    <template #footer>
      <button type="button" class="hc-btn" :disabled="submitting" @click="close">
        {{ t('common.cancel') }}
      </button>
      <button type="button" class="hc-btn hc-btn-primary" :disabled="!canImport" @click="confirmImport">
        <Loader2 v-if="submitting" :size="16" class="wfi-spin" aria-hidden="true" />
        {{ t(submitting ? 'workflow.transfer.creating' : 'workflow.transfer.createCopy') }}
      </button>
    </template>
  </HcModal>
</template>

<style scoped>
.wfi-content{display:flex;flex-direction:column;gap:14px;min-width:0}
.wfi-note,.wfi-status,.wfi-error,.wfi-ready{margin:0;font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.wfi-note,.wfi-status{color:var(--hc-text-secondary)}
.wfi-picker{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-width:0}
.wfi-picker .hc-btn{display:inline-flex;align-items:center;gap:6px}
.wfi-file{min-width:0;overflow-wrap:anywhere;font-size:13px;color:var(--hc-text-primary)}
.wfi-status{display:flex;align-items:center;gap:8px}
.wfi-error,.wfi-issues--errors h3{color:var(--hc-error)}
.wfi-ready{color:var(--hc-text-secondary)}
.wfi-summary{display:flex;flex-direction:column;gap:8px;margin:0;padding:14px;border:1px solid var(--hc-border);border-radius:10px;background:var(--hc-bg-secondary)}
.wfi-summary>div{display:grid;grid-template-columns:94px minmax(0,1fr);gap:12px;font-size:13px;line-height:1.6}
.wfi-summary dt{color:var(--hc-text-secondary)}
.wfi-summary dd{margin:0;overflow-wrap:anywhere;color:var(--hc-text-primary)}
.wfi-issues h3{margin:0 0 8px;font-size:13px;font-weight:600;line-height:1.6}
.wfi-issues ul{display:flex;flex-direction:column;gap:8px;margin:0;padding-left:18px;color:var(--hc-text-secondary)}
.wfi-issues p{margin:0;font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.wfi-issues small{font-size:12px;line-height:1.6;overflow-wrap:anywhere;color:var(--hc-text-muted)}
.wfi-spin{flex:none;animation:wfi-spin 1s linear infinite}
@keyframes wfi-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.wfi-spin{animation:none}}
</style>
