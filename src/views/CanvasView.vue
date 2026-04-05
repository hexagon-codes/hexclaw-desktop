<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plus, ZoomIn, ZoomOut, Maximize2, Trash2,
  Bot, Wrench, GitBranch, ArrowRightCircle,
  X, Settings2, BookTemplate, Loader2, FolderOpen,
  Save, Play, CircleCheck, CircleX, Clock,
  ChevronDown, ChevronUp, AlertTriangle,
} from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import TemplateGallery from '@/components/canvas/TemplateGallery.vue'
import type { WorkflowTemplate } from '@/components/canvas/TemplateGallery.vue'
import { useCanvasStore } from '@/stores/canvas'
import type { CanvasNode, Workflow } from '@/types'

const { t } = useI18n()
const store = useCanvasStore()

// ─── 本地 UI 状态 ──────────────────────────────────────
const zoom = ref(1)
const showAddMenu = ref(false)
const selectedNodeId = ref<string | null>(null)
const draggingNode = ref<string | null>(null)
const dragOffset = ref({ x: 0, y: 0 })
const showTemplateGallery = ref(false)
const showPanelList = ref(false)
const showSaveDialog = ref(false)
const showWorkflowList = ref(false)
const saveName = ref('')
const saveDescription = ref('')
const showResultPanel = ref(false)
const validationErrors = ref<string[]>([])
const savingWorkflow = ref(false)
const runningWorkflow = ref(false)

// ─── 节点配置面板：新配置项输入 ─────────────────────────
const newConfigKey = ref('')
const newConfigValue = ref('')

const nodeTypes = computed(() => [
  { type: 'agent' as const, label: t('canvas.agent'), icon: Bot, color: '#3b82f6' },
  { type: 'tool' as const, label: t('canvas.tool'), icon: Wrench, color: '#10b981' },
  { type: 'condition' as const, label: t('canvas.condition'), icon: GitBranch, color: '#f59e0b' },
  { type: 'output' as const, label: t('canvas.output'), icon: ArrowRightCircle, color: '#8b5cf6' },
])

const selectedNode = computed(() =>
  selectedNodeId.value ? store.nodes.find((n) => n.id === selectedNodeId.value) ?? null : null,
)

// ─── 运行状态显示 ─────────────────────────────────────
const runStatusInfo = computed(() => {
  switch (store.runStatus) {
    case 'running': return { label: t('canvas.runRunning'), color: '#f59e0b', icon: Loader2, spin: true }
    case 'completed': return { label: t('canvas.runCompleted'), color: '#10b981', icon: CircleCheck, spin: false }
    case 'failed': return { label: t('canvas.runFailed'), color: '#ef4444', icon: CircleX, spin: false }
    case 'pending': return { label: t('canvas.runPending'), color: '#6b7280', icon: Clock, spin: false }
    default: return null
  }
})

// ─── 生命周期 ──────────────────────────────────────────
onMounted(() => {
  store.loadPanels()
  store.loadWorkflows()
})

// ─── 节点操作 ──────────────────────────────────────────
function addNode(type: CanvasNode['type']) {
  const nodeType = nodeTypes.value.find((n) => n.type === type)
  const node: CanvasNode = {
    id: `node-${crypto.randomUUID().slice(0, 8)}`,
    type,
    label: nodeType?.label || type,
    x: 200 + Math.random() * 300,
    y: 100 + Math.random() * 200,
    config: {},
  }
  store.addNode(node)
  showAddMenu.value = false
}

function removeNode(id: string) {
  store.removeNode(id)
  if (selectedNodeId.value === id) selectedNodeId.value = null
}

function clearCanvas() {
  store.clearCanvas()
  selectedNodeId.value = null
}

// ─── 缩放 ─────────────────────────────────────────────
function zoomIn() { zoom.value = Math.min(zoom.value + 0.1, 2) }
function zoomOut() { zoom.value = Math.max(zoom.value - 0.1, 0.3) }
function fitView() { zoom.value = 1 }

function nodeColor(type: string): string {
  return nodeTypes.value.find((n) => n.type === type)?.color || '#6b7280'
}

// ─── 拖拽 ─────────────────────────────────────────────
function startDrag(nodeId: string, e: MouseEvent) {
  draggingNode.value = nodeId
  const node = store.nodes.find((n) => n.id === nodeId)
  if (node) {
    dragOffset.value = { x: e.clientX - node.x * zoom.value, y: e.clientY - node.y * zoom.value }
  }
  selectedNodeId.value = nodeId
}

function onDrag(e: MouseEvent) {
  if (!draggingNode.value) return
  const node = store.nodes.find((n) => n.id === draggingNode.value)
  if (node) {
    store.updateNode(node.id, {
      x: (e.clientX - dragOffset.value.x) / zoom.value,
      y: (e.clientY - dragOffset.value.y) / zoom.value,
    })
  }
}

function stopDrag() {
  if (draggingNode.value) {
    // Clear selection so the next click won't create an unintended edge
    selectedNodeId.value = null
  }
  draggingNode.value = null
}

// ─── 连线 ─────────────────────────────────────────────
function handleNodeClick(id: string) {
  if (selectedNodeId.value && selectedNodeId.value !== id) {
    const edgeId = `edge-${crypto.randomUUID().slice(0, 8)}`
    store.addEdge({ id: edgeId, from: selectedNodeId.value, to: id })
    selectedNodeId.value = null
  } else {
    selectedNodeId.value = id
  }
}

// ─── 面板 ─────────────────────────────────────────────
async function loadPanel(id: string) {
  await store.loadPanel(id)
  showPanelList.value = false
}

// ─── 节点配置 ─────────────────────────────────────────
function updateNodeLabel(label: string) {
  if (selectedNodeId.value) {
    store.updateNode(selectedNodeId.value, { label })
  }
}

function addNodeConfig() {
  if (!selectedNodeId.value || !newConfigKey.value.trim()) return
  const node = store.nodes.find((n) => n.id === selectedNodeId.value)
  if (node) {
    const config = { ...node.config, [newConfigKey.value.trim()]: newConfigValue.value }
    store.updateNode(selectedNodeId.value, { config })
    newConfigKey.value = ''
    newConfigValue.value = ''
  }
}

function removeNodeConfig(key: string) {
  if (!selectedNodeId.value) return
  const node = store.nodes.find((n) => n.id === selectedNodeId.value)
  if (node?.config) {
    const config = { ...node.config }
    delete config[key]
    store.updateNode(selectedNodeId.value, { config })
  }
}

function importTemplate(tpl: WorkflowTemplate) {
  store.clearCanvas()
  for (const n of tpl.nodes) {
    store.addNode({ id: n.id, type: n.type as CanvasNode['type'], label: n.label, x: n.x, y: n.y, config: n.config })
  }
  for (const e of tpl.edges) {
    store.addEdge({ id: e.id, from: e.from, to: e.to })
  }
  showTemplateGallery.value = false
  selectedNodeId.value = null
}

// ─── 工作流保存/加载/运行 ──────────────────────────────
function openSaveDialog() {
  saveName.value = ''
  saveDescription.value = ''
  showSaveDialog.value = true
}

async function handleSave() {
  if (savingWorkflow.value) return
  if (!saveName.value.trim()) return
  savingWorkflow.value = true
  try {
    await store.saveWorkflow(saveName.value.trim(), saveDescription.value.trim() || undefined)
    showSaveDialog.value = false
  } finally {
    savingWorkflow.value = false
  }
}

function handleLoadWorkflow(workflow: Workflow) {
  store.loadWorkflowToCanvas(workflow)
  showWorkflowList.value = false
}

async function handleDeleteWorkflow(id: string) {
  if (!confirm(t('canvas.confirmDelete'))) return
  await store.deleteWorkflow(id)
}

async function handleRun() {
  if (runningWorkflow.value) return
  // Validate before running
  const errors = store.validateWorkflow()
  validationErrors.value = errors
  if (errors.length > 0) return

  showResultPanel.value = false
  runningWorkflow.value = true
  try {
    await store.runWorkflow()
    // Show result panel when done
    if (store.runResult) {
      showResultPanel.value = true
    }
  } finally {
    runningWorkflow.value = false
  }
}

/** Get node execution status color ring */
function nodeRunBorder(nodeId: string): string {
  const status = store.nodeRunStatus[nodeId]
  if (status === 'running') return '#f59e0b'
  if (status === 'completed') return '#10b981'
  if (status === 'failed') return '#ef4444'
  return ''
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('canvas.title')" :description="t('canvas.description')">
      <template #actions>
        <div class="flex items-center gap-1">
          <!-- 缩放控件 -->
          <button class="p-1.5 rounded-md hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-secondary)' }" :title="t('canvas.zoomOut')" @click="zoomOut">
            <ZoomOut :size="16" />
          </button>
          <span class="text-xs tabular-nums w-10 text-center" :style="{ color: 'var(--hc-text-muted)' }">
            {{ Math.round(zoom * 100) }}%
          </span>
          <button class="p-1.5 rounded-md hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-secondary)' }" :title="t('canvas.zoomIn')" @click="zoomIn">
            <ZoomIn :size="16" />
          </button>
          <button class="p-1.5 rounded-md hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-secondary)' }" :title="t('canvas.fitView')" @click="fitView">
            <Maximize2 :size="16" />
          </button>
          <div class="w-px h-4 mx-1" :style="{ background: 'var(--hc-border)' }" />

          <button class="p-1.5 rounded-md hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-secondary)' }" :title="t('canvas.clear')" @click="clearCanvas">
            <Trash2 :size="16" />
          </button>
          <button class="p-1.5 rounded-md hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-secondary)' }" :title="t('canvasExtra.templateGallery')" @click="showTemplateGallery = true">
            <BookTemplate :size="16" />
          </button>
          <button class="p-1.5 rounded-md hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-secondary)' }" :title="t('canvasExtra.panelList')" @click="showPanelList = !showPanelList">
            <FolderOpen :size="16" />
          </button>

          <div class="w-px h-4 mx-1" :style="{ background: 'var(--hc-border)' }" />

          <!-- 工作流操作按钮 -->
          <div class="relative">
            <button
              class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-white/5"
              :style="{ color: 'var(--hc-text-secondary)' }"
              :title="t('canvas.workflows')"
              @click="showWorkflowList = !showWorkflowList"
            >
              <FolderOpen :size="14" />
              {{ t('canvas.loadWorkflow') }}
            </button>
            <!-- 工作流下拉列表 -->
            <div
              v-if="showWorkflowList"
              class="absolute right-0 top-full mt-1 w-64 rounded-lg border shadow-lg z-20 max-h-72 overflow-y-auto"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="px-3 py-2 border-b text-xs font-medium" :style="{ color: 'var(--hc-text-primary)', borderColor: 'var(--hc-border)' }">
                {{ t('canvas.workflows') }}
              </div>
              <div v-if="store.savedWorkflows.length === 0" class="px-3 py-4 text-center">
                <p class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('canvas.noWorkflows') }}</p>
              </div>
              <div v-else>
                <div
                  v-for="wf in store.savedWorkflows"
                  :key="wf.id"
                  class="flex items-center gap-2 px-3 py-2 border-b hover:bg-white/5 transition-colors cursor-pointer"
                  :style="{ borderColor: 'var(--hc-border)' }"
                  @click="handleLoadWorkflow(wf)"
                >
                  <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">{{ wf.name }}</div>
                    <div class="text-[10px] mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">
                      {{ wf.nodes.length }} 节点 · {{ wf.edges.length }} 连接
                    </div>
                  </div>
                  <button
                    class="p-1 rounded hover:bg-white/10 transition-colors flex-shrink-0"
                    :style="{ color: 'var(--hc-text-muted)' }"
                    @click.stop="handleDeleteWorkflow(wf.id)"
                  >
                    <Trash2 :size="12" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <button
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-white/5"
            :style="{ color: store.nodes.length > 0 && !savingWorkflow ? 'var(--hc-text-secondary)' : 'var(--hc-text-muted)' }"
            :disabled="store.nodes.length === 0 || savingWorkflow"
            :title="t('canvas.save')"
            @click="openSaveDialog"
          >
            <Save :size="14" />
            {{ t('canvas.save') }}
          </button>

          <button
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
            :style="{
              background: store.nodes.length > 0 && store.runStatus !== 'running' && !runningWorkflow ? 'var(--hc-accent)' : 'var(--hc-text-muted)',
              opacity: store.nodes.length > 0 && store.runStatus !== 'running' && !runningWorkflow ? 1 : 0.5,
            }"
            :disabled="store.nodes.length === 0 || store.runStatus === 'running' || runningWorkflow"
            :title="t('canvas.run')"
            @click="handleRun"
          >
            <Loader2 v-if="store.runStatus === 'running' || runningWorkflow" :size="14" class="animate-spin" />
            <Play v-else :size="14" />
            {{ t('canvas.run') }}
          </button>
        </div>

        <!-- 添加节点 -->
        <div class="relative">
          <button class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white" :style="{ background: 'var(--hc-accent)' }" @click="showAddMenu = !showAddMenu">
            <Plus :size="16" />
            {{ t('canvas.addNode') }}
          </button>
          <div v-if="showAddMenu" class="absolute right-0 top-full mt-1 w-48 rounded-lg border shadow-lg z-20" :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }">
            <button v-for="nt in nodeTypes" :key="nt.type" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-primary)' }" @click="addNode(nt.type)">
              <component :is="nt.icon" :size="14" :style="{ color: nt.color }" />
              {{ nt.label }}
            </button>
          </div>
        </div>
      </template>
    </PageHeader>

    <div class="flex-1 flex overflow-hidden">
      <!-- 面板列表侧栏 -->
      <div v-if="showPanelList" class="w-60 flex-shrink-0 border-r flex flex-col" :style="{ background: 'var(--hc-bg-sidebar)', borderColor: 'var(--hc-border)' }">
        <div class="flex items-center justify-between px-3 py-2 border-b" :style="{ borderColor: 'var(--hc-border)' }">
          <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('canvasExtra.panels') }}</span>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="store.loading" class="flex items-center justify-center py-8">
            <Loader2 :size="20" class="animate-spin" :style="{ color: 'var(--hc-text-muted)' }" />
          </div>
          <div v-else-if="store.panels.length === 0" class="text-center py-8">
            <p class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('canvasExtra.noPanel') }}</p>
          </div>
          <div v-else>
            <div
              v-for="panel in store.panels"
              :key="panel.id"
              class="px-3 py-2 border-b cursor-pointer hover:bg-white/5 transition-colors"
              :style="{ borderColor: 'var(--hc-border)' }"
              @click="loadPanel(panel.id)"
            >
              <span class="text-xs font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
                {{ panel.title }}
              </span>
              <div class="text-[10px] mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">
                {{ panel.component_count }} 组件 · v{{ panel.version }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 画布区域 -->
      <div
        class="flex-1 relative overflow-hidden cursor-crosshair"
        :style="{ background: 'var(--hc-bg-main)' }"
        @mousemove="onDrag"
        @mouseup="stopDrag"
        @click.self="selectedNodeId = null; showAddMenu = false; showWorkflowList = false"
      >
        <div class="absolute inset-0 opacity-5" style="background-image: radial-gradient(circle, currentColor 1px, transparent 1px); background-size: 24px 24px;" />

        <div :style="{ transform: `scale(${zoom})`, transformOrigin: '0 0' }" class="absolute inset-0">
          <!-- 连接线 (可点击删除) -->
          <svg class="absolute inset-0 w-full h-full" style="overflow: visible; z-index: 1;">
            <g v-for="edge in store.edges" :key="edge.id">
              <!-- 不可见的宽线用于扩大点击区域 -->
              <line
                :x1="(store.nodes.find(n => n.id === edge.from)?.x ?? 0) + 80"
                :y1="(store.nodes.find(n => n.id === edge.from)?.y ?? 0) + 24"
                :x2="(store.nodes.find(n => n.id === edge.to)?.x ?? 0) + 80"
                :y2="(store.nodes.find(n => n.id === edge.to)?.y ?? 0) + 24"
                stroke="transparent"
                stroke-width="12"
                style="cursor: pointer;"
                @click.stop="store.removeEdge(edge.id)"
              />
              <!-- 可见的虚线 -->
              <line
                :x1="(store.nodes.find(n => n.id === edge.from)?.x ?? 0) + 80"
                :y1="(store.nodes.find(n => n.id === edge.from)?.y ?? 0) + 24"
                :x2="(store.nodes.find(n => n.id === edge.to)?.x ?? 0) + 80"
                :y2="(store.nodes.find(n => n.id === edge.to)?.y ?? 0) + 24"
                stroke="var(--hc-border)"
                stroke-width="2"
                stroke-dasharray="6 3"
                style="pointer-events: none;"
              />
            </g>
          </svg>

          <!-- 节点 -->
          <div
            v-for="node in store.nodes"
            :key="node.id"
            class="absolute rounded-xl border-2 px-4 py-3 min-w-[160px] cursor-move select-none transition group"
            :style="{
              left: node.x + 'px',
              top: node.y + 'px',
              background: 'var(--hc-bg-card)',
              borderColor: nodeRunBorder(node.id) || (selectedNodeId === node.id ? nodeColor(node.type) : 'var(--hc-border)'),
              boxShadow: nodeRunBorder(node.id)
                ? `0 0 0 3px ${nodeRunBorder(node.id)}30`
                : selectedNodeId === node.id ? `0 0 0 2px ${nodeColor(node.type)}40` : 'none',
            }"
            @mousedown.stop="startDrag(node.id, $event)"
            @click.stop="handleNodeClick(node.id)"
          >
            <div class="flex items-center gap-2 mb-1">
              <div class="w-6 h-6 rounded-md flex items-center justify-center relative" :style="{ background: nodeColor(node.type) + '20', color: nodeColor(node.type) }">
                <Loader2 v-if="store.nodeRunStatus[node.id] === 'running'" :size="12" class="animate-spin" />
                <CircleCheck v-else-if="store.nodeRunStatus[node.id] === 'completed'" :size="12" style="color: #10b981" />
                <CircleX v-else-if="store.nodeRunStatus[node.id] === 'failed'" :size="12" style="color: #ef4444" />
                <component v-else :is="nodeTypes.find(t => t.type === node.type)?.icon || Bot" :size="12" />
              </div>
              <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ node.label }}</span>
              <button class="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-opacity" :style="{ color: 'var(--hc-text-muted)' }" @click.stop="removeNode(node.id)">
                <Trash2 :size="10" />
              </button>
            </div>
            <div class="flex items-center gap-1.5 text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
              <span>{{ node.type }}</span>
              <span v-if="store.nodeRunStatus[node.id] === 'running'" class="text-amber-400">{{ t('canvas.nodeRunning') }}</span>
              <span v-else-if="store.nodeRunStatus[node.id] === 'completed'" class="text-emerald-400">{{ t('canvas.nodeDone') }}</span>
            </div>
          </div>
        </div>

        <!-- 空状态 - 引导创建 -->
        <div v-if="store.nodes.length === 0" class="absolute inset-0 flex items-center justify-center">
          <div class="text-center max-w-sm">
            <div class="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center" :style="{ background: 'var(--hc-accent-subtle)' }">
              <GitBranch :size="28" :style="{ color: 'var(--hc-accent)' }" />
            </div>
            <p class="text-sm font-medium mb-1" :style="{ color: 'var(--hc-text-primary)' }">{{ t('canvasExtra.createFirst') }}</p>
            <p class="text-xs mb-4" :style="{ color: 'var(--hc-text-muted)' }">{{ t('canvasExtra.createFirstDesc') }}</p>
            <div class="flex items-center justify-center gap-2">
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-white/5"
                :style="{ color: 'var(--hc-text-secondary)', borderColor: 'var(--hc-border)' }"
                @click="showTemplateGallery = true"
              >
                <BookTemplate :size="14" />
                {{ t('canvasExtra.browseTemplates') }}
              </button>
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
                :style="{ background: 'var(--hc-accent)' }"
                @click="showAddMenu = true"
              >
                <Plus :size="14" />
                {{ t('canvas.addNode') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 验证错误提示 -->
        <div
          v-if="validationErrors.length > 0"
          class="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 py-2 rounded-lg border shadow-lg"
          style="background: #ef444418; border-color: #ef444440;"
        >
          <AlertTriangle :size="14" style="color: #ef4444; flex-shrink: 0;" />
          <div class="flex flex-col gap-0.5">
            <span v-for="err in validationErrors" :key="err" class="text-xs" style="color: #ef4444;">
              {{ t(`canvas.${err}`) }}
            </span>
          </div>
          <button class="ml-2 p-0.5 rounded hover:bg-white/10" style="color: #ef4444;" @click="validationErrors = []">
            <X :size="12" />
          </button>
        </div>

        <!-- 底部状态栏 -->
        <div
          class="absolute left-0 right-0 flex items-center gap-4 px-4 py-1.5 text-[10px] border-t"
          :style="{
            background: 'var(--hc-bg-sidebar)',
            borderColor: 'var(--hc-border)',
            color: 'var(--hc-text-muted)',
            bottom: showResultPanel && store.runResult ? '200px' : '0',
          }"
        >
          <span>{{ t('canvas.nodes') }}: {{ store.nodes.length }}</span>
          <span>{{ t('canvas.connections') }}: {{ store.edges.length }}</span>

          <!-- 运行状态指示 -->
          <template v-if="runStatusInfo">
            <div class="w-px h-3" :style="{ background: 'var(--hc-border)' }" />
            <div class="flex items-center gap-1.5">
              <component :is="runStatusInfo.icon" :size="11" :class="{ 'animate-spin': runStatusInfo.spin }" :style="{ color: runStatusInfo.color }" />
              <span :style="{ color: runStatusInfo.color }">{{ runStatusInfo.label }}</span>
              <span v-if="store.runOutput" class="ml-1 truncate max-w-[200px]" :style="{ color: 'var(--hc-text-muted)' }">
                — {{ store.runOutput }}
              </span>
            </div>
          </template>

          <div class="flex-1" />
          <button
            v-if="store.runResult"
            class="flex items-center gap-1 hover:text-white transition-colors"
            @click="showResultPanel = !showResultPanel"
          >
            <component :is="showResultPanel ? ChevronDown : ChevronUp" :size="11" />
            {{ t('canvas.resultPanel') }}
          </button>
          <span v-if="selectedNodeId" class="text-blue-400">
            {{ store.nodes.find(n => n.id === selectedNodeId)?.label }}
          </span>
        </div>

        <!-- 执行结果面板 -->
        <div
          v-if="showResultPanel && store.runResult"
          class="absolute bottom-0 left-0 right-0 h-[200px] border-t flex flex-col z-10"
          :style="{ background: 'var(--hc-bg-sidebar)', borderColor: 'var(--hc-border)' }"
        >
          <div class="flex items-center justify-between px-4 py-2 border-b" :style="{ borderColor: 'var(--hc-border)' }">
            <div class="flex items-center gap-2">
              <component
                :is="store.runStatus === 'completed' ? CircleCheck : CircleX"
                :size="14"
                :style="{ color: store.runStatus === 'completed' ? '#10b981' : '#ef4444' }"
              />
              <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                {{ t('canvas.resultPanel') }}
              </span>
              <span v-if="store.runResult.finishedAt" class="text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
                {{ new Date(store.runResult.finishedAt).toLocaleTimeString() }}
              </span>
            </div>
            <button
              class="p-1 rounded hover:bg-white/5 transition-colors"
              :style="{ color: 'var(--hc-text-muted)' }"
              @click="showResultPanel = false"
            >
              <ChevronDown :size="14" />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-4">
            <div v-if="store.runResult.output" class="mb-2">
              <div class="text-[10px] font-medium mb-1" :style="{ color: 'var(--hc-text-muted)' }">{{ t('canvas.executionOutput') }}</div>
              <pre class="text-xs p-3 rounded-lg whitespace-pre-wrap" :style="{ background: 'var(--hc-bg-main)', color: 'var(--hc-text-secondary)' }">{{ store.runResult.output }}</pre>
            </div>
            <div v-if="store.runResult.error" class="mb-2">
              <div class="text-[10px] font-medium mb-1" style="color: #ef4444;">{{ t('canvas.executionError') }}</div>
              <pre class="text-xs p-3 rounded-lg whitespace-pre-wrap" style="background: #ef444410; color: #ef4444;">{{ store.runResult.error }}</pre>
            </div>
          </div>
        </div>
      </div>

      <!-- 节点配置侧栏 -->
      <div v-if="selectedNode" class="w-60 flex-shrink-0 border-l flex flex-col" :style="{ background: 'var(--hc-bg-sidebar)', borderColor: 'var(--hc-border)' }">
        <div class="flex items-center justify-between px-3 py-2 border-b" :style="{ borderColor: 'var(--hc-border)' }">
          <div class="flex items-center gap-1.5">
            <Settings2 :size="12" :style="{ color: 'var(--hc-text-muted)' }" />
            <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('canvas.nodeConfig') }}</span>
          </div>
          <button class="p-1 rounded hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-muted)' }" @click="selectedNodeId = null">
            <X :size="12" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-3 space-y-3">
          <div>
            <label class="text-[10px] font-medium block mb-1" :style="{ color: 'var(--hc-text-muted)' }">{{ t('canvas.nodeLabel') }}</label>
            <input :value="selectedNode.label" @input="updateNodeLabel(($event.target as HTMLInputElement).value)" class="w-full px-2 py-1 rounded text-xs border outline-none transition-colors" :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" :placeholder="t('canvas.nodeLabelPlaceholder')" />
          </div>
          <div>
            <label class="text-[10px] font-medium block mb-1" :style="{ color: 'var(--hc-text-muted)' }">{{ t('canvas.nodeType') }}</label>
            <div class="w-full px-2 py-1 rounded text-xs border flex items-center gap-1.5" :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }">
              <div class="w-3 h-3 rounded" :style="{ background: nodeColor(selectedNode.type) }" />
              {{ selectedNode.type }}
            </div>
          </div>
          <div>
            <label class="text-[10px] font-medium block mb-1" :style="{ color: 'var(--hc-text-muted)' }">Config</label>
            <div v-if="selectedNode.config && Object.keys(selectedNode.config).length > 0" class="space-y-1 mb-2">
              <div v-for="(val, key) in selectedNode.config" :key="String(key)" class="flex items-center gap-1 text-[10px] px-2 py-1 rounded group" :style="{ background: 'var(--hc-bg-main)', color: 'var(--hc-text-secondary)' }">
                <span class="font-medium">{{ key }}:</span>
                <span class="flex-1 truncate">{{ val }}</span>
                <button class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-opacity" :style="{ color: 'var(--hc-text-muted)' }" @click="removeNodeConfig(String(key))">
                  <X :size="8" />
                </button>
              </div>
            </div>
            <div class="flex gap-1">
              <input v-model="newConfigKey" class="flex-1 px-1.5 py-0.5 rounded text-[10px] border outline-none" :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" :placeholder="t('canvas.configKey')" />
              <input v-model="newConfigValue" class="flex-1 px-1.5 py-0.5 rounded text-[10px] border outline-none" :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" :placeholder="t('canvas.configValue')" @keyup.enter="addNodeConfig" />
              <button class="px-1.5 py-0.5 rounded text-[10px] hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-accent)' }" @click="addNodeConfig">
                <Plus :size="10" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 模板库 -->
    <TemplateGallery v-if="showTemplateGallery" @select="importTemplate" @close="showTemplateGallery = false" />

    <!-- 保存工作流对话框 -->
    <Teleport to="body">
      <div v-if="showSaveDialog" class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.45); backdrop-filter: blur(4px);" @click.self="showSaveDialog = false">
        <div class="w-full max-w-sm rounded-xl border shadow-lg p-5" :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }">
          <h3 class="text-sm font-semibold mb-4" :style="{ color: 'var(--hc-text-primary)' }">{{ t('canvas.saveDialog') }}</h3>
          <div class="space-y-3">
            <div>
              <label class="text-xs font-medium block mb-1" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('canvas.workflowName') }}</label>
              <input
                v-model="saveName"
                type="text"
                class="w-full px-3 py-2 rounded-lg text-sm border outline-none transition-colors"
                :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                :placeholder="t('canvas.workflowNamePlaceholder')"
                @keyup.enter="handleSave"
              />
            </div>
            <div>
              <label class="text-xs font-medium block mb-1" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('canvas.workflowDescription') }}</label>
              <input
                v-model="saveDescription"
                type="text"
                class="w-full px-3 py-2 rounded-lg text-sm border outline-none transition-colors"
                :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                :placeholder="t('canvas.workflowDescPlaceholder')"
              />
            </div>
          </div>
          <div class="flex justify-end gap-2 mt-4">
            <button
              class="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-white/5"
              :style="{ color: 'var(--hc-text-secondary)', borderColor: 'var(--hc-border)' }"
              @click="showSaveDialog = false"
            >
              {{ t('canvas.cancel') }}
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
              :style="{ background: saveName.trim() && !savingWorkflow ? 'var(--hc-accent)' : 'var(--hc-text-muted)', opacity: saveName.trim() && !savingWorkflow ? 1 : 0.5 }"
              :disabled="!saveName.trim() || savingWorkflow"
              @click="handleSave"
            >
              <Loader2 v-if="store.loading || savingWorkflow" :size="12" class="inline animate-spin mr-1" />
              {{ t('canvas.save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
