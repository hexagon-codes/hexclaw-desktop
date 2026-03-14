<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plus, ZoomIn, ZoomOut, Maximize2, Trash2,
  Bot, Wrench, GitBranch, ArrowRightCircle,
  X, Settings2, BookTemplate, Loader2, FolderOpen,
} from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import TemplateGallery from '@/components/canvas/TemplateGallery.vue'
import type { WorkflowTemplate } from '@/components/canvas/TemplateGallery.vue'
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
const showTemplateGallery = ref(false)
const showPanelList = ref(false)

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
  store.loadPanels()
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

function stopDrag() { draggingNode.value = null }

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
          <button class="p-1.5 rounded-md hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-secondary)' }" title="模板库" @click="showTemplateGallery = true">
            <BookTemplate :size="16" />
          </button>
          <button class="p-1.5 rounded-md hover:bg-white/5 transition-colors" :style="{ color: 'var(--hc-text-secondary)' }" title="面板列表" @click="showPanelList = !showPanelList">
            <FolderOpen :size="16" />
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
          <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">面板</span>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="store.loading" class="flex items-center justify-center py-8">
            <Loader2 :size="20" class="animate-spin" :style="{ color: 'var(--hc-text-muted)' }" />
          </div>
          <div v-else-if="store.panels.length === 0" class="text-center py-8">
            <p class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">暂无面板</p>
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
        @click.self="selectedNodeId = null; showAddMenu = false"
      >
        <div class="absolute inset-0 opacity-5" style="background-image: radial-gradient(circle, currentColor 1px, transparent 1px); background-size: 24px 24px;" />

        <div :style="{ transform: `scale(${zoom})`, transformOrigin: '0 0' }" class="absolute inset-0">
          <!-- 连接线 -->
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
              <div class="w-6 h-6 rounded-md flex items-center justify-center" :style="{ background: nodeColor(node.type) + '20', color: nodeColor(node.type) }">
                <component :is="nodeTypes.find(t => t.type === node.type)?.icon || Bot" :size="12" />
              </div>
              <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ node.label }}</span>
              <button class="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all" :style="{ color: 'var(--hc-text-muted)' }" @click.stop="removeNode(node.id)">
                <Trash2 :size="10" />
              </button>
            </div>
            <div class="text-[10px]" :style="{ color: 'var(--hc-text-muted)' }">{{ node.type }}</div>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-if="store.nodes.length === 0" class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div class="text-center" :style="{ color: 'var(--hc-text-muted)' }">
            <Plus :size="48" class="mx-auto mb-3 opacity-20" />
            <p class="text-sm">{{ t('canvas.comingSoon') }}</p>
            <p class="text-xs mt-1">{{ t('canvas.comingSoonDesc') }}</p>
          </div>
        </div>

        <!-- 底部状态栏 -->
        <div class="absolute bottom-0 left-0 right-0 flex items-center gap-4 px-4 py-1.5 text-[10px] border-t" :style="{ background: 'var(--hc-bg-sidebar)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-muted)' }">
          <span>{{ t('canvas.nodes') }}: {{ store.nodes.length }}</span>
          <span>{{ t('canvas.connections') }}: {{ store.edges.length }}</span>
          <div class="flex-1" />
          <span v-if="selectedNodeId" class="text-blue-400">
            {{ store.nodes.find(n => n.id === selectedNodeId)?.label }}
          </span>
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
                <button class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all" :style="{ color: 'var(--hc-text-muted)' }" @click="removeNodeConfig(String(key))">
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
  </div>
</template>
