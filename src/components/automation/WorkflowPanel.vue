<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Workflow as WorkflowIcon, Brain, Wrench, GitBranch, Layers, Send, Zap, Pencil, Trash2, ArrowUp, ArrowDown, Play, RotateCcw, Save, X, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-vue-next'
import { useCanvasStore } from '@/stores/canvas'
import { useToast } from '@/composables'
import type { CanvasNode } from '@/types'
import { preflightAutonomy, createAutonomyGrant, type PreflightResult } from '@/api/autonomy'
import PermissionApprovalModal from '@/components/automation/PermissionApprovalModal.vue'

const { t } = useI18n()
const toast = useToast()
const store = useCanvasStore()

// 顶栏搜索词（由 AutomationView 透传）：按工作流名过滤切换 chip。
const props = withDefaults(defineProps<{ search?: string }>(), { search: '' })
const filteredWorkflows = computed(() => {
  const q = props.search.trim().toLowerCase()
  if (!q) return store.savedWorkflows
  return store.savedWorkflows.filter((w) => (w.name ?? '').toLowerCase().includes(q))
})

// 当前编辑工作流名（驱动 store canvas 作为唯一编辑面）
const currentName = ref('')

onMounted(async () => {
  await store.loadWorkflows()
  if (store.savedWorkflows.length > 0) selectWorkflow(store.savedWorkflows[0]!.id)
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
function nodeConfigSummary(node: CanvasNode): string {
  const c = (node.config ?? {}) as Record<string, unknown>
  switch (node.type) {
    case 'input': return String(c.value ?? '')
    case 'agent': return (c.role ? `@${c.role} · ` : '') + String(c.prompt || t('workflow.summaryNoPrompt', '（未配置指令）'))
    case 'parallel': {
      const roles = String(c.roles ?? '').trim()
      return roles ? roles.split(/[,;\n]/).map((r) => r.trim()).filter(Boolean).map((r) => `@${r}`).join(' ‖ ') : t('workflow.summaryNoRoles', '（未配置并行角色）')
    }
    case 'tool': return c.tool ? String(c.tool) : t('workflow.summaryNoTool', '（未选择工具）')
    case 'output': return t('workflow.summaryOutput', '透传最终输出')
    default: return node.type
  }
}

/** 线性步骤 = store.nodes 顺序（增删后重建线性边，故顺序即链序） */
const steps = computed<CanvasNode[]>(() => store.nodes)

const isRunning = computed(() => store.runStatus === 'running')

/** 节点运行状态徽标 */
function nodeStatus(id: string): 'idle' | 'running' | 'completed' | 'failed' {
  return store.nodeRunStatus[id] ?? 'idle'
}

// ── 工作流选择 / 新建 ──────────────────────────────────────────
function selectWorkflow(id: string) {
  const wf = store.savedWorkflows.find((w) => w.id === id)
  if (!wf) return
  store.loadWorkflowToCanvas(wf)
  currentName.value = wf.name
}

/** 新建线性工作流：清空画布 + 注入 触发→模型→输出 起步模板（由 AutomationView 顶栏调用）。 */
function createWorkflow() {
  store.clearCanvas()
  store.currentWorkflowId = null
  currentName.value = t('workflow.defaultName', '新工作流')
  store.addNode(makeNode('input'))
  store.addNode(makeNode('agent'))
  store.addNode(makeNode('output'))
  rebuildLinearEdges()
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
    case 'input': return { ...base, label: t('workflow.nodeTrigger', '触发 / 输入'), config: { value: '{{input}}' } }
    case 'agent': return { ...base, label: t('workflow.nodeAgent', '模型处理'), config: { prompt: '' } }
    case 'parallel': return { ...base, label: t('workflow.nodeParallel', '并行扇出'), config: { roles: '' } }
    case 'tool': return { ...base, label: t('workflow.nodeTool', '调用工具'), config: { tool: '' } }
    case 'output': return { ...base, label: t('workflow.nodeOutput', '输出'), config: {} }
    case 'condition': return { ...base, label: t('workflow.nodeCondition', '条件'), config: {} }
  }
}

/** 线性链：清空既有边，按 store.nodes 顺序串 from→to。 */
function rebuildLinearEdges() {
  const existingEdges = store.edges.slice()
  for (const e of existingEdges) store.removeEdge(e.id)
  for (let i = 0; i < store.nodes.length - 1; i++) {
    const a = store.nodes[i]!, b = store.nodes[i + 1]!
    store.addEdge({ id: `e-${a.id}-${b.id}`, from: a.id, to: b.id })
  }
}

const showAddMenu = ref(false)
function addStep(type: CanvasNode['type']) {
  store.addNode(makeNode(type))
  rebuildLinearEdges()
  showAddMenu.value = false
}

function removeStep(id: string) {
  store.removeNode(id)
  rebuildLinearEdges()
}

function moveStep(idx: number, dir: -1 | 1) {
  const j = idx + dir
  if (j < 0 || j >= store.nodes.length) return
  const arr = store.nodes
  const moved = arr.splice(idx, 1)[0]!
  arr.splice(j, 0, moved)
  rebuildLinearEdges()
}

// ── 步骤编辑弹层 ──────────────────────────────────────────────
const editingId = ref<string | null>(null)
interface StepConfigForm { value: string; prompt: string; role: string; roles: string; model: string; tool: string; args: string }
const emptyConfigForm = (): StepConfigForm => ({ value: '', prompt: '', role: '', roles: '', model: '', tool: '', args: '' })
const editForm = ref<{ label: string; config: StepConfigForm }>({ label: '', config: emptyConfigForm() })
const editingType = computed<CanvasNode['type'] | null>(() => {
  const n = store.nodes.find((x) => x.id === editingId.value)
  return n ? n.type : null
})

function openEditStep(node: CanvasNode) {
  editingId.value = node.id
  const cfg = (node.config ?? {}) as Record<string, unknown>
  editForm.value = {
    label: node.label,
    config: {
      value: String(cfg.value ?? ''),
      prompt: String(cfg.prompt ?? ''),
      role: String(cfg.role ?? ''),
      roles: Array.isArray(cfg.roles) ? (cfg.roles as unknown[]).join(', ') : String(cfg.roles ?? ''),
      model: String(cfg.model ?? ''),
      tool: String(cfg.tool ?? ''),
      args: typeof cfg.args === 'object' && cfg.args ? JSON.stringify(cfg.args, null, 2) : String(cfg.args ?? ''),
    },
  }
}

function closeEditStep() {
  editingId.value = null
}

function saveStep() {
  if (!editingId.value) return
  const type = editingType.value
  const f = editForm.value
  const config: Record<string, unknown> = {}
  if (type === 'input') config.value = f.config.value
  if (type === 'agent') {
    config.prompt = f.config.prompt
    if (f.config.role.trim()) config.role = f.config.role.trim()
    if (f.config.model.trim()) config.model = f.config.model.trim()
  }
  if (type === 'parallel') {
    // 角色列表归一化为字符串数组（后端 parseParallelRoles 同时兼容数组/分隔字符串）。
    config.roles = f.config.roles.split(/[,;\n]/).map((r) => r.trim()).filter(Boolean)
    if (f.config.model.trim()) config.model = f.config.model.trim()
  }
  if (type === 'tool') {
    config.tool = f.config.tool.trim()
    if (f.config.args.trim()) {
      try { config.args = JSON.parse(f.config.args) } catch { config.args = f.config.args }
    }
  }
  store.updateNode(editingId.value, { label: f.label.trim() || editForm.value.label, config })
  closeEditStep()
}

// ── 保存 / 试运行 ─────────────────────────────────────────────
async function onSave() {
  if (store.nodes.length === 0) { toast.info(t('workflow.emptySaveHint', '请先添加步骤')); return }
  rebuildLinearEdges()
  const res = await store.saveWorkflow(currentName.value.trim() || t('workflow.defaultName', '新工作流'))
  if (res) {
    toast.success(t('workflow.savedOk', '工作流已保存'))
    await store.loadWorkflows()
    // 保存后静默预检（后端做节点静态分析——最准确的路径）：
    // 全绿不打扰；命中高后果能力（如发布内容）才展开审批。
    await runSavePreflight()
  } else {
    toast.error(t('workflow.saveFailed', '保存失败，请确认引擎已连接'))
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
  // 未配置/空工作流不试运行（BUG-20260623）：模型步骤无指令 / 工具步骤未选 → 提示具体原因，不提交执行。
  if (store.runBlockReason) { toast.info(store.runBlockReason); return }
  rebuildLinearEdges()
  await store.saveWorkflow(currentName.value.trim() || t('workflow.defaultName', '新工作流'))
  await store.runWorkflow()
  if (store.runStatus === 'unavailable') {
    toast.info(t('workflow.runUnavailable', '工作流引擎未启用，无法试运行'))
  } else if (store.runStatus === 'failed') {
    toast.error(t('workflow.runFailed', '试运行失败'))
  } else if (store.runStatus === 'completed') {
    toast.success(t('workflow.runDone', '试运行完成'))
  }
}

/** 续接：复用上次已完成节点，只重算失败/未达节点（Ph5）。 */
async function onResume() {
  await store.resumeRun()
  if (store.runStatus === 'completed') {
    toast.success(t('workflow.resumeDone', '续接完成'))
  } else if (store.runStatus === 'failed') {
    toast.error(t('workflow.resumeFailed', '续接失败'))
  }
}

/** 运行结果面板头部图标/文案（区分 完成 / 失败 / 引擎未启用）。 */
const runHeadIcon = computed(() =>
  store.runStatus === 'failed' ? XCircle
  : store.runStatus === 'unavailable' ? AlertTriangle
  : CheckCircle2,
)
const runHeadLabel = computed(() =>
  store.runStatus === 'failed' ? t('workflow.runResultFailed', '运行失败')
  : store.runStatus === 'unavailable' ? t('workflow.runResultUnavailable', '引擎未启用')
  : t('workflow.runResultOk', '运行完成'),
)

defineExpose({ loadWorkflows: store.loadWorkflows, createWorkflow })
</script>

<template>
  <div class="wfp">
    <!-- 空状态：无工作流 -->
    <div v-if="store.savedWorkflows.length === 0 && store.nodes.length === 0" class="wfp-empty">
      <div class="wfp-empty__ic"><WorkflowIcon :size="26" /></div>
      <h3 class="wfp-empty__title">{{ t('workflow.emptyTitle') }}</h3>
      <p class="wfp-empty__desc">{{ t('workflow.emptyDesc') }}</p>
      <button type="button" class="hc-btn hc-btn-primary wfp-empty__cta" @click="createWorkflow">
        <Plus :size="15" /> {{ t('workflow.newWorkflow', '新建工作流') }}
      </button>
    </div>

    <template v-else>
      <!-- 工作流切换（多个时显示） -->
      <div v-if="store.savedWorkflows.length > 1" class="wfp-switch">
        <button
          v-for="wf in filteredWorkflows"
          :key="wf.id"
          type="button"
          class="wfp-chip"
          :class="{ 'wfp-chip--on': wf.id === store.currentWorkflowId }"
          @click="selectWorkflow(wf.id)"
        >
          {{ wf.name }}
        </button>
      </div>

      <!-- 头部：名称（可编辑）｜试运行 / 保存 -->
      <div class="wfp-head">
        <div class="wfp-head__main">
          <HcClearableField>
            <input
            v-model="currentName"
            class="wfp-name-input"
            :placeholder="t('workflow.namePlaceholder', '工作流名称')"
          />
          </HcClearableField>
          <div class="wfp-head__sub">
            {{ t('workflow.linearLabel') }} · {{ t('workflow.steps', { n: steps.length }) }}
          </div>
        </div>
        <div class="wfp-head__actions">
          <button type="button" class="hc-btn" :disabled="isRunning" @click="onRun">
            <Loader2 v-if="isRunning" :size="14" class="wfp-spin" />
            <Play v-else :size="14" />
            {{ isRunning ? t('workflow.running', '运行中…') : t('workflow.dryRun') }}
          </button>
          <button v-if="store.runStatus === 'failed' && store.lastRunId" type="button" class="hc-btn" :disabled="isRunning" :title="t('workflow.resumeHint', '复用已完成节点，只重算失败/未达节点')" @click="onResume">
            <RotateCcw :size="14" /> {{ t('workflow.resume', '续接') }}
          </button>
          <button type="button" class="hc-btn hc-btn-primary" :disabled="store.loading" @click="onSave">
            <Save :size="14" /> {{ t('workflow.save') }}
          </button>
        </div>
      </div>

      <!-- 线性节点链 -->
      <div class="wf">
        <template v-for="(node, i) in steps" :key="node.id">
          <div class="wf-node" :class="{ trigger: i === 0, [`wf-node--${nodeStatus(node.id)}`]: nodeStatus(node.id) !== 'idle' }">
            <div class="wf-ic">
              <component :is="metaFor(node).icon" :size="18" />
            </div>
            <div class="wf-main">
              <div class="wf-k">{{ t(metaFor(node).key) }}</div>
              <div class="wf-t">{{ node.label }}</div>
              <div class="wf-d">{{ nodeConfigSummary(node) }}</div>
            </div>
            <!-- 运行状态徽标 -->
            <span v-if="nodeStatus(node.id) === 'running'" class="wf-badge wf-badge--run"><Loader2 :size="12" class="wfp-spin" /></span>
            <span v-else-if="nodeStatus(node.id) === 'completed'" class="wf-badge wf-badge--ok"><CheckCircle2 :size="12" /></span>
            <span v-else-if="nodeStatus(node.id) === 'failed'" class="wf-badge wf-badge--fail"><XCircle :size="12" /></span>
            <!-- 操作 -->
            <div class="wf-ops">
              <button type="button" class="wf-op" :disabled="i === 0" :title="t('workflow.moveUp', '上移')" @click="moveStep(i, -1)"><ArrowUp :size="13" /></button>
              <button type="button" class="wf-op" :disabled="i === steps.length - 1" :title="t('workflow.moveDown', '下移')" @click="moveStep(i, 1)"><ArrowDown :size="13" /></button>
              <button type="button" class="wf-op" :title="t('workflow.nodeEdit')" @click="openEditStep(node)"><Pencil :size="13" /></button>
              <button type="button" class="wf-op wf-op--danger" :title="t('workflow.removeStep', '删除步骤')" @click="removeStep(node.id)"><Trash2 :size="13" /></button>
            </div>
          </div>
          <div v-if="i < steps.length - 1" class="wf-link" />
        </template>

        <div v-if="steps.length > 0" class="wf-link" />
        <!-- 添加步骤 -->
        <div class="wf-addwrap">
          <button type="button" class="wf-add" @click="showAddMenu = !showAddMenu">
            <Plus :size="15" /> {{ t('workflow.addStep') }}
          </button>
          <div v-if="showAddMenu" class="wf-addmenu">
            <button type="button" @click="addStep('input')"><Zap :size="14" /> {{ t('workflow.nodeTrigger', '触发 / 输入') }}</button>
            <button type="button" @click="addStep('agent')"><Brain :size="14" /> {{ t('workflow.nodeAgent', '模型') }}</button>
            <button type="button" @click="addStep('parallel')"><Layers :size="14" /> {{ t('workflow.nodeParallel', '并行扇出') }}</button>
            <button type="button" @click="addStep('tool')"><Wrench :size="14" /> {{ t('workflow.nodeTool', '工具') }}</button>
            <button type="button" @click="addStep('output')"><Send :size="14" /> {{ t('workflow.nodeOutput', '输出') }}</button>
          </div>
        </div>
      </div>

      <!-- 运行结果面板 -->
      <div v-if="store.runResult" class="wfp-run" :class="`wfp-run--${store.runStatus}`">
        <div class="wfp-run__head">
          <component :is="runHeadIcon" :size="14" />
          {{ runHeadLabel }}
        </div>
        <pre class="wfp-run__out">{{ store.runOutput || t('workflow.noOutput', '（无输出）') }}</pre>
      </div>

      <!-- 说明文 -->
      <p class="wfp-note">
        {{ t('workflow.notePre') }}<b>{{ t('workflow.noteChain') }}</b>{{ t('workflow.noteMid1') }}<b>{{ t('workflow.noteLinear') }}</b>{{ t('workflow.notePost') }}
      </p>
    </template>

    <!-- 步骤编辑弹层 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="editingId" class="wfp-modal-overlay" @click.self="closeEditStep">
          <div class="wfp-modal">
            <div class="wfp-modal__head">
              <h3 class="wfp-modal__title">{{ t('workflow.editStepTitle', '编辑步骤') }}</h3>
              <button class="wfp-modal__close" @click="closeEditStep"><X :size="17" /></button>
            </div>
            <div class="wfp-modal__body">
              <label class="wfp-field">
                <span class="wfp-field__label">{{ t('workflow.fieldLabel', '步骤名称') }}</span>
                <HcClearableField>
                  <input v-model="editForm.label" class="wfp-input" />
                </HcClearableField>
              </label>

              <!-- input：触发输入 -->
              <label v-if="editingType === 'input'" class="wfp-field">
                <span class="wfp-field__label">{{ t('workflow.fieldInputValue', '输入内容 / 模板') }}</span>
                <HcClearableField>
                  <textarea v-model="editForm.config.value" rows="3" class="wfp-input wfp-textarea" :placeholder="t('workflow.fieldInputValueHint', '留空则用运行时输入；支持占位变量 input')" />
                </HcClearableField>
              </label>

              <!-- agent：模型 -->
              <template v-if="editingType === 'agent'">
                <label class="wfp-field">
                  <span class="wfp-field__label">{{ t('workflow.fieldPrompt', '指令 / 提示') }}</span>
                  <HcClearableField>
                    <textarea v-model="editForm.config.prompt" rows="4" class="wfp-input wfp-textarea" :placeholder="t('workflow.fieldPromptHint', '支持占位变量 previous（上一步输出）')" />
                  </HcClearableField>
                </label>
                <label class="wfp-field">
                  <span class="wfp-field__label">{{ t('workflow.fieldRole', '智能体角色（可选）') }}</span>
                  <HcClearableField>
                    <input v-model="editForm.config.role" class="wfp-input" :placeholder="t('workflow.fieldRoleHint', '如 researcher / writer，留空用默认助理') " />
                  </HcClearableField>
                </label>
                <label class="wfp-field">
                  <span class="wfp-field__label">{{ t('workflow.fieldModel', '模型覆盖（可选）') }}</span>
                  <HcClearableField>
                    <input v-model="editForm.config.model" class="wfp-input" :placeholder="t('workflow.fieldModelHint', '留空跟随智能路由')" />
                  </HcClearableField>
                </label>
              </template>

              <!-- parallel：并行扇出（多角色并发） -->
              <template v-if="editingType === 'parallel'">
                <label class="wfp-field">
                  <span class="wfp-field__label">{{ t('workflow.fieldRoles', '并行角色（多个）') }}</span>
                  <HcClearableField>
                    <textarea v-model="editForm.config.roles" rows="3" class="wfp-input wfp-textarea" :placeholder="t('workflow.fieldRolesHint', '逗号 / 换行分隔，如 researcher, coder, analyst — 各角色对同一输入并发处理后合并')" />
                  </HcClearableField>
                </label>
                <label class="wfp-field">
                  <span class="wfp-field__label">{{ t('workflow.fieldModel', '模型覆盖（可选）') }}</span>
                  <HcClearableField>
                    <input v-model="editForm.config.model" class="wfp-input" :placeholder="t('workflow.fieldModelHint', '留空跟随智能路由')" />
                  </HcClearableField>
                </label>
              </template>

              <!-- tool：工具 -->
              <template v-if="editingType === 'tool'">
                <label class="wfp-field">
                  <span class="wfp-field__label">{{ t('workflow.fieldTool', '工具名称') }}</span>
                  <HcClearableField>
                    <input v-model="editForm.config.tool" class="wfp-input" :placeholder="t('workflow.fieldToolHint', '如 media_generate / send_message')" />
                  </HcClearableField>
                </label>
                <label class="wfp-field">
                  <span class="wfp-field__label">{{ t('workflow.fieldArgs', '参数（JSON，可选）') }}</span>
                  <HcClearableField>
                    <textarea v-model="editForm.config.args" rows="3" class="wfp-input wfp-textarea" placeholder='{"key": "value"}' />
                  </HcClearableField>
                </label>
              </template>

              <p v-if="editingType === 'output'" class="wfp-field__note">{{ t('workflow.outputNote', '输出步骤直接透传上一步结果作为工作流最终输出。') }}</p>
            </div>
            <div class="wfp-modal__foot">
              <button class="hc-btn" @click="closeEditStep">{{ t('common.cancel') }}</button>
              <button class="hc-btn hc-btn-primary" @click="saveStep">{{ t('common.save') }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

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
.wfp { padding: 18px 22px; }

/* 空状态 */
.wfp-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 64px 20px; gap: 8px; }
.wfp-empty__ic { width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; background: var(--hc-accent-subtle); color: var(--hc-accent); margin-bottom: 6px; }
.wfp-empty__title { font-size: 15px; font-weight: 600; color: var(--hc-text-primary); margin: 0; }
.wfp-empty__desc { font-size: 13px; color: var(--hc-text-secondary); margin: 0; max-width: 360px; }
.wfp-empty__cta { margin-top: 12px; }

/* 工作流切换 chip */
.wfp-switch { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.wfp-chip { padding: 6px 12px; border-radius: 9px; border: 1px solid var(--hc-border); background: var(--hc-bg-card); color: var(--hc-text-secondary); font: inherit; font-size: 12px; cursor: pointer; transition: border-color 0.15s var(--hc-ease-out), color 0.15s var(--hc-ease-out); }
.wfp-chip:hover { border-color: var(--hc-border-hl); }
.wfp-chip--on { border-color: var(--hc-accent); color: var(--hc-accent); background: var(--hc-accent-subtle); }

/* 头部 */
.wfp-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 4px; }
.wfp-head__actions { display: flex; gap: 8px; flex-shrink: 0; }
.wfp-name-input { font-size: 14px; font-weight: 600; color: var(--hc-text-primary); background: transparent; border: 1px solid transparent; border-radius: 7px; padding: 4px 8px; margin-left: -8px; width: 260px; max-width: 100%; transition: border-color 0.15s; }
.wfp-name-input:hover { border-color: var(--hc-border); }
.wfp-name-input:focus { border-color: var(--hc-accent); outline: none; background: var(--hc-bg-input); }
.wfp-head__sub { font-size: 12px; color: var(--hc-text-secondary); margin: 2px 0 0 0; }
.wfp-spin { animation: wfp-spin 0.8s linear infinite; }
@keyframes wfp-spin { to { transform: rotate(360deg); } }

/* 线性画布 */
.wf { max-width: 600px; margin-top: 18px; display: flex; flex-direction: column; align-items: flex-start; }
.wf-node { display: flex; align-items: center; gap: 13px; width: 100%; padding: 13px 15px; border: 0.5px solid var(--hc-border); border-radius: 13px; background: var(--hc-bg-card); box-shadow: var(--hc-shadow-sm); transition: border-color 0.2s var(--hc-ease-out), box-shadow 0.2s var(--hc-ease-out), transform 0.15s var(--hc-ease-out); }
.wf-node:hover { border-color: var(--hc-border-hl); box-shadow: var(--hc-shadow-md); transform: translateY(-1px); }
.wf-node--running { border-color: var(--hc-accent); }
.wf-node--completed { border-color: var(--hc-spring, #10b981); }
.wf-node--failed { border-color: var(--hc-amber, #ef4444); }
.wf-ic { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; flex-shrink: 0; color: var(--hc-text-secondary); background: var(--hc-bg-input); }
.wf-node.trigger .wf-ic { background: var(--hc-accent-subtle); color: var(--hc-accent); }
.wf-main { flex: 1; min-width: 0; }
.wf-k { font-size: 11px; color: var(--hc-text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
.wf-t { font-size: 13.5px; font-weight: 600; color: var(--hc-text-primary); margin-top: 1px; }
.wf-d { font-size: 12px; color: var(--hc-text-secondary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px; }
.wf-badge { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0; }
.wf-badge--run { color: var(--hc-accent); }
.wf-badge--ok { color: var(--hc-spring, #10b981); }
.wf-badge--fail { color: var(--hc-amber, #ef4444); }
.wf-ops { display: flex; gap: 2px; flex-shrink: 0; }
.wf-op { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; border: none; background: transparent; color: var(--hc-text-muted); cursor: pointer; transition: background 0.15s, color 0.15s; }
.wf-op:hover:not(:disabled) { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.wf-op:disabled { opacity: 0.3; cursor: not-allowed; }
.wf-op--danger:hover:not(:disabled) { color: var(--hc-amber, #ef4444); }
.wf-link { width: 2px; height: 20px; background: var(--hc-border); margin-left: 33px; }
.wf-addwrap { position: relative; margin-left: 14px; }
.wf-add { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; border: 1px dashed var(--hc-border); background: transparent; color: var(--hc-text-secondary); font: inherit; font-size: 13px; cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.wf-add:hover { border-color: var(--hc-accent); color: var(--hc-accent); }
.wf-addmenu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 10; display: flex; flex-direction: column; min-width: 150px; padding: 6px; border-radius: 11px; border: 1px solid var(--hc-border); background: var(--hc-bg-elevated); box-shadow: var(--hc-shadow-md); }
.wf-addmenu button { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 7px; border: none; background: transparent; color: var(--hc-text-primary); font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.wf-addmenu button:hover { background: var(--hc-bg-hover); }

/* 运行结果 */
.wfp-run { max-width: 600px; margin-top: 18px; border-radius: 12px; border: 1px solid var(--hc-border); background: var(--hc-bg-card); overflow: hidden; }
.wfp-run--failed { border-color: var(--hc-amber, #ef4444); }
/* 引擎未启用 = 中性提示（非失败红），用 muted 文案告知功能不可用 */
.wfp-run--unavailable { border-color: var(--hc-border); }
.wfp-run__head { display: flex; align-items: center; gap: 7px; padding: 10px 14px; font-size: 13px; font-weight: 600; color: var(--hc-text-primary); border-bottom: 1px solid var(--hc-border); }
.wfp-run--failed .wfp-run__head { color: var(--hc-amber, #ef4444); }
.wfp-run--unavailable .wfp-run__head { color: var(--hc-text-muted); }
.wfp-run__out { margin: 0; padding: 12px 14px; font-size: 12.5px; line-height: 1.55; color: var(--hc-text-secondary); white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; font-family: inherit; }

.wfp-note { font-size: 12px; color: var(--hc-text-muted); margin-top: 22px; max-width: 600px; line-height: 1.6; }
.wfp-note :deep(b) { color: var(--hc-text-secondary); }

/* 编辑弹层 */
.wfp-modal-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,0.45); backdrop-filter: blur(3px); }
.wfp-modal { width: 100%; max-width: 460px; border-radius: 16px; border: 1px solid var(--hc-border); background: var(--hc-bg-elevated); display: flex; flex-direction: column; overflow: hidden; max-height: 88vh; }
.wfp-modal__head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--hc-border); }
.wfp-modal__title { font-size: 15px; font-weight: 600; margin: 0; color: var(--hc-text-primary); }
.wfp-modal__close { padding: 4px; border: none; background: transparent; color: var(--hc-text-muted); cursor: pointer; border-radius: 6px; }
.wfp-modal__close:hover { background: var(--hc-bg-hover); }
.wfp-modal__body { padding: 16px 18px; display: flex; flex-direction: column; gap: 13px; overflow-y: auto; }
.wfp-field { display: flex; flex-direction: column; gap: 5px; }
.wfp-field__label { font-size: 13px; font-weight: 500; color: var(--hc-text-secondary); }
.wfp-field__note { font-size: 12px; color: var(--hc-text-muted); margin: 0; }
.wfp-input { width: 100%; border: 1px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary); border-radius: 9px; padding: 8px 11px; font: inherit; font-size: 13px; outline: none; transition: border-color 0.15s; }
.wfp-input:focus { border-color: var(--hc-accent); }
.wfp-textarea { resize: vertical; font-family: inherit; }
.wfp-modal__foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--hc-border); }
</style>
