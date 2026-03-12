<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plus, Play, Save, ZoomIn, ZoomOut, Maximize2, Trash2,
  Bot, Wrench, GitBranch, ArrowRightCircle, Loader2,
  FolderOpen, FilePlus, X, Settings2, CheckCircle2, AlertCircle,
} from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import { useCanvasStore } from '@/stores/canvas'
import type { CanvasNode } from '@/types'

const { t } = useI18n()
const store = useCanvasStore()

// ─── 本地 UI 状态 ──────────────────────────────────────
const zoom = ref(1)
const showAddMenu = ref(false)
const selectedNodeId = ref<string | null>(null)
const draggingNode = ref<string | null>(null)
const dragOffset = ref({ x: 0, y: 0 })
const showSaveDialog = ref(false)
const showWorkflowList = ref(false)
const saveName = ref('')
const saveDescription = ref('')

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

// ─── 生命周期 ──────────────────────────────────────────
onMounted(() => {
  store.loadWorkflows()
})

// ─── 节点操作 ──────────────────────────────────────────
function addNode(type: CanvasNode['type']) {
  const nodeType = nodeTypes.value.find((n) => n.type === type)
  const node: CanvasNode = {
    id: `node-${Date.now()}`,
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
function zoomIn() {
  zoom.value = Math.min(zoom.value + 0.1, 2)
}

function zoomOut() {
  zoom.value = Math.max(zoom.value - 0.1, 0.3)
}

function fitView() {
  zoom.value = 1
}

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
  draggingNode.value = null
}

// ─── 连线 ─────────────────────────────────────────────
function handleNodeClick(id: string) {
  if (selectedNodeId.value && selectedNodeId.value !== id) {
    const edgeId = `edge-${Date.now()}`
    store.addEdge({ id: edgeId, from: selectedNodeId.value, to: id })
    selectedNodeId.value = null
  } else {
    selectedNodeId.value = id
  }
}

// ─── 保存 ─────────────────────────────────────────────
function openSaveDialog() {
  saveName.value = store.currentWorkflow?.name || ''
  saveDescription.value = store.currentWorkflow?.description || ''
  showSaveDialog.value = true
}

async function handleSave() {
  if (!saveName.value.trim()) return
  await store.saveWorkflow(saveName.value.trim(), saveDescription.value.trim() || undefined)
  showSaveDialog.value = false
}

// ─── 执行 ─────────────────────────────────────────────
async function handleExecute() {
  if (!store.currentWorkflow) {
    // 先保存再执行
    openSaveDialog()
    return
  }
  // 如果有未保存更改，先保存
  if (store.isDirty) {
    await store.saveWorkflow(
      store.currentWorkflow.name,
      store.currentWorkflow.description,
    )
  }
  await store.executeWorkflow()
}

// ─── 工作流列表 ───────────────────────────────────────
async function loadWorkflow(id: string) {
  await store.loadWorkflow(id)
  showWorkflowList.value = false
  selectedNodeId.value = null
}

async function deleteWorkflow(id: string) {
  if (!confirm(t('canvas.confirmDelete'))) return
  await store.deleteWorkflow(id)
}

function handleNewWorkflow() {
  store.newWorkflow()
  selectedNodeId.value = null
  showWorkflowList.value = false
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
    const config = { ...(node.config || {}), [newConfigKey.value.trim()]: newConfigValue.value }
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

/** 执行状态颜色 */
function runStatusColor(): string {
  switch (store.currentRun?.status) {
    case 'completed': return '#10b981'
    case 'failed': return '#ef4444'
    case 'running': return '#3b82f6'
    default: return '#6b7280'
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('canvas.title')" :description="t('canvas.description')">
      <template #actions>
        <div class="flex items-center gap-1">
          <!-- 缩放控件 -->
          <button
            class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
            :style="{ color: 'var(--hc-text-secondary)' }"
            :title="t('canvas.zoomOut')"
            @click="zoomOut"
          >
            <ZoomOut :size="16" />
          </button>
          <span class="text-xs tabular-nums w-10 text-center" :style="{ color: 'var(--hc-text-muted)' }">
            {{ Math.round(zoom * 100) }}%
          </span>
          <button
            class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
            :style="{ color: 'var(--hc-text-secondary)' }"
            :title="t('canvas.zoomIn')"
            @click="zoomIn"
          >
            <ZoomIn :size="16" />
          </button>
          <button
            class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
            :style="{ color: 'var(--hc-text-secondary)' }"
            :title="t('canvas.fitView')"
            @click="fitView"
          >
            <Maximize2 :size="16" />
          </button>
          <div class="w-px h-4 mx-1" :style="{ background: 'var(--hc-border)' }" />

          <!-- 清空 -->
          <button
            class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
            :style="{ color: 'var(--hc-text-secondary)' }"
            :title="t('canvas.clear')"
            @click="clearCanvas"
          >
            <Trash2 :size="16" />
          </button>

          <!-- 工作流列表 -->
          <button
            class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
            :style="{ color: 'var(--hc-text-secondary)' }"
            :title="t('canvas.workflows')"
            @click="showWorkflowList = !showWorkflowList"
          >
            <FolderOpen :size="16" />
          </button>

          <div class="w-px h-4 mx-1" :style="{ background: 'var(--hc-border)' }" />

          <!-- 保存按钮 -->
          <button
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-white/5"
            :style="{ color: store.isDirty ? 'var(--hc-accent)' : 'var(--hc-text-secondary)' }"
            :disabled="store.saving"
            @click="openSaveDialog"
          >
            <Save :size="14" />
            {{ store.saving ? t('canvas.saving') : t('canvas.save') }}
          </button>

          <!-- 运行按钮 -->
          <button
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
            :style="{ background: store.executing ? '#6b7280' : 'var(--hc-accent)' }"
            :disabled="store.executing || store.nodes.length === 0"
            @click="handleExecute"
          >
            <Loader2 v-if="store.executing" :size="14" class="animate-spin" />
            <Play v-else :size="14" />
            {{ store.executing ? t('canvas.executing') : t('canvas.run') }}
          </button>
        </div>

        <!-- 添加节点 -->
        <div class="relative">
          <button
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="showAddMenu = !showAddMenu"
          >
            <Plus :size="16" />
            {{ t('canvas.addNode') }}
          </button>
          <div
            v-if="showAddMenu"
            class="absolute right-0 top-full mt-1 w-48 rounded-lg border shadow-lg z-20"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <button
              v-for="nt in nodeTypes"
              :key="nt.type"
              class="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/5 transition-colors"
              :style="{ color: 'var(--hc-text-primary)' }"
              @click="addNode(nt.type)"
            >
              <component :is="nt.icon" :size="14" :style="{ color: nt.color }" />
              {{ nt.label }}
            </button>
          </div>
        </div>
      </template>
    </PageHeader>

    <div class="flex-1 flex overflow-hidden">
      <!-- 工作流列表侧栏 -->
      <div
        v-if="showWorkflowList"
        class="w-60 flex-shrink-0 border-r flex flex-col"
        :style="{ background: 'var(--hc-bg-sidebar)', borderColor: 'var(--hc-border)' }"
      >
        <div class="flex items-center justify-between px-3 py-2 border-b" :style="{ borderColor: 'var(--hc-border)' }">
          <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">
            {{ t('canvas.workflows') }}
          </span>
          <button
            class="p-1 rounded hover:bg-white/5 transition-colors"
            :style="{ color: 'var(--hc-text-muted)' }"
            @click="handleNewWorkflow"
            :title="t('canvas.newWorkflow')"
          >
            <FilePlus :size="14" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="store.loading" class="flex items-center justify-center py-8">
            <Loader2 :size="20" class="animate-spin" :style="{ color: 'var(--hc-text-muted)' }" />
          </div>
          <div v-else-if="store.workflows.length === 0" class="text-center py-8">
            <p class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('canvas.noWorkflows') }}</p>
          </div>
          <div v-else>
            <div
              v-for="wf in store.workflows"
              :key="wf.id"
              class="px-3 py-2 border-b cursor-pointer hover:bg-white/5 transition-colors group"
              :style="{
                borderColor: 'var(--hc-border)',
                background: store.currentWorkflow?.id === wf.id ? 'var(--hc-accent)10' : 'transparent',
              }"
              @click="loadWorkflow(wf.id)"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium truncate" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ wf.name }}
                </span>
                <button
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all"
                  :style="{ color: 'var(--hc-text-muted)' }"
                  @click.stop="deleteWorkflow(wf.id)"
                >
                  <Trash2 :size="10" />
                </button>
              </div>
              <div v-if="wf.description" class="text-[10px] mt-0.5 truncate" :style="{ color: 'var(--hc-text-muted)' }">
                {{ wf.description }}
              </div>
              <div class="text-[10px] mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">
                {{ wf.nodes.length }} {{ t('canvas.nodes') }} · {{ wf.edges.length }} {{ t('canvas.connections') }}
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
        @click.self="selectedNodeId = null; showAddMenu = false"
      >
        <!-- 网格背景 -->
        <div class="absolute inset-0 opacity-5" style="background-image: radial-gradient(circle, currentColor 1px, transparent 1px); background-size: 24px 24px;" />

        <!-- 画布内容 (缩放) -->
        <div :style="{ transform: `scale(${zoom})`, transformOrigin: '0 0' }" class="absolute inset-0">
          <!-- 连接线 (SVG) -->
          <svg class="absolute inset-0 w-full h-full pointer-events-none" style="overflow: visible;">
            <line
              v-for="edge in store.edges"
              :key="edge.id"
              :x1="(store.nodes.find(n => n.id === edge.from)?.x ?? 0) + 80"
              :y1="(store.nodes.find(n => n.id === edge.from)?.y ?? 0) + 24"
              :x2="(store.nodes.find(n => n.id === edge.to)?.x ?? 0) + 80"
              :y2="(store.nodes.find(n => n.id === edge.to)?.y ?? 0) + 24"
              stroke="var(--hc-border)"
              stroke-width="2"
              stroke-dasharray="6 3"
            />
          </svg>

          <!-- 节点 -->
          <div
            v-for="node in store.nodes"
            :key="node.id"
            class="absolute rounded-xl border px-4 py-3 min-w-[160px] cursor-move select-none transition-shadow group"
            :style="{
              left: node.x + 'px',
              top: node.y + 'px',
              background: 'var(--hc-bg-card)',
              borderColor: selectedNodeId === node.id ? nodeColor(node.type) : 'var(--hc-border)',
              boxShadow: selectedNodeId === node.id ? `0 0 0 2px ${nodeColor(node.type)}40` : 'none',
            }"
            @mousedown.stop="startDrag(node.id, $event)"
            @click.stop="handleNodeClick(node.id)"
          >
            <div class="flex items-center gap-2 mb-1">
              <div
                class="w-6 h-6 rounded-md flex items-center justify-center"
                :style="{ background: nodeColor(node.type) + '20', color: nodeColor(node.type) }"
              >
                <component :is="nodeTypes.find(t => t.type === node.type)?.icon || Bot" :size="12" />
              </div>
              <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ node.label }}</span>
              <button
                class="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all"
                :style="{ color: 'var(--hc-text-muted)' }"
                @click.stop="removeNode(node.id)"
              >
                <Trash2 :size="10" />
              </button>
            </div>
            <div class="text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">
              {{ node.type }}
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div
          v-if="store.nodes.length === 0"
          class="absolute inset-0 flex items-center justify-center pointer-events-none"
        >
          <div class="text-center" :style="{ color: 'var(--hc-text-muted)' }">
            <Plus :size="48" class="mx-auto mb-3 opacity-20" />
            <p class="text-sm">{{ t('canvas.comingSoon') }}</p>
            <p class="text-xs mt-1">{{ t('canvas.comingSoonDesc') }}</p>
          </div>
        </div>

        <!-- 执行状态面板 -->
        <div
          v-if="store.currentRun"
          class="absolute top-3 right-3 w-64 rounded-lg border p-3 shadow-lg z-10"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">
              {{ t('canvas.runStatus') }}
            </span>
            <div class="flex items-center gap-1.5">
              <Loader2 v-if="store.isRunning" :size="12" class="animate-spin" :style="{ color: runStatusColor() }" />
              <CheckCircle2 v-else-if="store.currentRun.status === 'completed'" :size="12" :style="{ color: runStatusColor() }" />
              <AlertCircle v-else-if="store.currentRun.status === 'failed'" :size="12" :style="{ color: runStatusColor() }" />
              <span class="text-[10px] font-medium" :style="{ color: runStatusColor() }">
                {{ t(`canvas.run${store.currentRun.status.charAt(0).toUpperCase() + store.currentRun.status.slice(1)}`) }}
              </span>
            </div>
          </div>
          <div v-if="store.currentRun.output" class="text-[10px] p-2 rounded" :style="{ background: 'var(--hc-bg-main)', color: 'var(--hc-text-secondary)' }">
            {{ store.currentRun.output }}
          </div>
          <div v-if="store.currentRun.error" class="text-[10px] p-2 rounded mt-1" style="background: #ef444420; color: #ef4444;">
            {{ store.currentRun.error }}
          </div>
        </div>

        <!-- 底部状态栏 -->
        <div
          class="absolute bottom-0 left-0 right-0 flex items-center gap-4 px-4 py-1.5 text-[10px] border-t"
          :style="{ background: 'var(--hc-bg-sidebar)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-muted)' }"
        >
          <span>{{ t('canvas.nodes') }}: {{ store.nodes.length }}</span>
          <span>{{ t('canvas.connections') }}: {{ store.edges.length }}</span>
          <span v-if="store.currentWorkflow" class="text-blue-400">
            {{ store.currentWorkflow.name }}
          </span>
          <span v-if="store.isDirty" class="text-amber-400">
            {{ t('canvas.unsavedChanges') }}
          </span>
          <div class="flex-1" />
          <span v-if="selectedNodeId" class="text-blue-400">
            {{ store.nodes.find(n => n.id === selectedNodeId)?.label }}
          </span>
        </div>
      </div>

      <!-- 节点配置侧栏 -->
      <div
        v-if="selectedNode"
        class="w-60 flex-shrink-0 border-l flex flex-col"
        :style="{ background: 'var(--hc-bg-sidebar)', borderColor: 'var(--hc-border)' }"
      >
        <div class="flex items-center justify-between px-3 py-2 border-b" :style="{ borderColor: 'var(--hc-border)' }">
          <div class="flex items-center gap-1.5">
            <Settings2 :size="12" :style="{ color: 'var(--hc-text-muted)' }" />
            <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">
              {{ t('canvas.nodeConfig') }}
            </span>
          </div>
          <button
            class="p-1 rounded hover:bg-white/5 transition-colors"
            :style="{ color: 'var(--hc-text-muted)' }"
            @click="selectedNodeId = null"
          >
            <X :size="12" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-3 space-y-3">
          <!-- 标签 -->
          <div>
            <label class="text-[10px] font-medium block mb-1" :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('canvas.nodeLabel') }}
            </label>
            <input
              :value="selectedNode.label"
              @input="updateNodeLabel(($event.target as HTMLInputElement).value)"
              class="w-full px-2 py-1 rounded text-xs border outline-none transition-colors"
              :style="{
                background: 'var(--hc-bg-main)',
                borderColor: 'var(--hc-border)',
                color: 'var(--hc-text-primary)',
              }"
              :placeholder="t('canvas.nodeLabelPlaceholder')"
            />
          </div>

          <!-- 类型 (只读) -->
          <div>
            <label class="text-[10px] font-medium block mb-1" :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('canvas.nodeType') }}
            </label>
            <div
              class="w-full px-2 py-1 rounded text-xs border flex items-center gap-1.5"
              :style="{
                background: 'var(--hc-bg-main)',
                borderColor: 'var(--hc-border)',
                color: 'var(--hc-text-secondary)',
              }"
            >
              <div class="w-3 h-3 rounded" :style="{ background: nodeColor(selectedNode.type) }" />
              {{ selectedNode.type }}
            </div>
          </div>

          <!-- 配置项 -->
          <div>
            <label class="text-[10px] font-medium block mb-1" :style="{ color: 'var(--hc-text-muted)' }">
              Config
            </label>
            <div v-if="selectedNode.config && Object.keys(selectedNode.config).length > 0" class="space-y-1 mb-2">
              <div
                v-for="(val, key) in selectedNode.config"
                :key="String(key)"
                class="flex items-center gap-1 text-[10px] px-2 py-1 rounded group"
                :style="{ background: 'var(--hc-bg-main)', color: 'var(--hc-text-secondary)' }"
              >
                <span class="font-medium">{{ key }}:</span>
                <span class="flex-1 truncate">{{ val }}</span>
                <button
                  class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all"
                  :style="{ color: 'var(--hc-text-muted)' }"
                  @click="removeNodeConfig(String(key))"
                >
                  <X :size="8" />
                </button>
              </div>
            </div>
            <div class="flex gap-1">
              <input
                v-model="newConfigKey"
                class="flex-1 px-1.5 py-0.5 rounded text-[10px] border outline-none"
                :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                :placeholder="t('canvas.configKey')"
              />
              <input
                v-model="newConfigValue"
                class="flex-1 px-1.5 py-0.5 rounded text-[10px] border outline-none"
                :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                :placeholder="t('canvas.configValue')"
                @keyup.enter="addNodeConfig"
              />
              <button
                class="px-1.5 py-0.5 rounded text-[10px] hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-accent)' }"
                @click="addNodeConfig"
              >
                <Plus :size="10" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 保存对话框 -->
    <Teleport to="body">
      <div v-if="showSaveDialog" class="fixed inset-0 z-50 flex items-center justify-center">
        <div class="absolute inset-0 bg-black/50" @click="showSaveDialog = false" />
        <div
          class="relative w-96 rounded-xl border p-5 shadow-2xl"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold" :style="{ color: 'var(--hc-text-primary)' }">
              {{ t('canvas.saveDialog') }}
            </h3>
            <button
              class="p-1 rounded hover:bg-white/5 transition-colors"
              :style="{ color: 'var(--hc-text-muted)' }"
              @click="showSaveDialog = false"
            >
              <X :size="14" />
            </button>
          </div>

          <div class="space-y-3">
            <div>
              <label class="text-xs font-medium block mb-1" :style="{ color: 'var(--hc-text-secondary)' }">
                {{ t('canvas.workflowName') }}
              </label>
              <input
                v-model="saveName"
                class="w-full px-3 py-2 rounded-lg text-sm border outline-none transition-colors focus:border-blue-500"
                :style="{
                  background: 'var(--hc-bg-main)',
                  borderColor: 'var(--hc-border)',
                  color: 'var(--hc-text-primary)',
                }"
                :placeholder="t('canvas.workflowNamePlaceholder')"
                @keyup.enter="handleSave"
              />
            </div>
            <div>
              <label class="text-xs font-medium block mb-1" :style="{ color: 'var(--hc-text-secondary)' }">
                {{ t('canvas.workflowDescription') }}
              </label>
              <textarea
                v-model="saveDescription"
                rows="2"
                class="w-full px-3 py-2 rounded-lg text-sm border outline-none transition-colors focus:border-blue-500 resize-none"
                :style="{
                  background: 'var(--hc-bg-main)',
                  borderColor: 'var(--hc-border)',
                  color: 'var(--hc-text-primary)',
                }"
                :placeholder="t('canvas.workflowDescPlaceholder')"
              />
            </div>
          </div>

          <div class="flex justify-end gap-2 mt-4">
            <button
              class="px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-white/5 transition-colors"
              :style="{ color: 'var(--hc-text-secondary)' }"
              @click="showSaveDialog = false"
            >
              {{ t('canvas.cancel') }}
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
              :style="{ background: 'var(--hc-accent)' }"
              :disabled="!saveName.trim() || store.saving"
              @click="handleSave"
            >
              {{ store.saving ? t('canvas.saving') : t('canvas.save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
