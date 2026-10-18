<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Plus, Download, Workflow as WorkflowIcon, History, Brain, Wrench, GitBranch, Layers, Send, Zap, Pencil, Trash2, ArrowUp, ArrowDown, GripVertical, Play, RotateCcw, Save, X, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-vue-next'
import { getWebhooks, type Webhook } from '@/api/webhook'
import ModelSelector from '@/components/common/ModelSelector.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import DetailDrawer from '@/components/common/DetailDrawer.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { getSkills } from '@/api/skills'
import { getPrompts } from '@/api/prompts'
import { getDocuments } from '@/api/knowledge'
import WorkflowRunDetails from '@/components/automation/WorkflowRunDetails.vue'
import WorkflowImportDialog from '@/components/automation/WorkflowImportDialog.vue'
import { downloadWorkflowDefinition } from '@/api/workflow-transfer'
import CronScheduleField from '@/components/cron/CronScheduleField.vue'
import UnderlineTabs from '@/components/common/UnderlineTabs.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import { useCanvasStore } from '@/stores/canvas'
import { useToast } from '@/composables'
import type { CanvasNode, Workflow, WorkflowRun, WorkflowStepSettings, WorkflowResourceKey } from '@/types'
import { preflightAutonomy, createAutonomyGrant, getAutonomySummary, type PreflightResult } from '@/api/autonomy'
import PermissionApprovalModal from '@/components/automation/PermissionApprovalModal.vue'
import { bindWorkflowTrigger, getWorkflowTriggers, removeWorkflowTrigger, getWorkflowDeliveryTargets, type WorkflowDeliveryTargets, type WorkflowTriggerBinding } from '@/api/canvas'
import { useAgentsStore } from '@/stores/agents'
import { getMcpTools, type McpTool } from '@/api/mcp'
import { INPUT_LIMITS, inputLimitError } from '@/utils/input-limits'
import { backendContext } from '@/services/backend-context'
import { CRON_SCHEDULE_PRESETS, parseCronSchedule } from '@/utils/cron-schedule'
import { workflowErrorText, workflowIssueText } from '@/utils/workflow-errors'
import { listWorkflowDirectories, pickWorkflowDirectory, type WorkflowDirectoryRef } from '@/api/workflow-directories'

const { t, locale } = useI18n()
const toast = useToast()
const store = useCanvasStore()
const route = useRoute()
const router = useRouter()
const ready = ref(false)
type WorkflowPage = 'list' | 'editor' | 'history'
const page = computed<WorkflowPage>(() => route.path.endsWith('/history') ? 'history' : route.path.endsWith('/editor') ? 'editor' : 'list')
const pageTabs = computed(() => [
  { key: 'list', label: t('workflow.listPage', '工作流列表'), count: store.workflowCount },
  { key: 'editor', label: t('workflow.editorPage', '工作流编排') },
  { key: 'history', label: t('workflow.historyPage', '运行记录'), count: store.runHistoryCount },
])
function goPage(value: string) {
  const target = value as WorkflowPage
  void router.push({ path: `/automation/workflows${target === 'list' ? '' : '/' + target}`, query: target === 'editor' && store.currentWorkflowId ? { workflow_id: store.currentWorkflowId } : {} })
}
const selectedRun = computed(() => store.runHistory.find((run) => run.id === store.lastRunId))
const showRunDetails = computed(() => !!store.runResult && (page.value === 'editor'
  ? selectedRun.value?.workflow_id === store.currentWorkflowId || !store.lastRunId
  : page.value === 'history' && route.query.run_id === store.lastRunId))
const canResume = computed(() => selectedRun.value?.retry_safe === true && ['failed', 'cancelled', 'interrupted'].includes(store.runStatus))
function workflowName(run: WorkflowRun) {
  return store.savedWorkflows.find((workflow) => workflow.id === run.workflow_id)?.name || run.definition?.name || run.workflow_id
}
const filteredRuns = computed(() => {
  const q = props.search.trim().toLowerCase()
  return store.runHistory.filter((run) => !q || `${workflowName(run)} ${run.id} ${run.status}`.toLowerCase().includes(q))
})
const operationError = computed(() => store.error !== store.workflowLoadError && store.error !== store.runHistoryLoadError ? store.error : null)
const runsErrorTitle = computed(() => t(store.runHistoryLoadError?.status === 404 ? 'workflow.runsUnsupported' : 'workflow.runsLoadFailed'))
const outputMappingDescription = computed(() => t('workflow.outputMappingNote', { variable: '{{value}}' }))
const runInputDescription = computed(() => t('workflow.runInputDescription', { variable: '{{input}}' }))
type PanelMode = 'step' | 'run' | 'automation'
const panelMode = ref<PanelMode | null>(null)
const panelElement = ref<HTMLElement | null>(null)
let panelInvoker: HTMLElement | null = null
const panelTitle = computed(() => t(panelMode.value === 'step' ? isPendingStep.value ? 'workflow.addStep' : 'workflow.stepPanelTitle' : panelMode.value === 'automation' ? 'workflow.automationPanelTitle' : 'workflow.runPanelTitle'))
function openPanel(mode: PanelMode) {
  const active = document.activeElement
  if (active instanceof HTMLElement && !panelElement.value?.contains(active)) panelInvoker = active
  panelMode.value = mode
  void nextTick(() => panelElement.value?.focus({ preventScroll: true }))
}
function focusPanelField(selector: string) {
  const field = panelElement.value?.querySelector<HTMLElement>(selector)
  const control = field?.matches('input, textarea, button') ? field : field?.querySelector<HTMLElement>('button, input, textarea')
  control?.focus({ preventScroll: true })
}
function closePanel() {
  rememberStepDraft()
  panelMode.value = null
  const target = panelInvoker
  panelInvoker = null
  void nextTick(() => { if (target?.isConnected) target.focus({ preventScroll: true }) })
}
function displayTime(value?: string) { return value ? new Date(value).toLocaleString() : '—' }
function duration(start?: string, finish?: string) {
  if (!start || !finish) return '—'
  return `${Math.max(0, (Date.parse(finish) - Date.parse(start)) / 1000).toFixed(1)}s`
}
function inspectRun(run: WorkflowRun) {
  const active = document.activeElement
  if (active instanceof HTMLElement) runDetailsInvoker = active
  void router.push({ path: '/automation/workflows/history', query: { run_id: run.id } })
}
let runDetailsInvoker: HTMLElement | null = null
const deletingRun = ref<WorkflowRun | null>(null)
const deletingBusy = ref(false)
const deliveryBusy = ref('')
const outputFileBusy = ref('')
const importOpen = ref(false)
const exportBusy = ref(false)
async function importedWorkflow(workflow: Workflow) {
  importOpen.value = false
  await store.loadWorkflows()
  selectWorkflow(workflow.id)
}
async function exportDefinition(workflow?: Workflow) {
  if (exportBusy.value) return
  if (!workflow && (!applyStepDrafts() || !validateRunSettings())) return
  const definition = workflow || { id: store.currentWorkflowId || '', name: currentName.value || t('workflow.namePlaceholder'), nodes: store.nodes, edges: store.edges, data: store.workflowData }
  exportBusy.value = true
  try {
    const result = await downloadWorkflowDefinition(JSON.parse(JSON.stringify(definition)))
    if (result.saved) {
      toast.success(t('workflow.transfer.exported'))
      if (result.issues.length) toast.warning(result.issues.map(workflowIssueText).join('\n'))
    }
  } catch (error) { toast.error(workflowErrorText(error)) }
  finally { exportBusy.value = false }
}
async function retryDelivery(deliveryId: string) {
  if (!store.lastRunId || deliveryBusy.value) return
  deliveryBusy.value = deliveryId
  try { if (!await store.retryDelivery(store.lastRunId, deliveryId) && store.error) toast.error(workflowErrorText(store.error)) }
  finally { deliveryBusy.value = '' }
}
function canDeleteRun(run: WorkflowRun) {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
    && !(run.deliveries ?? []).some((delivery) => !['delivered', 'failed'].includes(delivery.status) && !(delivery.kind === 'email' && delivery.status === 'accepted'))
    && !(run.generated_files ?? []).some((file) => ['pending', 'rendering'].includes(file.status))
    && !(run.node_results ?? []).some((node) => node.outcome_unknown || node.status === 'running' || node.status === 'outcome_unknown'
      || (node.branches ?? []).some((branch) => branch.outcome_unknown || branch.status === 'running' || branch.status === 'outcome_unknown'))
}
async function retryOutputFile(fileId: string) {
  if (!store.lastRunId || outputFileBusy.value) return
  outputFileBusy.value = fileId
  try { if (!await store.retryOutputFile(store.lastRunId, fileId) && store.error) toast.error(workflowErrorText(store.error)) }
  finally { outputFileBusy.value = '' }
}
async function copyRun() {
  if (!selectedRun.value) return
  try {
    if (!navigator.clipboard) throw new Error('Clipboard is unavailable')
    await navigator.clipboard.writeText(JSON.stringify(selectedRun.value, null, 2))
    toast.success(t('workflow.outputs.copiedDetails'))
  } catch { toast.error(t('workflow.outputs.copyFailed')) }
}
async function closeRunDetails() {
  store.stopObserving(true)
  if (route.query.run_id) await router.replace({ path: '/automation/workflows/history' })
  await nextTick()
  if (runDetailsInvoker?.isConnected) runDetailsInvoker.focus({ preventScroll: true })
  else document.querySelector<HTMLElement>('[data-workflow-history]')?.focus({ preventScroll: true })
  runDetailsInvoker = null
}
async function confirmDeleteRun() {
  if (!deletingRun.value || deletingBusy.value) return
  const id = deletingRun.value.id
  deletingBusy.value = true
  const removed = await store.deleteRun(id)
  deletingBusy.value = false
  deletingRun.value = null
  if (!removed) { if (store.error) toast.error(workflowErrorText(store.error)); return }
  if (route.query.run_id === id) await closeRunDetails()
  await nextTick()
  if (!(document.activeElement instanceof HTMLElement) || document.activeElement === document.body) {
    (document.querySelector<HTMLElement>('[data-workflow-run-inspect]') || document.querySelector<HTMLElement>('[data-workflow-history]'))?.focus({ preventScroll: true })
  }
}
let routeRevision = 0
let historyRouteActive = false
async function syncRoute() {
  if (!ready.value) return
  const revision = ++routeRevision
  const enteringHistory = page.value === 'history' && !historyRouteActive
  historyRouteActive = page.value === 'history'
  store.stopObserving(page.value === 'editor' && selectedRun.value?.workflow_id !== store.currentWorkflowId)
  if (page.value !== 'editor') closePanel()
  if (page.value === 'history') {
    // 选择另一条详情不卸载列表，保留其滚动位置和入口节点。
    if (enteringHistory) await store.loadRunHistory(null)
    if (revision !== routeRevision) return
    const runId = typeof route.query.run_id === 'string' ? route.query.run_id : ''
    if (runId) void store.inspectRun(runId)
  } else if (page.value === 'editor') {
    const id = typeof route.query.workflow_id === 'string' ? route.query.workflow_id : ''
    if (id && (id !== store.currentWorkflowId || !store.nodes.length)) {
      if (!activateWorkflow(id)) { store.clearCanvas(); toast.error(workflowErrorText('Workflow not found')) }
    } else if (!id && !store.nodes.length) createWorkflow()
    if (selectedRun.value?.workflow_id === store.currentWorkflowId && isRunning.value && store.lastRunId) void store.inspectRun(store.lastRunId)
  }
}
watch(() => [route.path, route.query.workflow_id, route.query.run_id], () => { void syncRoute() })
watch(page, (value, previous) => { if (value === 'editor' && previous !== 'editor') void agents.loadAgents() })
onBeforeUnmount(() => { routeRevision += 1; store.stopObserving() })
async function refreshPage() {
  await Promise.allSettled([store.loadWorkflows(), agents.loadAgents(), store.loadRunHistory(null, page.value === 'history')])
  if (page.value === 'history') await syncRoute()
  else if (page.value === 'editor') await loadTriggers()
}
async function deleteWorkflow(id: string) {
  await store.deleteWorkflow(id)
  if (store.error) toast.error(workflowErrorText(store.error))
}
const agents = useAgentsStore()
const defaultAgentLabel = computed(() => {
  const agent = agents.findAgent(agents.defaultAgentName)
  return t('workflow.followAppDefault') + (agent ? ` · ${agent.display_name || agent.name}` : '')
})
function stepAgentOptions(current: string, allowDefault = true) {
  const options = agents.registeredAgents.map((agent) => ({ value: agent.name, label: agent.display_name || agent.name }))
  if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, label: current })
  return [{ value: '', label: allowDefault ? defaultAgentLabel.value : t('workflow.selectAgent') }, ...options]
}
const tools = ref<McpTool[]>([])
const runInput = ref('')
const runInputConfirmed = ref(false)
const triggerBindings = ref<WorkflowTriggerBinding[]>([])
const triggerForm = ref({ kind: 'manual' as 'manual' | 'cron' | 'webhook', name: '', schedule: '0 9 * * *', input: '', endpoint_ref: '' })
const webhookEndpoints = ref<Webhook[]>([])
const webhookError = ref('')
const availableEndpoints = computed(() => webhookEndpoints.value.filter((endpoint) => endpoint.type === 'generic' && !endpoint.prompt && !endpoint.job_id && (!endpoint.workflow_id || endpoint.workflow_id === store.currentWorkflowId)))
async function loadWebhookEndpoints() {
  try { webhookEndpoints.value = (await getWebhooks()).webhooks ?? []; webhookError.value = '' }
  catch (error) { webhookError.value = error instanceof Error ? error.message : 'Webhook endpoints could not be loaded' }
}
watch(panelMode, (mode) => { if (mode === 'automation') void loadWebhookEndpoints(); if (mode === 'step') void loadResourceCatalogs() })
const triggerBusy = ref(false)
const triggersLoading = ref(false)
const triggersError = ref<string | null>(null)
let triggerRequest = 0
const executionLocation = computed(() => t(backendContext.value?.kind === 'local' ? 'workflow.locationLocal' : backendContext.value?.kind === 'remote' ? 'workflow.locationRemote' : 'workflow.locationUnknown'))
function bindingEnabled(binding: WorkflowTriggerBinding) {
  return binding.kind === 'webhook' ? binding.enabled === true : binding.status === 'active' || binding.status === 'running'
}
const automaticSummary = computed(() => {
  if (triggersLoading.value) return t('workflow.autoLoading')
  if (triggersError.value) return t('workflow.autoLoadFailed')
  if (!triggerBindings.value.length) return t('workflow.autoNotConfigured')
  const enabled = triggerBindings.value.filter(bindingEnabled).length
  return enabled ? t('workflow.autoEnabledCount', { n: enabled }) : t('workflow.autoConfiguredCount', { n: triggerBindings.value.length })
})
function scheduleSummary(schedule: string) {
  const preset = CRON_SCHEDULE_PRESETS.find((item) => item.value === schedule)
  if (preset) return t(preset.labelKey)
  const parsed = parseCronSchedule(schedule)
  if (parsed.kind === 'custom') return schedule
  const day = parsed.kind === 'weekly' ? new Intl.DateTimeFormat(locale.value, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + parsed.weekday))) : ''
  return `${t(parsed.kind === 'daily' ? 'tasks.scheduleDaily' : parsed.kind === 'weekdays' ? 'tasks.scheduleWeekdays' : 'tasks.scheduleWeekly')} ${day} ${parsed.time}`.trim()
}
function bindingTimezone(binding: WorkflowTriggerBinding) {
  if (!binding.timezone) return ''
  const offset = binding.utc_offset_seconds
  const formatted = typeof offset === 'number' ? `UTC${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 3600)).padStart(2, '0')}:${String(Math.floor(Math.abs(offset) % 3600 / 60)).padStart(2, '0')}` : ''
  return [binding.timezone, binding.timezone_abbreviation, formatted].filter(Boolean).join(' · ')
}
function nextRunTime(binding: WorkflowTriggerBinding) {
  const value = binding.next_run_at
  if (!bindingEnabled(binding) || !value || value.startsWith('0001-') || !Number.isFinite(Date.parse(value))) return ''
  // 保留服务返回的日期与偏移，不把本机时区当成调度时区。
  return value.replace('T', ' ')
}
function triggerErrorMessage(error: unknown, fallback: string) {
  const failure = error as { status?: number; statusCode?: number; message?: string }
  return failure?.status === 404 || failure?.statusCode === 404 ? t('workflow.triggersUnsupported') : error ? workflowErrorText(error) : fallback
}
function triggerStatus(binding: WorkflowTriggerBinding) {
  if (binding.status === 'paused') return t('workflow.triggerPaused')
  if (binding.status === 'active') return t('workflow.triggerEnabled')
  if (binding.kind === 'webhook' && !binding.enabled) return t('workflow.autoConfiguredDisabled')
  return binding.status ? t(`workflow.statusLabels.${binding.status}`, binding.status) : t(binding.enabled ? 'workflow.triggerEnabled' : 'workflow.triggerDisabled')
}
async function loadTriggers() {
  const id = store.currentWorkflowId
  const ticket = ++triggerRequest
  triggerBindings.value = []
  triggersLoading.value = !!id
  triggersError.value = null
  if (!id) return
  try { const result = await getWorkflowTriggers(id); if (ticket === triggerRequest && id === store.currentWorkflowId) triggerBindings.value = result.bindings ?? [] }
  catch (error) { if (ticket === triggerRequest && id === store.currentWorkflowId) triggersError.value = triggerErrorMessage(error, t('workflow.triggerReadFailed')) }
  finally { if (ticket === triggerRequest) triggersLoading.value = false }
}
async function bindTrigger() {
  if (!applyStepDrafts() || !validateRunSettings()) return
  if (triggerForm.value.kind === 'manual') { await onSave(); return }
  if (triggerForm.value.kind === 'webhook' && !triggerForm.value.endpoint_ref) { toast.error(workflowErrorText('Select an existing Webhook endpoint')); return }
  const submission = { ...triggerForm.value, kind: triggerForm.value.kind as 'cron' | 'webhook' }
  const originalNodes = store.nodes
  const request = triggerRequest
  triggerBusy.value = true
  try {
    const workflow = await store.saveWorkflow(nameToSave.value)
    if (request !== triggerRequest || originalNodes !== store.nodes) return
    if (!workflow) { saveFailed.value = true; throw new Error(store.error?.message || 'Workflow could not be saved') }
    rememberSaved(workflow)
    await bindWorkflowTrigger(workflow.id, submission)
    if (request !== triggerRequest || workflow.id !== store.currentWorkflowId) return
    if (page.value === 'editor') await router.replace({ path: '/automation/workflows/editor', query: { workflow_id: workflow.id } })
    await loadTriggers()
    toast.success(t('workflow.triggerSaved'))
  } catch (error) { toast.error(triggerErrorMessage(error, t('workflow.triggerSaveFailed'))) }
  finally { triggerBusy.value = false }
}
async function removeTrigger(binding: WorkflowTriggerBinding) {
  if (!store.currentWorkflowId) return
  try { await removeWorkflowTrigger(store.currentWorkflowId, binding); await loadTriggers() }
  catch (error) { toast.error(triggerErrorMessage(error, t('workflow.triggerRemoveFailed'))) }
}
const linearMode = ref(true)
const branches = ref<Array<{ agent: string; task: string }>>([])
const sourceOptions = computed(() => {
  const pending = editingId.value ? pendingSteps.value[editingId.value] : undefined
  const index = store.nodes.findIndex((node) => node.id === (pending?.beforeId || editingId.value))
  return store.nodes.slice(0, Math.max(0, index))
})
const inputSource = ref('{{previous}}')
function isEndpoint(node: CanvasNode) { return node.type === 'input' || node.type === 'output' }
function canMove(index: number, direction: number) {
  const node = store.nodes[index], target = store.nodes[index + direction]
  return linearMode.value && !!node && !!target && !isEndpoint(node) && !isEndpoint(target) && !isRunning.value
}

// 顶栏搜索词作用于当前列表或运行历史。
const props = withDefaults(defineProps<{ search?: string }>(), { search: '' })
const filteredWorkflows = computed(() => {
  const q = props.search.trim().toLowerCase()
  if (!q) return store.savedWorkflows
  return store.savedWorkflows.filter((w) => (w.name ?? '').toLowerCase().includes(q))
})

// 当前编辑工作流名（驱动 store canvas 作为唯一编辑面）
const currentName = ref('')
const savedName = computed(() => store.savedWorkflows.find((workflow) => workflow.id === store.currentWorkflowId)?.name)
const nameError = computed(() => inputLimitError(currentName.value, 'Workflow name', INPUT_LIMITS.displayName, { original: savedName.value }))
const nameToSave = computed(() => currentName.value === savedName.value
  ? currentName.value
  : currentName.value.trim() || t('workflow.defaultName', '新工作流'))
const savedFingerprint = ref<string | null>(null)
const saveFailed = ref(false)
function definitionFingerprint(name: string, nodes: Workflow['nodes'], edges: Workflow['edges'], data?: Workflow['data']) {
  // 对象字段顺序不代表定义变更；保留步骤和边的数组顺序。
  return JSON.stringify([name, nodes, edges, data], (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value)
}
function canvasFingerprint() { return definitionFingerprint(nameToSave.value, store.nodes, store.edges, store.workflowData) }
const hasUnsavedChanges = computed(() => savedFingerprint.value !== canvasFingerprint() || hasStepDraftChanges.value)
const saveState = computed(() => t(store.loading ? 'workflow.saveStateSaving' : saveFailed.value ? 'workflow.saveStateFailed' : hasUnsavedChanges.value ? 'workflow.saveStateUnsaved' : 'workflow.saveStateSaved'))
function rememberSaved(workflow: Workflow) {
  savedFingerprint.value = definitionFingerprint(workflow.name, workflow.nodes, workflow.edges, workflow.data)
  saveFailed.value = false
}

onMounted(async () => {
  await Promise.allSettled([store.loadWorkflows(), page.value === 'history' ? Promise.resolve() : store.loadRunHistory(null, false), agents.loadAgents(), getMcpTools().then((result) => { tools.value = result.tools ?? [] })])
  ready.value = true
  await syncRoute()
})

/** 节点类型 → 图标 / 标题键，对照原型 触发→模型→工具→输出 语义 */
const nodeMeta: Record<CanvasNode['type'], { icon: typeof Brain; key: string }> = {
  input: { icon: Zap, key: 'workflow.nodeTrigger' },
  agent: { icon: Brain, key: 'workflow.nodeAgent' },
  parallel: { icon: Layers, key: 'workflow.nodeParallel' },
  tool: { icon: Wrench, key: 'workflow.nodeTool' },
  condition: { icon: GitBranch, key: 'workflow.nodeCondition' },
  output: { icon: Send, key: 'workflow.nodeOutput' },
}
function metaFor(node: CanvasNode) {
  return nodeMeta[node.type] ?? nodeMeta.tool
}

/** 节点配置摘要（卡片第三行）。 */
function resourceSummary(config: Record<string, unknown>) {
  const settings = settingsFromConfig(config)
  const parts = resourceKeys.filter((key) => settings.resources[key].mode !== 'inherit').map((key) => settings.resources[key].mode === 'none'
    ? t('workflow.resourceUnused', { name: t('workflow.resourceLabels.' + key) })
    : t('workflow.resourceSpecified', { name: t('workflow.resourceLabels.' + key), value: settings.resources[key].value.map((id) => resourceCatalogs.value[key].find((item) => item.id === id)?.label || id).join('、') }))
  if (config.model) parts.unshift(t('workflow.resourceSpecified', { name: t('workflow.fieldModel'), value: config.model }))
  if (settings.memory.retrieval.mode !== 'inherit') parts.push(t(settings.memory.retrieval.mode === 'none' ? 'workflow.memoryReadNone' : 'workflow.memoryRelated'))
  if (settings.memory.writeback.mode !== 'inherit') parts.push(t(settings.memory.writeback.mode === 'none' ? 'workflow.memoryWriteNone' : 'workflow.memorySuggest'))
  return parts.join(' · ') || t('workflow.resourcesAllInherited')
}
function nodeKind(node: CanvasNode) {
  const base = t(metaFor(node).key)
  if (node.type !== 'agent') return base
  const name = String(node.config?.agent || node.config?.role || agents.defaultAgentName)
  return `${base} · ${agents.findAgent(name)?.display_name || name}`
}
function nodeConfigSummary(node: CanvasNode): string {
  const c = (node.config ?? {}) as Record<string, unknown>
  if (c.import_requires_review) return t('workflow.transfer.adaptRequired')
  switch (node.type) {
    case 'input': return !c.value || c.value === '{{input}}' ? t('workflow.inputFromRun') : String(c.value)
    case 'agent': return resourceSummary(c)
    case 'parallel': {
      if (Array.isArray(c.branches)) return c.branches.length ? t('workflow.parallelTaskSummary', { n: c.branches.length }) : t('workflow.summaryNoRoles')
      const roles = (Array.isArray(c.roles) ? c.roles.join(', ') : String(c.roles ?? '')).trim()
      return roles ? roles.split(/[,;\n]/).map((r) => r.trim()).filter(Boolean).map((r) => `@${r}`).join(' ‖ ') : t('workflow.summaryNoRoles', '（未配置并行智能体）')
    }
    case 'tool': return c.tool ? String(c.tool) : t('workflow.summaryNoTool', '（未选择工具）')
    case 'output': return t('workflow.summaryOutput', '透传最终输出')
    default: return node.type
  }
}

/** 线性步骤 = store.nodes 顺序（增删后重建线性边，故顺序即链序） */
const steps = computed<CanvasNode[]>(() => store.nodes)

const isRunning = computed(() => store.runStatus === 'running' || store.runStatus === 'pending')

/** 节点运行状态徽标 */
function nodeStatus(id: string): 'idle' | 'running' | 'completed' | 'failed' | 'skipped' {
  return store.nodeRunStatus[id] ?? 'idle'
}

// ── 工作流选择 / 新建 ──────────────────────────────────────────
function activateWorkflow(id: string): boolean {
  const wf = store.savedWorkflows.find((w) => w.id === id)
  if (!wf) return false
  linearMode.value = wf.edges.length === Math.max(wf.nodes.length - 1, 0)
    && wf.nodes.slice(0, -1).every((node, index) => wf.edges.some((edge) => edge.from === node.id && edge.to === wf.nodes[index + 1]?.id))
  store.loadWorkflowToCanvas(wf)
  currentName.value = wf.name
  resetEditorDrafts()
  rememberSaved(wf)
  void loadTriggers()
  return true
}
function selectWorkflow(id: string) {
  if (!activateWorkflow(id)) return
  void router.push({ path: '/automation/workflows/editor', query: { workflow_id: id } })
}

/** 新建线性工作流：清空画布 + 注入 触发→模型→输出 起步模板（由 AutomationView 顶栏调用）。 */
function createWorkflow() {
  linearMode.value = true
  store.clearCanvas()
  store.currentWorkflowId = null
  currentName.value = t('workflow.defaultName', '新工作流')
  resetEditorDrafts()
  savedFingerprint.value = null
  store.addNode(makeNode('input'))
  store.addNode(makeNode('agent'))
  store.addNode(makeNode('output'))
  rebuildLinearEdges()
  triggerBindings.value = []
  void router.push('/automation/workflows/editor')
}

// ── 步骤增删改 ────────────────────────────────────────────────
function genId() {
  const rnd = (globalThis.crypto?.randomUUID?.() ?? `${Math.random()}`).replace(/-/g, '').slice(0, 8)
  return `n-${rnd}`
}

function makeNode(type: CanvasNode['type']): CanvasNode {
  const id = genId()
  const base = { id, type, x: 120, y: store.nodes.length * 90 }
  switch (type) {
    case 'input': return { ...base, label: t('workflow.defaultInput'), config: { value: '{{input}}' } }
    case 'agent': return { ...base, label: t('workflow.defaultAgent'), config: { prompt: '', agent: '' } }
    case 'parallel': return { ...base, label: t('workflow.defaultParallel'), config: { branches: [{ agent: agents.defaultAgentName, task: '' }, { agent: agents.defaultAgentName, task: '' }] } }
    case 'tool': return { ...base, label: t('workflow.defaultTool'), config: { tool: '' } }
    case 'output': return { ...base, label: t('workflow.defaultOutput'), config: {} }
    case 'condition': return { ...base, label: t('workflow.defaultCondition'), config: {} }
  }
}

/** 线性链：清空既有边，按 store.nodes 顺序串 from→to。 */
function rebuildLinearEdges() {
  if (!linearMode.value) return
  const existingEdges = store.edges.slice()
  for (const e of existingEdges) store.removeEdge(e.id)
  for (let i = 0; i < store.nodes.length - 1; i++) {
    const a = store.nodes[i]!, b = store.nodes[i + 1]!
    store.addEdge({ id: `e-${a.id}-${b.id}`, from: a.id, to: b.id })
  }
}

type ProcessingType = 'agent' | 'tool' | 'parallel'
const processingTypes: ProcessingType[] = ['agent', 'tool', 'parallel']
const pendingSteps = ref<Record<string, { node: CanvasNode; beforeId: string }>>({})
const modeDrafts = new Map<string, Partial<Record<ProcessingType, StepDraft>>>()
const toolDrafts = new Map<string, Map<string, string>>()
const draggingId = ref<string | null>(null)
const dropBeforeId = ref<string | null>(null)
const isPendingStep = computed(() => !!editingId.value && !!pendingSteps.value[editingId.value])
function pendingBefore(id: string) { return Object.values(pendingSteps.value).find((draft) => draft.beforeId === id) }
function editingNode(id: string) { return store.nodes.find((node) => node.id === id) || pendingSteps.value[id]?.node }
function focusStep() {
  void nextTick(() => focusPanelField('[data-step-primary]'))
}
function addStepBefore(beforeId: string) {
  if (!linearMode.value || isRunning.value) return
  const existing = pendingBefore(beforeId)
  if (existing) { openEditStep(existing.node); focusStep(); return }
  rememberStepDraft()
  const node = makeNode('agent'); node.label = t('workflow.newStep')
  pendingSteps.value[node.id] = { node, beforeId }
  loadStepForm(node); openPanel('step'); focusStep()
}
function previewNode(node: CanvasNode): CanvasNode {
  const draft = editingId.value === node.id ? captureStepDraft() : stepDrafts.value[node.id]
  if (!draft) return node
  return { ...node, type: draft.type, label: draft.form.label, config: { ...draft.settings, model: draft.form.config.model, agent: draft.form.config.role, prompt: draft.form.config.prompt, tool: draft.form.config.tool, branches: draft.branches } }
}
function reorderBefore(id: string, beforeId: string) {
  if (!linearMode.value || isRunning.value || id === beforeId) return
  const index = store.nodes.findIndex((node) => node.id === id)
  const reference = store.nodes.find((node) => node.id === beforeId)
  if (index < 0 || isEndpoint(store.nodes[index]!) || !reference || reference.type === 'input') return
  const moved = store.nodes.splice(index, 1)[0]!
  store.nodes.splice(store.nodes.findIndex((node) => node.id === beforeId), 0, moved)
  rebuildLinearEdges()
}
function dragStart(event: DragEvent, node: CanvasNode) {
  if (isEndpoint(node) || isRunning.value || !linearMode.value) { event.preventDefault(); return }
  draggingId.value = node.id
  event.dataTransfer?.setData('text/plain', node.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function dragOver(event: DragEvent, node: CanvasNode) {
  if (!draggingId.value || node.type === 'input') return
  event.preventDefault()
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const index = store.nodes.findIndex((item) => item.id === node.id)
  dropBeforeId.value = event.clientY < box.top + box.height / 2 || node.type === 'output' ? node.id : store.nodes[index + 1]?.id || node.id
}
function dropStep(event: DragEvent) {
  event.preventDefault()
  if (draggingId.value && dropBeforeId.value) reorderBefore(draggingId.value, dropBeforeId.value)
  draggingId.value = null; dropBeforeId.value = null
}
function removeStep(id: string) {
  const node = store.nodes.find((item) => item.id === id)
  if (!node || isEndpoint(node) || !linearMode.value || isRunning.value) return
  store.removeNode(id)
  delete stepDrafts.value[id]
  modeDrafts.delete(id); toolDrafts.delete(id)
  for (const pending of Object.values(pendingSteps.value)) if (pending.beforeId === id) pending.beforeId = store.nodes.find((item) => item.type === 'output')?.id || ''
  if (editingId.value === id) { editingId.value = null; closePanel() }
  rebuildLinearEdges()
}

function moveStep(idx: number, dir: -1 | 1) {
  if (!canMove(idx, dir)) return
  reorderBefore(store.nodes[idx]!.id, store.nodes[dir < 0 ? idx - 1 : idx + 2]?.id || store.nodes.find((node) => node.type === 'output')!.id)
}

// ── 步骤草稿：应用到画布后仍由顶栏保存持久化 ──────────────────
const editingId = ref<string | null>(null)
const editingType = ref<CanvasNode['type'] | null>(null)
interface StepConfigForm { value: string; prompt: string; role: string; roles: string; model: string; modelMode: string; provider: string; tool: string; args: string }
const emptyConfigForm = (): StepConfigForm => ({ value: '', prompt: '', role: '', roles: '', model: '', modelMode: 'inherit', provider: '', tool: '', args: '' })
const editForm = ref<{ label: string; config: StepConfigForm }>({ label: '', config: emptyConfigForm() })

const runTimeout = computed(() => {
  const settings = store.workflowData?.run_settings as { timeout?: { mode?: string; minutes?: number } } | undefined
  return { mode: settings?.timeout?.mode === 'custom' ? 'custom' : 'inherit', minutes: settings?.timeout?.minutes ?? 10 }
})
function setRunTimeout(key: 'mode' | 'minutes', value: string) {
  const data = store.workflowData ?? {}
  store.workflowData = { ...data, run_settings: { ...(data.run_settings as object || {}), timeout: { ...runTimeout.value, [key]: key === 'minutes' ? Number(value) : value } } }
}
function validateRunSettings() {
  if (runTimeout.value.mode !== 'custom' || Number.isFinite(runTimeout.value.minutes) && runTimeout.value.minutes > 0) return true
  toast.error(workflowErrorText('Workflow timeout must be a finite positive number of minutes')); openPanel('automation'); return false
}
type CatalogEntry = { id: string; label: string }
const resourceKeys: WorkflowResourceKey[] = ['skills', 'prompts', 'knowledge', 'tools']
const resourceCatalogs = ref<Record<WorkflowResourceKey, CatalogEntry[]>>({ skills: [], prompts: [], knowledge: [], tools: [] })
const resourceErrors = ref<Partial<Record<WorkflowResourceKey, string>>>({})
const resourcesLoading = ref(false)
async function loadResourceCatalogs() {
  if (resourcesLoading.value) return
  resourcesLoading.value = true
  const loaders = {
    skills: async () => (await getSkills()).skills.filter((item) => item.enabled !== false && item.effective_enabled !== false).map((item) => ({ id: item.name, label: item.display_name || item.name })),
    prompts: async () => (await getPrompts()).prompts.filter((item) => item.enabled).map((item) => ({ id: item.id, label: item.title })),
    knowledge: async () => (await getDocuments()).documents.map((item) => ({ id: item.id, label: item.title })),
    tools: async () => { tools.value = (await getMcpTools()).tools ?? []; return tools.value.map((item) => ({ id: item.name, label: item.name })) },
  }
  await Promise.allSettled(resourceKeys.map(async (key) => {
    try { resourceCatalogs.value[key] = await loaders[key](); delete resourceErrors.value[key] }
    catch (error) { resourceErrors.value[key] = error instanceof Error ? error.message : 'Resource catalog could not be loaded' }
  }))
  resourcesLoading.value = false
}
function resourceChoices(key: WorkflowResourceKey) {
  const choices = resourceCatalogs.value[key]
  return [...choices, ...stepSettings.value.resources[key].value.filter((id) => !choices.some((item) => item.id === id)).map((id) => ({ id, label: id }))]
}
function inheritedResource(key: WorkflowResourceKey, agent = selectedAgent.value) {
  const ids: string[] = key === 'skills' ? agent?.skills ?? [] : (() => {
    try { const value = JSON.parse(agent?.metadata?.['workflow_' + key] || '[]'); return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [] } catch { return [] }
  })()
  return ids.map((id) => resourceCatalogs.value[key].find((item) => item.id === id)?.label || id).join('、') || t('workflow.resourceDefault')
}
function structuredCloneSettings(value: WorkflowStepSettings): WorkflowStepSettings { return JSON.parse(JSON.stringify(value)) }
function settingsFromConfig(config: Record<string, unknown>): WorkflowStepSettings {
  const raw = config as Partial<WorkflowStepSettings>
  const resources = Object.fromEntries(resourceKeys.map((key) => [key, { mode: raw.resources?.[key]?.mode || 'inherit', value: [...raw.resources?.[key]?.value || []] }])) as WorkflowStepSettings['resources']
  return { resources, memory: { retrieval: { mode: raw.memory?.retrieval?.mode || 'inherit', query: raw.memory?.retrieval?.query || '' }, writeback: { mode: raw.memory?.writeback?.mode || 'inherit' } }, output: { kind: raw.output?.kind || 'inherit', fields: raw.output?.fields || '', instructions: raw.output?.instructions || '', artifactKinds: [...raw.output?.artifactKinds || ['file', 'image']] }, input_selection: { kind: raw.input_selection?.kind || 'text', field: raw.input_selection?.field || '' }, output_template: raw.output_template || '', output_field: config.output_object && typeof config.output_object === 'object' ? Object.keys(config.output_object)[0] || '' : '', outputs: { formats: [...raw.outputs?.formats || []] }, delivery: {
    session: { mode: raw.delivery?.session?.mode || 'none' },
    // 已启用且缺少mode的旧配置保持缺省，打开或保存面板不会把原全文投递改为节选。
    dingtalk: { enabled: raw.delivery?.dingtalk?.enabled === true, mode: raw.delivery?.dingtalk?.mode || (raw.delivery?.dingtalk?.enabled ? undefined : 'message'), instance_id: raw.delivery?.dingtalk?.instance_id || '', chat_id: raw.delivery?.dingtalk?.chat_id || '' },
    email: { enabled: raw.delivery?.email?.enabled === true, instance_id: raw.delivery?.email?.instance_id || '', to: raw.delivery?.email?.to || '', subject: raw.delivery?.email?.subject || '' },
    directory: { enabled: raw.delivery?.directory?.enabled === true, location: raw.delivery?.directory?.location === 'service' ? 'service' : 'desktop', path: raw.delivery?.directory?.path || '', directory_ref: raw.delivery?.directory?.directory_ref || '', client_id: raw.delivery?.directory?.client_id || '', label: raw.delivery?.directory?.label || '' },
  } }
}
const stepSettings = ref<WorkflowStepSettings>(settingsFromConfig({}))
const dingtalkContentNote = computed(() => {
  const mode = stepSettings.value.delivery.dingtalk.mode
  return t(mode === 'message' ? 'workflow.delivery.messageOnlyNote'
    : mode === 'files' ? 'workflow.delivery.filesOnlyNote'
      : mode === 'both' ? 'workflow.delivery.messageAndFilesNote' : 'workflow.delivery.legacyContentNote')
})
function changeDingtalkContentMode(value: string) {
  if (value === 'message' || value === 'files' || value === 'both') stepSettings.value.delivery.dingtalk.mode = value
}
const importReviewConfirmations = ref<Record<string, boolean>>({})
const importedSource = computed(() => editingId.value ? editingNode(editingId.value)?.config?.import_source : undefined)
const needsImportReview = computed(() => !!editingId.value && editingNode(editingId.value)?.config?.import_requires_review === true)
const deliveryTargets = ref<WorkflowDeliveryTargets>({ instances: [] })
const deliveryTargetsLoading = ref(false)
const deliveryTargetsError = ref('')
let deliveryTargetsRevision = 0
async function loadDeliveryTargets() {
  const ticket = ++deliveryTargetsRevision
  deliveryTargetsLoading.value = true
  deliveryTargetsError.value = ''
  try {
    const result = await getWorkflowDeliveryTargets()
    if (ticket === deliveryTargetsRevision) deliveryTargets.value = result
  } catch (error) {
    if (ticket === deliveryTargetsRevision) deliveryTargetsError.value = error instanceof Error ? error.message : t('workflow.delivery.targetsFailed')
  } finally { if (ticket === deliveryTargetsRevision) deliveryTargetsLoading.value = false }
}
const deliveryInstanceOptions = computed(() => {
  const options = deliveryTargets.value.instances.filter((instance) => !instance.provider || instance.provider === 'dingtalk').map((instance) => ({ value: instance.id, label: instance.name }))
  const selected = stepSettings.value.delivery.dingtalk.instance_id
  return selected && !options.some((option) => option.value === selected) ? [...options, { value: selected, label: selected }] : options
})
const emailInstanceOptions = computed(() => {
  const options = deliveryTargets.value.instances.filter((instance) => instance.provider === 'email').map((instance) => ({ value: instance.id, label: instance.name }))
  const selected = stepSettings.value.delivery.email.instance_id
  return selected && !options.some((option) => option.value === selected) ? [...options, { value: selected, label: selected }] : options
})
const localDirectories = ref<WorkflowDirectoryRef[]>([])
const directoryBusy = ref(false)
async function loadLocalDirectories() {
  try { localDirectories.value = (await listWorkflowDirectories()).directories }
  catch (error) { toast.error(workflowErrorText(error)) }
}
async function chooseDirectory() {
  if (directoryBusy.value) return
  directoryBusy.value = true
  try {
    const selected = await pickWorkflowDirectory()
    if (selected) {
      Object.assign(stepSettings.value.delivery.directory, selected)
      await loadLocalDirectories()
    }
  } catch (error) { toast.error(workflowErrorText(error)) }
  finally { directoryBusy.value = false }
}
const localDirectoryLabel = computed(() => localDirectories.value.find((entry) => entry.directory_ref === stepSettings.value.delivery.directory.directory_ref && entry.client_id === stepSettings.value.delivery.directory.client_id)?.label || t('workflow.outputs.directoryNone'))
const deliveryChatOptions = computed(() => {
  const setting = stepSettings.value.delivery.dingtalk
  const options = (deliveryTargets.value.instances.find((instance) => instance.id === setting.instance_id)?.targets || []).map((target) => ({ value: target.chat_id, label: target.label }))
  return setting.chat_id && !options.some((option) => option.value === setting.chat_id) ? [...options, { value: setting.chat_id, label: setting.chat_id }] : options
})
function changeDeliveryInstance(value: string) {
  stepSettings.value.delivery.dingtalk.instance_id = value
  stepSettings.value.delivery.dingtalk.chat_id = ''
}
const modelMode = computed({ get: () => editForm.value.config.modelMode, set: (mode) => { editForm.value.config.modelMode = mode; if (mode === 'inherit') { editForm.value.config.model = ''; editForm.value.config.provider = '' } else editForm.value.config.model = selectedAgent.value?.model || '' } })
const selectedModelIdentity = computed({ get: () => editForm.value.config.model ? `${editForm.value.config.provider || selectedAgent.value?.provider || ''}::${editForm.value.config.model}` : '', set: (identity) => { const split = identity.indexOf('::'); editForm.value.config.provider = identity.slice(0, split); editForm.value.config.model = identity.slice(split + 2) } })
function resetResources() { const defaults = settingsFromConfig({}); stepSettings.value.resources = defaults.resources; stepSettings.value.memory = defaults.memory; editForm.value.config.model = ''; editForm.value.config.modelMode = 'inherit'; editForm.value.config.provider = '' }

interface StepDraft {
  type: CanvasNode['type']
  form: { label: string; config: StepConfigForm }
  input: string
  branches: Array<{ agent: string; task: string }>
  baseline: string
  settings: WorkflowStepSettings
}
const stepDrafts = ref<Record<string, StepDraft>>({})
const stepBaseline = ref('')
function currentStepFingerprint() { return JSON.stringify([editingType.value, editForm.value, inputSource.value, branches.value, stepSettings.value, editingId.value ? importReviewConfirmations.value[editingId.value] : false]) }
const hasStepDraftChanges = computed(() => Object.keys(stepDrafts.value).some((id) => !pendingSteps.value[id]) || !!editingId.value && !isPendingStep.value && currentStepFingerprint() !== stepBaseline.value)
function captureStepDraft(): StepDraft {
  return { type: editingType.value!, form: JSON.parse(JSON.stringify(editForm.value)), input: inputSource.value, branches: branches.value.map((branch) => ({ ...branch })), baseline: stepBaseline.value, settings: structuredCloneSettings(stepSettings.value) }
}
function restoreStepDraft(draft: StepDraft) {
  stepSettings.value = structuredCloneSettings(draft.settings)
  editingType.value = draft.type; editForm.value = JSON.parse(JSON.stringify(draft.form)); inputSource.value = draft.input
  branches.value = draft.branches.map((branch) => ({ ...branch })); stepBaseline.value = draft.baseline
}
function rememberStepDraft() {
  if (!editingId.value) return
  if (!isPendingStep.value && currentStepFingerprint() === stepBaseline.value) { delete stepDrafts.value[editingId.value]; return }
  stepDrafts.value[editingId.value] = captureStepDraft()
}
function changeProcessingType(value: string) {
  if (!editingId.value || !processingTypes.includes(value as ProcessingType)) return
  const id = editingId.value; const current = captureStepDraft(); const type = value as ProcessingType
  if (current.type === type) return
  const modes = modeDrafts.get(id) || {}; modes[current.type as ProcessingType] = current; modeDrafts.set(id, modes)
  if (modes[type]) restoreStepDraft(modes[type]!)
  else {
    const node = { ...makeNode(type), id }; loadStepForm(node, true)
  }
  stepSettings.value.input_selection = { ...current.settings.input_selection }
  editForm.value.label = current.form.label; inputSource.value = current.input; stepBaseline.value = current.baseline
  rememberStepDraft(); focusStep()
}
function resetEditorDrafts() {
  importReviewConfirmations.value = {}
  panelMode.value = null
  editingId.value = null
  stepDrafts.value = {}
  pendingSteps.value = {}; modeDrafts.clear(); toolDrafts.clear(); editingType.value = null
  runInput.value = ''
  runInputConfirmed.value = false
  triggerForm.value = { kind: 'manual', name: '', schedule: '0 9 * * *', input: '', endpoint_ref: '' }
  triggerRequest += 1
  triggersLoading.value = false
  triggersError.value = null
  saveFailed.value = false
}
function loadStepForm(node: CanvasNode, fresh = false) {
  editingId.value = node.id
  const cached = fresh ? undefined : stepDrafts.value[node.id]
  editingType.value = node.type
  if (cached) {
    editingType.value = cached.type
    editForm.value = JSON.parse(JSON.stringify(cached.form))
    inputSource.value = cached.input
    branches.value = cached.branches.map((branch) => ({ ...branch }))
    stepSettings.value = structuredCloneSettings(cached.settings)
    stepBaseline.value = cached.baseline
    return
  }
  const cfg = (node.config ?? {}) as Record<string, unknown>
  stepSettings.value = settingsFromConfig(cfg)
  inputSource.value = String(cfg.input ?? '{{previous}}')
  branches.value = Array.isArray(cfg.branches) ? cfg.branches.map((value) => ({ agent: String(value.agent ?? ''), task: String(value.task ?? '') }))
    : (Array.isArray(cfg.roles) ? cfg.roles : String(cfg.roles ?? '').split(/[,;\n]/)).filter(Boolean).map((agent) => ({ agent: String(agent), task: '' }))
  editForm.value = {
    label: node.label,
    config: {
      value: String(cfg.value ?? ''),
      prompt: String(cfg.prompt ?? ''),
      role: String(cfg.agent ?? cfg.role ?? ''),
      roles: Array.isArray(cfg.roles) ? (cfg.roles as unknown[]).join(', ') : String(cfg.roles ?? ''),
      model: String(cfg.model ?? ''),
      modelMode: cfg.model ? 'override' : 'inherit',
      provider: String(cfg.provider ?? ''),
      tool: String(cfg.tool ?? ''),
      args: typeof cfg.args === 'object' && cfg.args ? JSON.stringify(cfg.args, null, 2) : String(cfg.args ?? ''),
    },
  }
  stepBaseline.value = currentStepFingerprint()
}

function openEditStep(node: CanvasNode) {
  rememberStepDraft()
  loadStepForm(node)
  openPanel('step')
  if (node.type === 'output') { void loadDeliveryTargets(); void loadLocalDirectories() }
}

function cancelStep() {
  const id = editingId.value
  if (id) delete importReviewConfirmations.value[id]
  if (id) { delete stepDrafts.value[id]; modeDrafts.delete(id); toolDrafts.delete(id) }
  if (id && pendingSteps.value[id]) {
    const beforeId = pendingSteps.value[id]!.beforeId
    delete pendingSteps.value[id]
    panelInvoker = document.querySelector<HTMLElement>(`[data-workflow-insert="${beforeId}"]`)
  }
  editingId.value = null; editingType.value = null; panelMode.value = null
  const target = panelInvoker; panelInvoker = null
  void nextTick(() => { if (target?.isConnected) target.focus({ preventScroll: true }) })
}

function saveStep(closeAfter = true, confirmImport = false): boolean {
  if (!editingId.value) return true
  const currentNode = editingNode(editingId.value)
  if (!currentNode) return false
  const type = editingType.value!
  if (confirmImport && currentNode.config?.import_requires_review === true && (!['agent', 'tool'].includes(type) || !importReviewConfirmations.value[editingId.value] || type === 'agent' && (!editForm.value.config.role || !editForm.value.config.prompt.trim()) || type === 'tool' && !editForm.value.config.tool)) {
    toast.error(t('workflow.transfer.reviewRequired')); return false
  }
  const pending = pendingSteps.value[editingId.value]
  if (type === 'agent' && editForm.value.config.modelMode === 'override' && !editForm.value.config.model.trim()) { toast.error(workflowErrorText('Select a model')); openPanel('step'); return false }
  if (pending && type === 'agent' && !editForm.value.config.prompt.trim()) { toast.error(workflowErrorText('Step task is required')); focusStep(); return false }
  if (pending && type === 'tool' && !editForm.value.config.tool) { toast.error(workflowErrorText('Select a tool')); focusStep(); return false }
  if (pending && type === 'parallel' && (branches.value.length < 2 || branches.value.some((branch) => !branch.agent || !branch.task.trim()))) { toast.error(workflowErrorText('Configure at least two complete parallel tasks')); focusStep(); return false }
  const sourceId = inputSource.value.match(/^\{\{node\.(.+)\}\}$/)?.[1]
  if (sourceId && !sourceOptions.value.some((node) => node.id === sourceId)) { toast.error(workflowErrorText('Input source must refer to an earlier step')); openPanel('step'); void nextTick(() => focusPanelField('[data-workflow-input-source]')); return false }
  const f = editForm.value
  const original = store.savedWorkflows
    .find((workflow) => workflow.id === store.currentWorkflowId)?.nodes
    .find((node) => node.id === editingId.value)
  const originalConfig = original?.config ?? {}
  const originalRoles = Array.isArray(originalConfig.roles)
    ? originalConfig.roles.join(', ')
    : String(originalConfig.roles ?? '')
  let limitError = inputLimitError(f.label, 'Step name', INPUT_LIMITS.displayName, { original: original?.label })
  if (!limitError && (type === 'agent' || type === 'parallel')) {
    limitError = inputLimitError(f.config.model, 'Model ID', INPUT_LIMITS.identifier, { original: original ? String(originalConfig.model ?? '') : undefined })
  }
  if (!limitError && type === 'agent') {
    limitError = inputLimitError(f.config.role, 'Role', INPUT_LIMITS.identifier, { original: original ? String(originalConfig.role ?? '') : undefined })
  }
  if (!limitError && type === 'tool') {
    limitError = inputLimitError(f.config.tool, 'Tool name', INPUT_LIMITS.identifier, { original: original ? String(originalConfig.tool ?? '') : undefined })
  }
  if (!limitError && type === 'parallel' && f.config.roles !== originalRoles) {
    const previousRoles = (Array.isArray(originalConfig.roles)
      ? originalConfig.roles.map(String)
      : String(originalConfig.roles ?? '').split(/[,;\n]/))
    for (const role of f.config.roles.split(/[,;\n]/).map((value) => value.trim()).filter(Boolean)) {
      limitError = inputLimitError(role, 'Role', INPUT_LIMITS.identifier, {
        original: previousRoles.includes(role) ? role : undefined,
      })
      if (limitError) break
    }
  }
  if (limitError) {
    toast.error(workflowErrorText(limitError))
    return false
  }
  // 不在当前表单编辑的配置保持，包含既有分支图及进阶运行字段。
  const config: Record<string, unknown> = currentNode.type === type ? { ...currentNode.config } : {}
  if (currentNode.config?.import_source) {
    config.import_source = currentNode.config.import_source
    config.import_requires_review = currentNode.config.import_requires_review === true && !confirmImport
  }
  config.input_selection = { ...stepSettings.value.input_selection }
  if (type === 'output') {
    if (stepSettings.value.output_field.trim()) {
      config.output_object = { [stepSettings.value.output_field.trim()]: '{{value}}' }
      delete config.output_template
    } else {
      config.output_template = stepSettings.value.output_template
      delete config.output_object
    }
    config.delivery = structuredCloneSettings(stepSettings.value).delivery
    config.outputs = structuredCloneSettings(stepSettings.value).outputs
  }
  if (type === 'input') config.value = f.config.value
  if (type === 'agent') {
    config.resources = structuredCloneSettings(stepSettings.value).resources
    config.memory = structuredCloneSettings(stepSettings.value).memory
    config.output = structuredCloneSettings(stepSettings.value).output
    if (f.config.provider) config.provider = f.config.provider
    else delete config.provider
    config.prompt = f.config.prompt
    delete config.agent
    delete config.role
    if (f.config.role.trim()) {
      if (agents.registeredAgents.some((agent) => agent.name === f.config.role) || originalConfig.agent === f.config.role) config.agent = f.config.role
      else config.role = f.config.role.trim()
    }
    if (f.config.model.trim()) config.model = f.config.model.trim()
    else delete config.model
  }
  if (type !== 'input' && inputSource.value) config.input = inputSource.value
  if (type === 'parallel') {
    // 角色列表归一化为字符串数组（后端 parseParallelRoles 同时兼容数组/分隔字符串）。
    config.branches = branches.value.map((branch) => ({ ...branch }))
    config.roles = branches.value.map((branch) => branch.agent).filter(Boolean)
    if (f.config.model.trim()) config.model = f.config.model.trim()
    else delete config.model
  }
  if (type === 'tool') {
    config.tool = f.config.tool.trim()
    if (f.config.args.trim()) {
      try { config.args = JSON.parse(f.config.args); if (!config.args || Array.isArray(config.args) || typeof config.args !== 'object') throw new Error('Expected an object') } catch { toast.error(workflowErrorText('Tool arguments must be a JSON object')); return false }
    }
    else delete config.args
  }
  // 未改动的存量字段保持原值，避免归一化使旧值被误认为本次修改。
  for (const key of ['role', 'model', 'tool'] as const) {
    if (key in config && originalConfig[key] !== undefined && f.config[key] === String(originalConfig[key])) {
      config[key] = originalConfig[key]
    }
  }
  if (type === 'parallel' && !config.branches && originalConfig.roles !== undefined && f.config.roles === originalRoles) {
    config.roles = originalConfig.roles
  }
  const label = pending && (!f.label.trim() || f.label === t('workflow.newStep'))
    ? type === 'agent' ? f.config.prompt.trim().split('\n')[0]!.slice(0, 32) : type === 'tool' ? f.config.tool : t('workflow.defaultParallel')
    : f.label === original?.label ? f.label : f.label.trim() || f.label
  if (pending) {
    const index = store.nodes.findIndex((node) => node.id === pending.beforeId)
    store.nodes.splice(index < 0 ? Math.max(0, store.nodes.length - 1) : index, 0, { ...currentNode, type, label, config })
    delete pendingSteps.value[editingId.value]; rebuildLinearEdges()
    const id = editingId.value
    void nextTick(() => { panelInvoker = document.querySelector<HTMLElement>(`[data-workflow-edit="${id}"]`) })
  } else store.updateNode(editingId.value, { type, label, config })
  editForm.value.label = label
  delete stepDrafts.value[editingId.value]
  stepBaseline.value = currentStepFingerprint()
  if (closeAfter) { editingId.value = null; closePanel() }
  return true
}

function applyStepDrafts(): boolean {
  rememberStepDraft()
  const selected = editingId.value
  for (const id of Object.keys(stepDrafts.value)) {
    if (pendingSteps.value[id]) continue
    const node = store.nodes.find((item) => item.id === id)
    if (!node) { delete stepDrafts.value[id]; continue }
    loadStepForm(node)
    if (!saveStep(false)) { openPanel('step'); return false }
  }
  if (linearMode.value) {
    const invalid = store.nodes.find((node, index) => {
      const id = String(node.config?.input || '').match(/^\{\{node\.(.+)\}\}$/)?.[1]
      return id && !store.nodes.slice(0, index).some((source) => source.id === id)
    })
    if (invalid) { openEditStep(invalid); toast.error(workflowErrorText('Input source must refer to an earlier step')); void nextTick(() => focusPanelField('[data-workflow-input-source]')); return false }
  }
  const node = selected ? editingNode(selected) : undefined
  if (node) loadStepForm(node)
  else editingId.value = null
  return true
}

const selectedTool = computed(() => tools.value.find((tool) => tool.name === editForm.value.config.tool))
const toolJsonOpen = ref(false)
const parsedToolArgs = computed<Record<string, unknown> | null>(() => {
  try { const value: unknown = JSON.parse(editForm.value.config.args || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null } catch { return null }
})
const toolFields = computed(() => {
  const schema = selectedTool.value?.input_schema || {}
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : schema
  return Object.entries(properties).filter(([, value]) => value && typeof value === 'object' && ['string', 'number', 'integer', 'boolean'].includes(String((value as Record<string, unknown>).type))).map(([name, value]) => ({ name, ...value as { type: string; description?: string; default?: unknown } }))
})
function toolArgumentValue(name: string) {
  const value = parsedToolArgs.value?.[name]
  return typeof value === 'string' || typeof value === 'number' ? value : ''
}
function selectTool(value: string) {
  if (!editingId.value) return
  const cached = toolDrafts.get(editingId.value) || new Map<string, string>()
  cached.set(editForm.value.config.tool, editForm.value.config.args); toolDrafts.set(editingId.value, cached)
  editForm.value.config.tool = value
  editForm.value.config.args = cached.get(value) ?? JSON.stringify(Object.fromEntries(toolFields.value.filter((field) => field.default !== undefined).map((field) => [field.name, field.default])), null, 2)
}
function setToolArgument(name: string, type: string, event: Event) {
  if (!parsedToolArgs.value) return
  const input = event.target as HTMLInputElement
  const args = { ...parsedToolArgs.value }
  if (type === 'boolean') args[name] = input.checked
  else if (type === 'number' || type === 'integer') { if (!input.value) delete args[name]; else if (Number.isFinite(Number(input.value))) args[name] = Number(input.value) }
  else args[name] = input.value
  editForm.value.config.args = JSON.stringify(args, null, 2)
}
const selectedAgent = computed(() => agents.findAgent(editForm.value.config.role || agents.defaultAgentName))
const stepToolOptions = computed(() => {
  const options = tools.value.map((tool) => ({ value: tool.name, label: tool.name }))
  const current = editForm.value.config.tool
  if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, label: current })
  return [{ value: '', label: t('workflow.selectTool') }, ...options]
})
const stepSourceOptions = computed(() => {
  const options = [
    { value: '{{previous}}', label: t('workflow.previousStep'), disabled: false },
    { value: '{{input}}', label: t('workflow.runInputValue'), disabled: false },
    ...sourceOptions.value.map((node) => ({ value: '{{node.' + node.id + '}}', label: node.label, disabled: false })),
  ]
  if (!options.some((option) => option.value === inputSource.value)) options.push({ value: inputSource.value, label: t('workflow.invalidSource') + ' · ' + inputSource.value, disabled: true })
  return options
})
const inputSourceSummary = computed(() => inputSource.value === '{{previous}}' ? t('workflow.previousStep') : inputSource.value === '{{input}}' ? t('workflow.runInputValue') : sourceOptions.value.find((node) => inputSource.value === '{{node.' + node.id + '}}')?.label || inputSource.value)

// ── 保存 / 试运行 ─────────────────────────────────────────────
async function onSave() {
  if (!applyStepDrafts() || !validateRunSettings()) return
  if (store.nodes.length === 0) { toast.info(t('workflow.emptySaveHint', '请先添加步骤')); return }
  if (nameError.value) { toast.error(workflowErrorText(nameError.value)); return }
  rebuildLinearEdges()
  const originalNodes = store.nodes
  const res = await store.saveWorkflow(nameToSave.value)
  if (originalNodes !== store.nodes) return
  if (res) {
    rememberSaved(res)
    await router.replace({ path: '/automation/workflows/editor', query: { workflow_id: res.id } })
    toast.success(t('workflow.savedOk', '工作流已保存'))
    // 保存后静默预检（后端做节点静态分析——最准确的路径）：
    // 全绿不打扰；命中高后果能力（如发布内容）才展开审批。
    await runSavePreflight()
  } else {
    saveFailed.value = true
    toast.error(store.error ? workflowErrorText(store.error) : t('workflow.saveFailed'))
  }
}

// ── 自动化权限：保存后静默预检（条件式向导·workflow 形态） ──────────
const approvalOpen = ref(false)
const approvalPreflight = ref<PreflightResult | null>(null)
const approvalBusy = ref(false)

async function runSavePreflight() {
  const id = store.currentWorkflowId
  if (!id) return
  try {
    const pf = await preflightAutonomy({ source: 'workflow', workflow_id: id })
    if (!pf.all_clear) {
      approvalPreflight.value = pf
      approvalOpen.value = true
    }
  } catch {
    // 治理未启用/老后端：静默降级，运行时权限闸兜底
  }
}

async function onApprovalChoose(mode: 'grant' | 'later' | 'paused') {
  if (mode !== 'grant') {
    approvalOpen.value = false
    return
  }
  if (approvalBusy.value) return
  approvalBusy.value = true
  try {
    await createAutonomyGrant({
      task_ref: `workflow:${store.currentWorkflowId}`,
      source: 'workflow',
      entries: approvalPreflight.value?.needs_decision ?? [],
      note: t('autonomy.approval.grantNote', '创建流任务级授权'),
    })
    toast.success(t('autonomy.approval.grantedWorkflow', '已授权本工作流，运行时自动放行'))
    approvalOpen.value = false
  } catch (e: unknown) {
    toast.error((e as Error)?.message || t('autonomy.approval.grantFailed', '授权未完成，可稍后重试'))
  } finally {
    approvalBusy.value = false
  }
}

async function onRun() {
  if (!applyStepDrafts() || !validateRunSettings()) return
  if (nameError.value) { toast.error(workflowErrorText(nameError.value)); return }
  // 未配置/空工作流不试运行（BUG-20260623）：模型步骤无指令 / 工具步骤未选 → 提示具体原因，不提交执行。
  if (store.runBlocker) {
    const blocker = store.runBlocker
    const node = store.nodes.find((item) => item.id === blocker.nodeId)
    toast.info(t(`workflow.block${blocker.kind}`, { name: node?.label || '' }))
    if (node) openEditStep(node)
    return
  }
  runInputConfirmed.value = true
  openPanel('run')
  rebuildLinearEdges()
  const originalNodes = store.nodes
  const saved = await store.saveWorkflow(nameToSave.value)
  if (originalNodes !== store.nodes) return
  if (!saved) {
    saveFailed.value = true
    toast.error(store.error ? workflowErrorText(store.error) : t('workflow.saveFailed'))
    return
  }
  rememberSaved(saved)
  await router.replace({ path: '/automation/workflows/editor', query: { workflow_id: saved.id } })
  await store.runWorkflow(runInput.value, saved)
  if (store.runStatus === 'unavailable') {
    toast.info(t('workflow.runUnavailable', '工作流引擎未启用，无法试运行'))
  } else if (store.runStatus === 'failed') {
    toast.error(t('workflow.runFailed', '试运行失败'))
  } else if (store.runStatus === 'completed') {
    toast.success(t('workflow.runDone', '试运行完成'))
  }
}

function requestRun() {
  if (isRunning.value) { openPanel('run'); return }
  if (!applyStepDrafts() || !validateRunSettings()) return
  const usesInput = store.nodes.some((node) => JSON.stringify(node.config ?? {}).includes('{{input}}'))
  if (!store.runBlocker && usesInput && !runInput.value && !runInputConfirmed.value) { openPanel('run'); return }
  void onRun()
}

/** 续接：复用上次已完成节点，只重算失败/未达节点（Ph5）。 */
async function onResume() {
  await store.resumeRun()
  if (page.value === 'history' && store.lastRunId) await router.replace({ path: '/automation/workflows/history', query: { run_id: store.lastRunId } })
  if (store.runStatus === 'completed') {
    toast.success(t('workflow.resumeDone', '续接完成'))
  } else if (store.runStatus === 'failed') {
    toast.error(t('workflow.resumeFailed', '续接失败'))
  }
}

async function locatePermissionTarget(taskRef: string, decisionId?: string) {
  await store.loadWorkflows()
  const summary = await getAutonomySummary()
  const task = summary.tasks.find(item => item.kind === 'workflow' && item.task_ref === taskRef)
  const workflow = task ? store.savedWorkflows.find(item => `workflow:${item.id}` === task.task_ref) : undefined
  if (!workflow) return false
  if (decisionId && task?.last_block?.id !== decisionId) return false
  selectWorkflow(workflow.id)
  await nextTick()
  await runSavePreflight()
  return true
}
defineExpose({ loadWorkflows: refreshPage, createWorkflow, locatePermissionTarget, openImport: () => { importOpen.value = true } })
</script>

<template>
  <div class="wfp" :class="{ 'wfp--history': page === 'history' }">
    <UnderlineTabs :model-value="page" :tabs="pageTabs" @update:model-value="goPage" />
    <section v-if="page === 'list'" class="wfp-page">
      <LoadingState v-if="!ready || store.workflowsLoading" :text="t('workflow.listLoading')" />
      <EmptyState v-else-if="store.workflowLoadError" :icon="AlertTriangle" :title="t('workflow.listLoadFailed')" />
      <EmptyState v-else-if="store.savedWorkflows.length === 0" :icon="WorkflowIcon" :title="t('workflow.emptyTitle')" :description="t('workflow.emptyDesc')" />
      <EmptyState v-else-if="filteredWorkflows.length === 0" :icon="WorkflowIcon" :title="t('workflow.listNoMatches')" />
      <div v-else class="wfp-list" role="table" :aria-label="t('workflow.listPage')">
        <div class="wfp-list__head wfp-list__grid" role="row"><span role="columnheader">{{ t('workflow.namePlaceholder') }}</span><span role="columnheader">{{ t('workflow.stepCount') }}</span><span role="columnheader">{{ t('workflow.updatedAt') }}</span><span role="columnheader">{{ t('workflow.actions') }}</span></div>
        <div v-for="wf in filteredWorkflows" :key="wf.id" class="hc-resource-row wfp-list__grid" role="row"><strong class="wfp-list__title" role="cell">{{ wf.name }}</strong><span role="cell">{{ wf.nodes.length }}</span><span role="cell">{{ displayTime(wf.updated_at) }}</span><div class="wfp-row-actions" role="cell"><button type="button" class="hc-resource-action" @click="selectWorkflow(wf.id)">{{ t('workflow.open') }}</button><button type="button" class="hc-resource-action" :disabled="exportBusy" @click="exportDefinition(wf)">{{ t('workflow.transfer.export') }}</button><button type="button" class="hc-resource-action hc-resource-action--danger" @click="deleteWorkflow(wf.id)">{{ t('common.delete') }}</button></div></div>
      </div>
    </section>
    <section v-else-if="page === 'history'" class="wfp-page wfp-history" data-workflow-history tabindex="-1" :aria-label="t('workflow.historyPage')" @keydown.esc="closeRunDetails">
      <LoadingState v-if="!ready || store.runHistoryLoading" :text="t('workflow.runsLoading')" />
      <EmptyState v-else-if="store.runHistoryLoadError" :icon="AlertTriangle" :title="runsErrorTitle" />
      <EmptyState v-else-if="filteredRuns.length === 0" :icon="History" :title="t(store.runHistory.length ? 'workflow.runsNoMatches' : 'workflow.runsEmptyTitle')" :description="store.runHistory.length ? undefined : t('workflow.runsEmptyDescription')" />
      <div v-else class="wfp-list wfp-list--scroll" role="table" :aria-label="t('workflow.historyPage')">
        <div class="wfp-list__head wfp-list__grid wfp-list__grid--history" role="row"><span role="columnheader">{{ t('workflow.namePlaceholder') }}</span><span role="columnheader">{{ t('workflow.startedAt') }}</span><span role="columnheader">{{ t('workflow.duration') }}</span><span role="columnheader">{{ t('workflow.runStatus') }}</span><span role="columnheader">{{ t('workflow.actions') }}</span></div>
        <div v-for="run in filteredRuns" :key="run.id" class="hc-resource-row wfp-list__grid wfp-list__grid--history" :class="{ 'wfp-row--selected': run.id === route.query.run_id }" role="row"><strong class="wfp-list__title" role="cell">{{ workflowName(run) }}</strong><span role="cell">{{ displayTime(run.started_at) }}</span><span role="cell">{{ duration(run.started_at, run.finished_at) }}</span><span role="cell">{{ t(`workflow.statusLabels.${run.status}`, run.status) }}</span><div class="wfp-row-actions" role="cell"><button type="button" class="hc-resource-action" data-workflow-run-inspect @click="inspectRun(run)">{{ t('workflow.viewDetails') }}</button><button type="button" class="hc-resource-action" :disabled="!store.savedWorkflows.some((workflow) => workflow.id === run.workflow_id)" @click="selectWorkflow(run.workflow_id)">{{ t('workflow.openWorkflow') }}</button><button type="button" class="hc-resource-action hc-resource-action--danger" :disabled="!canDeleteRun(run) || deletingBusy" :title="canDeleteRun(run) ? t('workflow.deleteRun') : t('workflow.deleteRunUnavailable')" @click="deletingRun = run">{{ t('common.delete') }}</button></div></div>
      </div>
      <DetailDrawer v-if="showRunDetails && store.runResult && selectedRun" :ariaLabel="t('workflow.viewDetails')" :copy-label="t('logs.copyJson')" @copy="copyRun" @close="closeRunDetails">
        <template #header>
          <strong class="wfp-history-title">{{ workflowName(selectedRun) }}</strong><span class="wfp-history-id">{{ store.lastRunId }}</span>
          <button v-if="isRunning" type="button" class="hc-btn hc-btn-ghost" @click="store.cancelRun()">{{ t('workflow.cancelRun') }}</button>
          <button v-if="canResume" type="button" class="hc-btn hc-btn-ghost" @click="onResume"><RotateCcw :size="16" /> {{ t('workflow.resume') }}</button>
        </template>
        <WorkflowRunDetails :delivery-busy="deliveryBusy" :output-file-busy="outputFileBusy" @retry-delivery="retryDelivery" @retry-file="retryOutputFile" :status="store.runStatus" :run-id="store.lastRunId" :input="selectedRun.input" :resource-snapshots="selectedRun.resource_snapshots" :result="store.runResult" />
      </DetailDrawer>
    </section>
    <template v-else-if="page === 'editor' && steps.length">
      <div class="wfp-editor">
        <div class="wfp-head">
          <div class="wfp-head__main">
            <div class="wfp-name-field"><span aria-hidden="true">{{ currentName || t('workflow.namePlaceholder') }}</span><input v-model="currentName" class="wfp-name-input" :aria-label="t('workflow.namePlaceholder')" :placeholder="t('workflow.namePlaceholder')" /></div>
            <span class="wfp-save-state" role="status">{{ saveState }}</span>
          </div>
          <div class="wfp-head__actions">
            <button type="button" class="hc-btn hc-btn-ghost" :disabled="exportBusy" @click="exportDefinition()"><Download :size="16" /> {{ t('workflow.transfer.export') }}</button>
            <button type="button" class="hc-btn hc-btn-primary" :disabled="store.loading" @click="requestRun">
              <Loader2 v-if="isRunning" :size="16" class="wfp-spin" /><Play v-else :size="16" />
              {{ isRunning ? t('workflow.running') : t('workflow.dryRun') }}
            </button>
            <button type="button" class="hc-btn" :disabled="store.loading" :aria-busy="store.loading" @click="onSave"><Loader2 v-if="store.loading" :size="16" class="wfp-spin" /><Save v-else :size="16" /> {{ store.loading ? t('common.saving') : t('workflow.save') }}</button>
          </div>
        </div>
        <div class="wfp-summary">
          <span>{{ t('workflow.steps', { n: steps.length }) }}</span><span aria-hidden="true">·</span>
          <span>{{ t('workflow.manualRun') }}</span><span aria-hidden="true">·</span><span>{{ automaticSummary }}</span>
          <button type="button" class="wfp-text-action" @click="openPanel('automation')">{{ t('workflow.configureAutomation') }}</button>
        </div>
        <p v-if="!linearMode" class="wfp-field__note">{{ t('workflow.graphPreserveNote') }}</p>
        <div class="wfp-workspace" :class="{ 'wfp-workspace--open': panelMode }">
          <div class="wfp-flow">

      <div class="wf">
        <template v-for="(node, i) in steps" :key="node.id">
          <div v-if="i > 0" class="wf-link"><button type="button" class="wf-add" :data-workflow-insert="node.id" :disabled="!linearMode || isRunning" :aria-label="t('workflow.insertBefore', { name: node.label })" aria-controls="workflow-panel" @click="addStepBefore(node.id)"><Plus :size="16" /> {{ t('workflow.addStep') }}</button></div>
          <div v-if="pendingBefore(node.id)" class="wf-node wf-node--pending" :class="{ 'wf-node--selected': panelMode === 'step' && editingId === pendingBefore(node.id)!.node.id }">
            <span class="wf-drag-spacer" aria-hidden="true" /><div class="wf-ic"><component :is="metaFor(previewNode(pendingBefore(node.id)!.node)).icon" :size="18" /></div>
            <div class="wf-main"><div class="wf-t">{{ previewNode(pendingBefore(node.id)!.node).label }}</div><div class="wf-k">{{ t(metaFor(previewNode(pendingBefore(node.id)!.node)).key) }}</div><div class="wf-d">{{ nodeConfigSummary(previewNode(pendingBefore(node.id)!.node)) }}</div><p class="wfp-field__note">{{ t('workflow.pendingStep') }}</p></div>
            <span v-if="panelMode === 'step' && editingId === pendingBefore(node.id)!.node.id" class="wf-edit-state">{{ t('workflow.editingStep') }}</span>
            <button type="button" class="wf-op" :aria-label="t('workflow.continueStep')" @click="openEditStep(pendingBefore(node.id)!.node)"><Pencil :size="16" /></button><span class="wf-drag-spacer" aria-hidden="true" />
          </div>
          <div class="wf-node" :class="{ trigger: node.type === 'input', 'wf-node--selected': panelMode === 'step' && editingId === node.id, 'wf-node--dragging': draggingId === node.id, 'wf-node--drop': dropBeforeId === node.id, [`wf-node--${nodeStatus(node.id)}`]: nodeStatus(node.id) !== 'idle' }" @dragover="dragOver($event, node)" @drop="dropStep" @dragend="draggingId = null; dropBeforeId = null">
            <button v-if="!isEndpoint(node)" type="button" class="wf-op wf-drag" :disabled="isRunning || !linearMode" :draggable="!isRunning && linearMode" :title="t('workflow.dragStep')" :aria-label="t('workflow.dragStep')" @dragstart="dragStart($event, node)"><GripVertical :size="16" /></button><span v-else class="wf-drag-spacer" aria-hidden="true" />
            <div class="wf-ic"><component :is="metaFor(node).icon" :size="18" /></div>
            <div class="wf-main"><div class="wf-t">{{ node.label }}</div><div class="wf-k">{{ nodeKind(node) }}</div><div class="wf-d">{{ nodeConfigSummary(node) }}</div></div>
            <span v-if="panelMode === 'step' && editingId === node.id" class="wf-edit-state">{{ t('workflow.editingStep') }}</span>
            <span v-if="nodeStatus(node.id) === 'running'" class="wf-badge wf-badge--run"><Loader2 :size="12" class="wfp-spin" /></span><span v-else-if="nodeStatus(node.id) === 'completed'" class="wf-badge wf-badge--ok"><CheckCircle2 :size="12" /></span><span v-else-if="nodeStatus(node.id) === 'failed'" class="wf-badge wf-badge--fail"><XCircle :size="12" /></span>
            <div class="wf-ops"><template v-if="!isEndpoint(node)"><button type="button" class="wf-op" :disabled="!canMove(i, -1)" :title="t('workflow.moveUp')" :aria-label="t('workflow.moveUp')" @click="moveStep(i, -1)"><ArrowUp :size="16" /></button><button type="button" class="wf-op" :disabled="!canMove(i, 1)" :title="t('workflow.moveDown')" :aria-label="t('workflow.moveDown')" @click="moveStep(i, 1)"><ArrowDown :size="16" /></button></template>
              <button type="button" class="wf-op" :data-workflow-edit="node.id" :disabled="isRunning" :title="t('workflow.nodeEdit')" :aria-label="t('workflow.nodeEdit') + '：' + node.label" @click="openEditStep(node)"><Pencil :size="16" /></button><button v-if="!isEndpoint(node)" type="button" class="wf-op wf-op--danger" :disabled="!linearMode || isRunning" :title="t('workflow.removeStep')" :aria-label="t('workflow.removeStep') + '：' + node.label" @click="removeStep(node.id)"><Trash2 :size="16" /></button><span v-else class="wf-drag-spacer" aria-hidden="true" />
            </div>
          </div>
        </template>
      </div>


            <p class="wfp-note">{{ t('workflow.notePre') }}<b>{{ t('workflow.noteChain') }}</b>{{ t('workflow.noteMid1') }}<b>{{ t('workflow.noteLinear') }}</b>{{ t('workflow.notePost') }}</p>
          </div>
          <aside v-if="panelMode" id="workflow-panel" ref="panelElement" class="wfp-panel" role="region" aria-labelledby="workflow-panel-title" tabindex="-1" @keydown.esc.stop.prevent="closePanel">
            <header class="wfp-panel__head"><div class="wfp-panel__heading"><h3 id="workflow-panel-title">{{ panelTitle }}</h3><input v-if="panelMode === 'step'" v-model="editForm.label" class="wfp-step-name" :aria-label="t('workflow.fieldLabel')" :disabled="isRunning" /></div><button type="button" class="wf-op" :aria-label="t('workflow.closePanel')" :title="t('workflow.closePanel')" @click="closePanel"><X :size="16" /></button></header>
            <div class="wfp-panel__body">
              <template v-if="panelMode === 'step' && editingId">
                <fieldset class="wfp-step-form" :disabled="isRunning">
                  <section v-if="importedSource" class="wfp-disclosure">
                    <p class="wfp-field__note">{{ t(needsImportReview ? 'workflow.transfer.adaptRequired' : 'workflow.transfer.adapted') }}</p>
                    <details><summary>{{ t('workflow.transfer.sourceSettings') }}</summary><pre class="wfp-import-source">{{ JSON.stringify(importedSource, null, 2) }}</pre><p class="wfp-field__note">{{ t('workflow.transfer.sourceNote') }}</p></details>
                    <label v-if="needsImportReview && editingId" class="wfp-resource-choice"><input v-model="importReviewConfirmations[editingId]" type="checkbox" /><span>{{ t('workflow.transfer.reviewConfirm') }}</span></label>
                  </section>

              <label v-if="editingType && processingTypes.includes(editingType as ProcessingType)" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.processingType') }}</span><HcSelect :model-value="editingType || ''" @update:model-value="changeProcessingType" :disabled="isRunning" :options="[{ value: 'agent', label: t('workflow.processAgent') }, { value: 'tool', label: t('workflow.processTool') }, { value: 'parallel', label: t('workflow.processParallel') }]" :ariaLabel="t('workflow.processingType')" /></label>
              <p v-if="agents.error && (editingType === 'agent' || editingType === 'parallel')" role="alert" class="wfp-field__note">{{ t('workflow.agentsLoadFailed') }}</p>
              <template v-if="editingType === 'agent'">
                <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.fieldPrompt') }}</span><textarea v-model="editForm.config.prompt" data-step-primary class="hc-input wfp-textarea" rows="4" :placeholder="t('workflow.stepTaskPlaceholder')" /></label>
                <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.executingAgent') }}</span><HcSelect v-model="editForm.config.role" :disabled="isRunning" :options="needsImportReview ? stepAgentOptions(editForm.config.role, false) : stepAgentOptions(editForm.config.role)" :ariaLabel="t('workflow.executingAgent')" /></label>
              </template>
              <template v-if="editingType === 'parallel'">
                <p class="wfp-field__note">{{ t('workflow.parallelJoin') }}</p><section v-for="(branch, index) in branches" :key="index" class="wfp-branch"><label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.branchAgentLabel', { n: index + 1 }) }}</span><textarea v-model="branch.task" data-step-primary class="hc-input wfp-textarea" rows="2" :placeholder="t('workflow.branchAgentTask')" /></label><label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.executingAgent') }}</span><HcSelect v-model="branch.agent" :disabled="isRunning" :options="stepAgentOptions(branch.agent, false)" :ariaLabel="t('workflow.executingAgent')" /></label><details v-if="branch.agent"><summary>{{ t('workflow.inheritedResources') }}</summary><p class="wfp-field__note">{{ agents.findAgent(branch.agent)?.model || t('workflow.resourceDefault') }}</p><p v-for="key in resourceKeys" :key="key" class="wfp-field__note">{{ t('workflow.resourceLabels.' + key) }}：{{ inheritedResource(key, agents.findAgent(branch.agent)) }}</p><p class="wfp-field__note">{{ t('workflow.memoryWriteNote') }}</p></details><button type="button" class="wfp-text-action" @click="branches.splice(index, 1)">{{ t('workflow.removeBranch') }}</button></section><button type="button" class="hc-btn" @click="branches.push({ agent: agents.defaultAgentName, task: '' })">{{ t('workflow.addAgentBranch') }}</button>
              </template>
              <template v-if="editingType === 'tool'">
                <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.fieldTool') }}</span><HcSelect :model-value="editForm.config.tool" data-step-primary @update:model-value="selectTool" :disabled="isRunning" :options="stepToolOptions" :ariaLabel="t('workflow.fieldTool')" /></label>
                <p v-if="selectedTool" class="wfp-field__note">{{ selectedTool.description }}<template v-if="selectedTool.server_name"> · {{ selectedTool.server_name }}</template></p>
                <label v-for="field in toolFields" :key="field.name" class="wfp-field"><span class="wfp-field__label">{{ field.name }}</span><textarea v-if="field.type === 'string' && field.name === 'sql'" class="hc-input wfp-textarea" rows="3" :disabled="!parsedToolArgs" :value="toolArgumentValue(field.name)" @input="setToolArgument(field.name, field.type, $event)" /><input v-else-if="field.type === 'boolean'" type="checkbox" :disabled="!parsedToolArgs" :checked="parsedToolArgs?.[field.name] === true" @change="setToolArgument(field.name, field.type, $event)" /><input v-else class="hc-input" :type="['number', 'integer'].includes(field.type) ? 'number' : 'text'" step="any" :disabled="!parsedToolArgs" :value="toolArgumentValue(field.name)" @input="setToolArgument(field.name, field.type, $event)" /><span v-if="field.description" class="wfp-field__note">{{ field.description }}</span></label>
                <details v-if="editForm.config.tool" class="wfp-disclosure" :open="toolJsonOpen || parsedToolArgs === null" @toggle="toolJsonOpen = ($event.target as HTMLDetailsElement).open"><summary>{{ t('workflow.advancedToolArgs') }}</summary><textarea v-model="editForm.config.args" class="hc-input wfp-textarea" rows="5" placeholder="{}" /><p v-if="!parsedToolArgs" class="wfp-field__note">{{ t('workflow.invalidToolArgs') }}</p></details>
              </template>
              <details v-if="editingType !== 'input'" class="wfp-disclosure" :open="!['{{previous}}', '{{input}}'].includes(inputSource) && !sourceOptions.some((source) => inputSource === '{{node.' + source.id + '}}')"><summary>{{ t('workflow.inputSourceLabel') }}：{{ inputSourceSummary }}</summary><HcSelect v-model="inputSource" data-workflow-input-source :disabled="isRunning" :options="stepSourceOptions" :ariaLabel="t('workflow.inputSourceLabel')" /><label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.inputValueKind') }}</span><HcSelect v-model="stepSettings.input_selection.kind" :disabled="isRunning" :options="[{ value: 'text', label: t('workflow.valueText') }, { value: 'structured', label: t('workflow.valueStructured') }, { value: 'artifact', label: t('workflow.valueArtifact') }]" :ariaLabel="t('workflow.inputValueKind')" /></label><label v-if="stepSettings.input_selection.kind === 'structured'" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.inputFieldPath') }}</span><input v-model="stepSettings.input_selection.field" class="hc-input" placeholder="summary / items" /></label><p v-if="stepSettings.input_selection.kind === 'artifact'" class="wfp-field__note">{{ t('workflow.artifactInputNote') }}</p></details>
              <div v-if="editingType === 'input'"><label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.inputValueKind') }}</span><HcSelect v-model="stepSettings.input_selection.kind" :disabled="isRunning" :options="[{ value: 'text', label: t('workflow.valueText') }, { value: 'structured', label: t('workflow.valueStructured') }, { value: 'artifact', label: t('workflow.valueArtifact') }]" :ariaLabel="t('workflow.inputValueKind')" /></label><label v-if="stepSettings.input_selection.kind === 'structured'" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.inputFieldPath') }}</span><input v-model="stepSettings.input_selection.field" class="hc-input" placeholder="summary / items" /></label><p v-if="stepSettings.input_selection.kind === 'artifact'" class="wfp-field__note">{{ t('workflow.artifactInputNote') }}</p></div>
              <label v-if="editingType === 'input'" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.fieldInputValue') }}</span><textarea v-model="editForm.config.value" class="hc-input wfp-textarea" rows="3" /></label>
              <details v-if="editingType === 'agent'" class="wfp-disclosure">
                <summary>{{ t('workflow.resourceSettings') }}</summary>
                <button type="button" class="wfp-text-action" @click="resetResources">{{ t('workflow.resetResources') }}</button>
                <p class="wfp-field__note">{{ t('workflow.resourceScopeNote') }}</p>
                <div class="wfp-resource-row">
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.fieldModel') }}</span><HcSelect v-model="modelMode" :disabled="isRunning" :options="[{ value: 'inherit', label: t('workflow.resourceInherit') }, { value: 'override', label: t('workflow.resourceOverride') }]" :ariaLabel="t('workflow.fieldModel')" /></label>
                  <p v-if="modelMode === 'inherit'" class="wfp-field__note">{{ selectedAgent?.model || t('workflow.resourceDefault') }}</p>
                  <ModelSelector v-else v-model="selectedModelIdentity" :empty-label="t('workflow.fieldModelHint')" preserve-invalid />
                </div>
                <div v-for="key in resourceKeys" :key="key" class="wfp-resource-row">
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.resourceLabels.' + key) }}</span><HcSelect v-model="stepSettings.resources[key].mode" :disabled="isRunning" :options="[{ value: 'inherit', label: t('workflow.resourceInherit') }, { value: 'override', label: t('workflow.resourceOverride') }, { value: 'none', label: t('workflow.resourceNone') }]" :ariaLabel="t('workflow.resourceLabels.' + key)" /></label>
                  <p v-if="stepSettings.resources[key].mode === 'inherit'" class="wfp-field__note">{{ inheritedResource(key) }}</p>
                  <template v-if="stepSettings.resources[key].mode === 'override'">
                    <p v-if="resourceErrors[key]" class="wfp-field__note" role="alert">{{ workflowErrorText(resourceErrors[key]) }} <button type="button" class="wfp-text-action" @click="loadResourceCatalogs">{{ t('common.retry') }}</button></p>
                    <p v-else-if="resourcesLoading" class="wfp-field__note">{{ t('common.loading') }}</p>
                    <label v-for="item in resourceChoices(key)" :key="item.id" class="wfp-resource-choice"><input v-model="stepSettings.resources[key].value" type="checkbox" :value="item.id" /><span>{{ item.label }}</span></label>
                  </template>
                </div>
                <details class="wfp-disclosure"><summary>{{ t('workflow.memorySettings') }}</summary>
                  <p class="wfp-field__note">{{ t('workflow.memoryScopeNote') }}</p>
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.memoryRetrieval') }}</span><HcSelect v-model="stepSettings.memory.retrieval.mode" :disabled="isRunning" :options="[{ value: 'inherit', label: t('workflow.policyInherit') }, { value: 'related', label: t('workflow.memoryRelated') }, { value: 'none', label: t('workflow.memoryReadNone') }]" :ariaLabel="t('workflow.memoryRetrieval')" /></label>
                  <label v-if="stepSettings.memory.retrieval.mode === 'related'" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.memoryQuery') }}</span><input v-model="stepSettings.memory.retrieval.query" class="hc-input" :placeholder="t('workflow.memoryQueryPlaceholder')" /></label>
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.memoryWriteback') }}</span><HcSelect v-model="stepSettings.memory.writeback.mode" :disabled="isRunning" :options="[{ value: 'inherit', label: t('workflow.policyInherit') }, { value: 'suggest', label: t('workflow.memorySuggest') }, { value: 'none', label: t('workflow.memoryWriteNone') }]" :ariaLabel="t('workflow.memoryWriteback')" /></label>
                  <p class="wfp-field__note">{{ t('workflow.memoryWriteNote') }}</p>
                </details>
                <details v-if="selectedAgent?.system_prompt"><summary>{{ t('workflow.baseInstructions') }}</summary><p class="wfp-field__note">{{ selectedAgent.system_prompt }}</p></details>
              </details>
              <details v-if="editingType === 'agent'" class="wfp-disclosure"><summary>{{ t('workflow.outputRequirements') }}</summary>
                <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputKind') }}</span><HcSelect v-model="stepSettings.output.kind" :disabled="isRunning" :options="[{ value: 'inherit', label: t('workflow.outputInherit') }, { value: 'text', label: t('workflow.valueText') }, { value: 'structured', label: t('workflow.valueStructured') }, { value: 'artifact', label: t('workflow.valueArtifact') }]" :ariaLabel="t('workflow.outputKind')" /></label>
                <label v-if="stepSettings.output.kind === 'structured'" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputFields') }}</span><textarea v-model="stepSettings.output.fields" class="hc-input wfp-textarea" rows="3" :placeholder="t('workflow.outputFieldsPlaceholder')" /></label>
                <template v-if="stepSettings.output.kind === 'artifact'"><label v-for="kind in ['file', 'image']" :key="kind" class="wfp-resource-choice"><input v-model="stepSettings.output.artifactKinds" type="checkbox" :value="kind" /><span>{{ t('workflow.artifactLabels.' + kind) }}</span></label><p class="wfp-field__note">{{ t('workflow.artifactRequirementNote') }}</p></template>
                <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputInstructions') }}</span><textarea v-model="stepSettings.output.instructions" class="hc-input wfp-textarea" rows="2" /></label>
              </details>
              <label v-if="editingType === 'output'" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.transfer.outputField') }}</span><input v-model="stepSettings.output_field" class="hc-input" :placeholder="t('workflow.transfer.outputFieldPlaceholder')" /><span class="wfp-field__note">{{ t('workflow.transfer.outputFieldNote') }}</span></label>
              <label v-if="editingType === 'output' && !stepSettings.output_field.trim()" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputMapping') }}</span><textarea v-model="stepSettings.output_template" class="hc-input wfp-textarea" rows="3" :placeholder="t('workflow.outputMappingPlaceholder')" /><span class="wfp-field__note">{{ outputMappingDescription }}</span></label>
              <details v-if="editingType === 'output'" class="wfp-disclosure">
                <summary>{{ t('workflow.outputs.title') }}</summary>
                <p class="wfp-field__note">{{ t('workflow.outputs.description') }}</p>
                <label v-for="format in (['pdf', 'md', 'html'] as const)" :key="format" class="wfp-resource-choice"><input v-model="stepSettings.outputs.formats" type="checkbox" :value="format" /><span>{{ format === 'md' ? 'Markdown' : format.toUpperCase() }}</span></label>
                <p v-if="!stepSettings.outputs.formats.length" class="wfp-field__note">{{ t('workflow.outputs.formatsEmpty') }}</p>
              </details>
              <details v-if="editingType === 'output'" class="wfp-disclosure">
                <summary>{{ t('workflow.delivery.title') }}</summary>
                <p class="wfp-field__note">{{ t('workflow.delivery.description') }}</p>
                <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.delivery.session') }}</span><HcSelect v-model="stepSettings.delivery.session.mode" :disabled="isRunning" :options="[{ value: 'none', label: t('workflow.delivery.none') }, { value: 'source', label: t('workflow.delivery.source') }, { value: 'workflow', label: t('workflow.delivery.workflow') }]" :ariaLabel="t('workflow.delivery.session')" /></label>
                <p class="wfp-field__note">{{ t('workflow.delivery.' + stepSettings.delivery.session.mode + 'Note') }}</p>
                <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.delivery.dingtalk') }}</span><HcSelect :model-value="String(stepSettings.delivery.dingtalk.enabled)" @update:model-value="stepSettings.delivery.dingtalk.enabled = $event === 'true'" :disabled="isRunning" :options="[{ value: 'false', label: t('workflow.delivery.none') }, { value: 'true', label: t('workflow.delivery.sendDingtalk') }]" :ariaLabel="t('workflow.delivery.dingtalk')" /></label>
                <template v-if="stepSettings.delivery.dingtalk.enabled">
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.delivery.contentMode') }}</span><HcSelect :model-value="stepSettings.delivery.dingtalk.mode ?? 'both'" @update:model-value="changeDingtalkContentMode" :disabled="isRunning" :options="[{ value: 'message', label: t('workflow.delivery.messageOnly') }, { value: 'files', label: t('workflow.delivery.filesOnly') }, { value: 'both', label: t('workflow.delivery.messageAndFiles') }]" :ariaLabel="t('workflow.delivery.contentMode')" /></label>
                  <p class="wfp-field__note">{{ dingtalkContentNote }}</p>
                  <p v-if="deliveryTargetsLoading" class="wfp-field__note" role="status">{{ t('common.loading') }}</p>
                  <p v-else-if="deliveryTargetsError" class="wfp-field__note" role="alert">{{ workflowErrorText(deliveryTargetsError) }} <button type="button" class="wfp-text-action" @click="loadDeliveryTargets">{{ t('common.retry') }}</button></p>
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.delivery.instance') }}</span><HcSelect :model-value="stepSettings.delivery.dingtalk.instance_id" @update:model-value="changeDeliveryInstance" :disabled="isRunning || deliveryTargetsLoading" :options="deliveryInstanceOptions" :placeholder="t('workflow.delivery.selectInstance')" :ariaLabel="t('workflow.delivery.instance')" /></label>
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.delivery.chat') }}</span><HcSelect v-model="stepSettings.delivery.dingtalk.chat_id" :disabled="isRunning || deliveryTargetsLoading || !stepSettings.delivery.dingtalk.instance_id" :options="deliveryChatOptions" :placeholder="t('workflow.delivery.selectChat')" :ariaLabel="t('workflow.delivery.chat')" /></label>
                  <p class="wfp-field__note">{{ t('workflow.outputs.dingtalkFormats') }}</p>
                </template>
                <label class="wfp-resource-choice"><input v-model="stepSettings.delivery.email.enabled" type="checkbox" /><span>{{ t('workflow.outputs.sendEmail') }}</span></label>
                <template v-if="stepSettings.delivery.email.enabled">
                  <p v-if="deliveryTargetsLoading" class="wfp-field__note" role="status">{{ t('common.loading') }}</p>
                  <p v-else-if="deliveryTargetsError" class="wfp-field__note" role="alert">{{ workflowErrorText(deliveryTargetsError) }} <button type="button" class="wfp-text-action" @click="loadDeliveryTargets">{{ t('common.retry') }}</button></p>
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputs.emailInstance') }}</span><HcSelect v-model="stepSettings.delivery.email.instance_id" :options="emailInstanceOptions" :placeholder="t('workflow.outputs.selectEmailInstance')" :aria-label="t('workflow.outputs.emailInstance')" /></label>
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputs.emailTo') }}</span><input v-model="stepSettings.delivery.email.to" class="hc-input" :placeholder="t('workflow.outputs.emailToPlaceholder')" /></label>
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputs.emailSubject') }}</span><input v-model="stepSettings.delivery.email.subject" class="hc-input" :placeholder="t('workflow.outputs.emailSubjectPlaceholder')" /></label>
                  <p class="wfp-field__note">{{ t('workflow.outputs.emailNote') }}</p>
                </template>
                <label class="wfp-resource-choice"><input v-model="stepSettings.delivery.directory.enabled" type="checkbox" /><span>{{ t('workflow.outputs.saveDirectory') }}</span></label>
                <template v-if="stepSettings.delivery.directory.enabled">
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputs.directoryLocation') }}</span><HcSelect v-model="stepSettings.delivery.directory.location" :options="[{ value: 'desktop', label: t('workflow.outputs.directoryDesktop') }, { value: 'service', label: t('workflow.outputs.directoryService') }]" :aria-label="t('workflow.outputs.directoryLocation')" /></label>
                  <template v-if="stepSettings.delivery.directory.location === 'desktop'">
                    <div class="wfp-directory-choice"><span class="wfp-field__note">{{ localDirectoryLabel }}</span><button type="button" class="hc-btn" :disabled="directoryBusy" @click="chooseDirectory">{{ t('workflow.outputs.directorySelect') }}</button></div>
                    <p class="wfp-field__note">{{ t('workflow.outputs.directoryOffline') }}</p>
                  </template>
                  <template v-else><label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.outputs.directoryPath') }}</span><input v-model="stepSettings.delivery.directory.path" class="hc-input" /></label><p class="wfp-field__note">{{ t('workflow.outputs.directoryServiceNote') }}</p></template>
                  <p class="wfp-field__note">{{ t('workflow.outputs.directoryRequired') }} {{ t('workflow.outputs.directoryConflict') }}</p>
                </template>
              </details>
                </fieldset>

              </template>
              <template v-else-if="panelMode === 'run'">
                <WorkflowRunDetails :delivery-busy="deliveryBusy" :output-file-busy="outputFileBusy" @retry-delivery="retryDelivery" @retry-file="retryOutputFile" v-if="showRunDetails && store.runResult" :status="store.runStatus" :run-id="store.lastRunId" :input="selectedRun?.input" :resource-snapshots="selectedRun?.resource_snapshots" :result="store.runResult" />
                <p v-else class="wfp-field__note">{{ t('workflow.runEmptyResult') }}</p>
                <label class="wfp-field" for="workflow-run-input"><span class="wfp-field__label">{{ t('workflow.runInputLabel') }}</span><textarea id="workflow-run-input" v-model="runInput" class="hc-input wfp-textarea" rows="4" :disabled="isRunning" :placeholder="t('workflow.runInputPlaceholder')" aria-describedby="workflow-run-input-description" /></label>
                <p id="workflow-run-input-description" class="wfp-field__note">{{ runInputDescription }}</p>
                <p class="wfp-field__note">{{ t('workflow.runSaveNote') }}</p><p class="wfp-field__note">{{ t('workflow.runEffectsNote') }}</p>
              </template>
              <template v-else-if="panelMode === 'automation'">
                <div class="wfp-location"><span class="wfp-field__label">{{ t('workflow.executionLocation') }}</span><strong>{{ executionLocation }}</strong></div>
                <p v-if="backendContext?.kind" class="wfp-field__note">{{ t(backendContext.kind === 'local' ? 'workflow.localRunNote' : 'workflow.remoteRunNote') }}</p>
                <p class="wfp-field__note">{{ t('workflow.saveEffectNote') }}</p>
                <LoadingState v-if="triggersLoading" :text="t('workflow.autoLoading')" />
                <p v-else-if="triggersError" class="wfp-field__note" role="alert">{{ triggersError }}</p>
                <p v-else-if="!triggerBindings.length" class="wfp-field__note">{{ t('workflow.noAutomationRules') }}</p>
                <div v-for="binding in triggerBindings" :key="binding.id" class="wfp-trigger-binding">
                  <div class="wfp-trigger-binding__head"><strong>{{ binding.name }}</strong><span>{{ triggerStatus(binding) }}</span></div>
                  <p>{{ binding.kind === 'cron' ? scheduleSummary(binding.schedule || '') : 'Webhook' }}</p>
                  <p v-if="bindingTimezone(binding)">{{ t('workflow.timezoneLabel') }}：{{ bindingTimezone(binding) }}</p>
                  <p v-if="nextRunTime(binding)">{{ t('workflow.nextRunLabel') }}：{{ nextRunTime(binding) }}</p>
                  <button type="button" class="wfp-text-action" :disabled="isRunning || triggerBusy" @click="removeTrigger(binding)">{{ t('workflow.triggerRemove') }}</button>
                </div>
                <div class="wfp-trigger-form">
                  <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.triggerKindLabel') }}</span><HcSelect v-model="triggerForm.kind" :disabled="triggerBusy || isRunning" :options="[{ value: 'manual', label: t('workflow.triggerManual') }, { value: 'cron', label: t('workflow.triggerCron') }, { value: 'webhook', label: 'Webhook' }]" :ariaLabel="t('workflow.triggerKindLabel')" /></label>
                  <p v-if="triggerForm.kind === 'manual'" class="wfp-field__note">{{ t('workflow.triggerManualNote') }}</p>
                  <label v-if="triggerForm.kind === 'cron'" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.triggerNameLabel') }}</span><input v-model="triggerForm.name" class="hc-input" :disabled="triggerBusy || isRunning" :placeholder="t('workflow.triggerNamePlaceholder')" /></label>
                  <template v-if="triggerForm.kind === 'cron'">
                    <div class="wfp-field"><span class="wfp-field__label">{{ t('workflow.triggerScheduleLabel') }}</span><CronScheduleField v-model="triggerForm.schedule" simple :disabled="triggerBusy || isRunning" /></div>
                    <label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.triggerInputLabel') }}</span><textarea v-model="triggerForm.input" class="hc-input wfp-textarea" rows="3" :disabled="triggerBusy || isRunning" :placeholder="t('workflow.triggerInputPlaceholder')" /></label>
                  </template>
                  <template v-if="triggerForm.kind === 'webhook'"><label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.webhookExisting') }}</span><HcSelect v-model="triggerForm.endpoint_ref" :disabled="triggerBusy || isRunning" :options="[{ value: '', label: t('workflow.webhookSelect') }, ...availableEndpoints.map((endpoint) => ({ value: endpoint.name, label: endpoint.name }))]" :ariaLabel="t('workflow.webhookExisting')" /></label><p v-if="webhookError" class="wfp-field__note" role="alert">{{ webhookError }}</p><p class="wfp-field__note">{{ t('workflow.webhookReferenceNote') }}</p></template>
                </div>
                <div class="wfp-trigger-form"><strong>{{ t('workflow.runPolicy') }}</strong><label class="wfp-field"><span class="wfp-field__label">{{ t('workflow.runTimeout') }}</span><HcSelect :model-value="runTimeout.mode" :disabled="isRunning" @update:model-value="(value) => setRunTimeout('mode', value)" :options="[{ value: 'inherit', label: t('workflow.timeoutInherit') }, { value: 'custom', label: t('workflow.timeoutCustom') }]" :ariaLabel="t('workflow.runTimeout')" /></label><label v-if="runTimeout.mode === 'custom'" class="wfp-field"><span class="wfp-field__label">{{ t('workflow.timeoutMinutes') }}</span><input type="number" step="any" class="hc-input" :disabled="isRunning" :value="runTimeout.minutes" @input="setRunTimeout('minutes', ($event.target as HTMLInputElement).value)" /></label><p class="wfp-field__note">{{ t('workflow.runPolicyNote') }}</p></div>
              </template>
            </div>
            <footer class="wfp-panel__foot">
              <template v-if="panelMode === 'step'"><button type="button" class="hc-btn" @click="cancelStep">{{ t(isPendingStep ? 'workflow.cancelAddStep' : 'common.cancel') }}</button><button type="button" class="hc-btn hc-btn-primary" :disabled="isRunning" @click="saveStep(false, true)">{{ t(isPendingStep ? 'workflow.addStep' : 'workflow.applyStep') }}</button></template>
              <template v-else-if="panelMode === 'run'">
                <button v-if="canResume" type="button" class="hc-btn" :disabled="isRunning" @click="onResume"><RotateCcw :size="16" /> {{ t('workflow.resume') }}</button>
                <button v-if="isRunning" type="button" class="hc-btn" @click="store.cancelRun()">{{ t('workflow.cancelRun') }}</button>
                <button v-else type="button" class="hc-btn hc-btn-primary" :disabled="store.loading" @click="onRun"><Play :size="16" /> {{ t('workflow.startRun') }}</button>
              </template>
              <button v-else type="button" class="hc-btn hc-btn-primary" :disabled="triggerBusy || isRunning" @click="bindTrigger"><Loader2 v-if="triggerBusy" :size="16" class="wfp-spin" />{{ t(triggerForm.kind === 'manual' ? 'common.save' : 'workflow.triggerAdd') }}</button>
            </footer>
          </aside>
        </div>
      </div>
    </template>
    <div v-else-if="ready" class="wfp-field__note">{{ t('workflow.editorSelectHint') }}</div>

    <p v-if="operationError" role="alert" class="wfp-field__note">{{ workflowErrorText(operationError) }}</p>

    <WorkflowImportDialog :open="importOpen" @close="importOpen = false" @imported="importedWorkflow" />
    <ConfirmDialog :open="!!deletingRun" :title="t('workflow.deleteRun')" :message="t('workflow.deleteRunConfirm')" :confirm-text="t('common.delete')" :confirmation-key="deletingRun?.id" @confirm="confirmDeleteRun" @cancel="deletingRun = null" />

    <PermissionApprovalModal
      :open="approvalOpen"
      :task-name="currentName"
      source="workflow"
      :preflight="approvalPreflight"
      :busy="approvalBusy"
      :modes="['grant', 'later']"
      @close="approvalOpen = false"
      @choose="onApprovalChoose"
    />
  </div>
</template>

<style scoped>
.wfp { container-type: inline-size; width: 100%; min-width: 0; padding: 8px 24px 18px; }
.wfp-page { margin-top: 20px; }
.wfp--history { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.wfp--history > :first-child { flex-shrink: 0; }
.wfp-history { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; }
.wfp-list--scroll { flex: 1; min-height: 0; overflow: auto; align-content: start; }
.wfp-history-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.wfp-history-id { color: var(--hc-text-muted); overflow-wrap: anywhere; }
.wfp-list { display: grid; width: 100%; gap: 8px; }
.wfp-list__grid { display: grid; grid-template-columns: minmax(0, 1fr) 80px 190px 208px; gap: 8px; }
.wfp-list__grid--history { grid-template-columns: minmax(0, 1fr) 180px 64px 88px 272px; }
.wfp-list__grid > * { min-width: 0; overflow-wrap: anywhere; }
.wfp-list__head { align-items: center; padding: 0 10px 4px; color: var(--hc-text-muted); font-size: 11px; }
.wfp-list__title { color: var(--hc-text-primary); font-size: 13px; font-weight: 500; }
.wfp-row--selected { background: var(--hc-bg-input); }
.wfp-row-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.wfp-row-actions:empty { display: none; }
.wfp-editor { container-type: inline-size; width: 100%; min-width: 0; padding-top: 18px; }
.wfp-head { display: flex; align-items: center; justify-content: space-between; gap: 12px 24px; flex-wrap: wrap; }
.wfp-head__main { display: flex; flex: 1; align-items: baseline; gap: 12px; min-width: min(100%, 240px); }
.wfp-head__actions { display: flex; gap: 8px; flex-wrap: wrap; }
.wfp-name-field { display: grid; min-width: 0; font-size: 18px; font-weight: 600; line-height: 1.5; margin-inline-start: -7px; }
.wfp-name-field > span { grid-area: 1 / 1; visibility: hidden; min-width: 0; padding: 5px 7px; white-space: pre; overflow: hidden; }
.wfp-name-input { grid-area: 1 / 1; min-width: 0; width: 100%; font: inherit; color: var(--hc-text-primary); background: transparent; border: 1px solid transparent; border-radius: 7px; padding: 4px 6px; }
.wfp-name-input:hover { border-color: var(--hc-border); }
.wfp-name-input:focus { border-color: var(--hc-accent); outline: none; background: var(--hc-bg-input); }
.wfp-save-state { flex-shrink: 0; color: var(--hc-text-muted); font-size: 12px; }
.wfp-summary { display: flex; align-items: baseline; gap: 6px 10px; flex-wrap: wrap; margin: 8px 0 20px; color: var(--hc-text-secondary); font-size: 12px; line-height: 1.6; }
.wfp-summary > span { overflow-wrap: anywhere; }
.wfp-import-source { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; padding: 12px; background: var(--hc-bg-input); border-radius: 8px; }
.wfp-text-action { padding: 0; border: 0; background: transparent; color: var(--hc-accent); cursor: pointer; font: inherit; font-size: 12px; text-align: start; }
.wfp-text-action:hover { text-decoration: underline; }
.wfp-text-action:disabled { opacity: .5; cursor: not-allowed; }
.wfp-workspace { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; width: 100%; min-width: 0; align-items: start; }
.wfp-workspace--open { grid-template-columns: minmax(0, 1fr) clamp(320px, 38%, 460px); }
.wfp-flow { min-width: 0; width: 100%; }
.wf { display: flex; flex-direction: column; align-items: flex-start; width: 100%; min-width: 0; }
.wf-node { display: flex; align-items: center; gap: 14px; width: 100%; min-width: 0; padding: 16px; border: 1px solid var(--hc-border); border-radius: 13px; background: var(--hc-bg-card); transition: border-color .15s; }
.wf-node:hover { border-color: var(--hc-border-hl); }
.wf-node--running { border-color: var(--hc-accent); }
.wf-node--completed { border-color: var(--hc-success); }
.wf-node--failed { border-color: var(--hc-error); }
.wf-node.wf-node--selected, .wf-node.wf-node--selected:hover { border-color: var(--hc-accent); background: var(--hc-accent-subtle); }
.wf-edit-state { flex-shrink: 0; color: var(--hc-accent); font-size: 11px; font-weight: 500; }
.wf-ic { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0; color: var(--hc-text-secondary); background: var(--hc-bg-input); }
.wf-node.trigger .wf-ic { background: var(--hc-accent-subtle); color: var(--hc-accent); }
.wf-main { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.wf-t { font-size: 14px; font-weight: 600; color: var(--hc-text-primary); }
.wf-k { margin-top: 3px; font-size: 11px; color: var(--hc-text-muted); }
.wf-d { margin-top: 5px; font-size: 12px; line-height: 1.6; color: var(--hc-text-secondary); overflow-wrap: anywhere; white-space: pre-wrap; }
.wf-badge { display: grid; place-items: center; width: 22px; height: 22px; flex-shrink: 0; }
.wf-badge--run { color: var(--hc-accent); }
.wf-badge--ok { color: var(--hc-success); }
.wf-badge--fail { color: var(--hc-error); }
.wf-ops { display: flex; gap: 2px; flex-wrap: wrap; flex-shrink: 0; }
.wf-op { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 7px; border: none; background: transparent; color: var(--hc-text-muted); cursor: pointer; }
.wf-op:hover:not(:disabled) { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.wf-op:disabled { opacity: .3; cursor: not-allowed; }
.wf-op--danger:hover:not(:disabled) { color: var(--hc-error); }
.wf-link { position: relative; width: 100%; height: 44px; flex-shrink: 0; }
.wf-link::before { content: ''; position: absolute; inset-inline-start: 81px; top: 0; bottom: 0; width: 2px; background: var(--hc-border); }
.wf-add { position: absolute; inset-inline-start: 81px; top: 6px; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 6px; justify-content: center; min-width: 112px; height: 32px; padding: 0 10px; border-radius: 10px; border: 1px dashed var(--hc-border); background: linear-gradient(var(--hc-bg-elevated), var(--hc-bg-elevated)), var(--hc-bg-main); color: var(--hc-text-secondary); font: inherit; font-size: 12px; cursor: pointer; opacity: 0; pointer-events: none; white-space: nowrap; }
.wf-link:hover > .wf-add, .wf-link:focus-within > .wf-add { opacity: 1; pointer-events: auto; }
.wf-add:hover { border-style: solid; border-color: var(--hc-accent); color: var(--hc-accent); }
.wf-add:disabled { cursor: not-allowed; }
@media (hover: none) { .wf-link > .wf-add { opacity: 1; pointer-events: auto; } }
.wf-drag-spacer { flex: 0 0 32px; width: 32px; height: 32px; }
.wf-drag { flex: 0 0 32px; cursor: grab; }
.wf-node--pending { border-style: dashed; margin-bottom: 14px; }
.wf-node--dragging { opacity: .55; }
.wf-node--drop { position: relative; }
.wf-node--drop::before { content: ''; position: absolute; top: -12px; inset-inline: 0; height: 2px; background: var(--hc-accent); }
.wfp-panel__heading { flex: 1; min-width: 0; }
.wfp-step-name { width: 100%; margin-top: 8px; padding: 4px 6px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--hc-text-secondary); font: inherit; font-size: 12px; }
.wfp-step-name:hover { border-color: var(--hc-border); }
.wfp-step-name:focus-visible { outline: 2px solid var(--hc-accent); outline-offset: 2px; }
.wfp-disclosure { padding-top: 12px; border-top: 1px solid var(--hc-border); color: var(--hc-text-secondary); font-size: 12px; }
.wfp-disclosure > summary { cursor: pointer; }
.wfp-disclosure > :not(summary) { margin-top: 12px; }
.wfp-branch { display: flex; flex-direction: column; gap: 12px; padding: 12px; border: 1px solid var(--hc-border); border-radius: 10px; }
.wfp-note { width: 100%; font-size: 12px; color: var(--hc-text-muted); margin: 20px 0 0; line-height: 1.6; overflow-wrap: anywhere; }
.wfp-note :deep(b) { color: var(--hc-text-secondary); }
.wfp-resource-row { margin-block: 14px; padding-block: 12px; border-block-start: 1px solid var(--hc-border); }
.wfp-resource-choice { display: flex; align-items: flex-start; gap: 8px; margin-block: 8px; font-size: 13px; overflow-wrap: anywhere; }
.wfp-resource-choice input { flex: 0 0 auto; margin-block-start: 3px; }
.wfp-panel { position: sticky; top: 0; display: flex; flex-direction: column; width: 100%; min-width: 0; max-height: calc(100dvh - 240px); border: 1px solid var(--hc-border); border-radius: 13px; background: linear-gradient(var(--hc-bg-elevated), var(--hc-bg-elevated)), var(--hc-bg-main); overflow: hidden; outline: none; }
.wfp-panel__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--hc-border); }
.wfp-panel__head h3 { font-size: 14px; font-weight: 600; margin: 0; color: var(--hc-text-primary); }
.wfp-panel__body { display: flex; flex-direction: column; gap: 14px; padding: 16px; overflow-y: auto; min-height: 0; }
.wfp-step-form { display: flex; flex-direction: column; gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
.wfp-panel__foot { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 16px; border-top: 1px solid var(--hc-border); }
.wfp-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wfp-field__label { font-size: 13px; font-weight: 500; color: var(--hc-text-secondary); }
.wfp-field__note { font-size: 12px; line-height: 1.6; color: var(--hc-text-muted); margin: 0; overflow-wrap: anywhere; }
.wfp-textarea { resize: vertical; font-family: inherit; }
.wfp-editor :is(.wf-op, .wfp-text-action, .wf-add, .hc-btn, .hc-input):focus-visible { outline: 2px solid var(--hc-accent); outline-offset: 2px; }
.wfp-panel :deep(.hc-input:focus-visible) { outline: 2px solid var(--hc-accent); outline-offset: 2px; }
.wfp-field details { font-size: 12px; color: var(--hc-text-secondary); }
.wfp-field details summary { cursor: pointer; }
.wfp-location { display: flex; align-items: baseline; gap: 12px; font-size: 13px; }
.wfp-trigger-form { display: flex; flex-direction: column; gap: 14px; padding-top: 14px; border-top: 1px solid var(--hc-border); }
.wfp-directory-choice { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wfp-trigger-binding { min-width: 0; padding: 12px; border: 1px solid var(--hc-border); border-radius: 9px; font-size: 12px; color: var(--hc-text-secondary); overflow-wrap: anywhere; }
.wfp-trigger-binding__head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.wfp-trigger-binding__head strong { color: var(--hc-text-primary); }
.wfp-trigger-binding p { margin: 6px 0; }
.wfp-run { width: 100%; min-width: 0; padding: 16px; margin-top: 18px; border-radius: 12px; border: 1px solid var(--hc-border); background: var(--hc-bg-card); }
.wfp-run .wfp-row-actions { margin-bottom: 12px; }
.wfp-spin { animation: wfp-spin .8s linear infinite; }
@keyframes wfp-spin { to { transform: rotate(360deg); } }
@container (width < 860px) {
  .wfp-list__head { display: none; }
  .wfp-list__grid, .wfp-list__grid--history { grid-template-columns: minmax(0, 1fr) auto; }
  .wfp-list__title { grid-column: 1 / -1; }
  .wfp-row-actions { grid-column: 1 / -1; justify-content: flex-end; }
}
@container (width < 800px) {
  .wfp-workspace--open { grid-template-columns: minmax(0, 1fr); }
  .wfp-panel { position: absolute; inset-inline-end: 0; top: 0; z-index: 20; width: min(460px, 100%); max-height: calc(100dvh - 240px); box-shadow: var(--hc-shadow-md); }
}
@container (width < 520px) {
  .wfp-head__main { flex-basis: 100%; }
  .wf-node { flex-wrap: wrap; }
  .wf-main { flex-basis: calc(100% - 56px); }
  .wf-ops { margin-inline-start: auto; }
}
@media (prefers-reduced-motion: reduce) { .wfp-spin { animation: none; } }
</style>
