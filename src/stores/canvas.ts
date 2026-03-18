/**
 * Canvas Store
 *
 * 管理画布面板状态，对接后端 Panel API，工作流 CRUD 和执行。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  listPanels,
  getPanel,
  sendCanvasEvent,
  saveWorkflow as apiSaveWorkflow,
  getWorkflows as apiGetWorkflows,
  deleteWorkflow as apiDeleteWorkflow,
  runWorkflow as apiRunWorkflow,
  type PanelSummary,
} from '@/api/canvas'
import { trySafe } from '@/utils/errors'
import type { CanvasNode, CanvasEdge, Workflow, WorkflowRunStatus, ApiError } from '@/types'

export const useCanvasStore = defineStore('canvas', () => {
  // ─── State ───────────────────────────────────────────
  const panels = ref<PanelSummary[]>([])
  const currentPanel = ref<Record<string, unknown> | null>(null)
  const nodes = ref<CanvasNode[]>([])
  const edges = ref<CanvasEdge[]>([])
  const loading = ref(false)
  const error = ref<ApiError | null>(null)

  // ─── 工作流状态 ─────────────────────────────────────
  const savedWorkflows = ref<Workflow[]>([])
  const runStatus = ref<WorkflowRunStatus | 'idle'>('idle')
  const runOutput = ref<string>('')
  const currentWorkflowId = ref<string | null>(null)
  const nodeRunStatus = ref<Record<string, 'idle' | 'running' | 'completed' | 'failed'>>({})
  const runResult = ref<{ output?: string; error?: string; startedAt?: string; finishedAt?: string } | null>(null)

  // ─── Actions ─────────────────────────────────────────

  async function loadPanels() {
    loading.value = true
    error.value = null
    const [res, err] = await trySafe(() => listPanels(), '加载面板列表')
    if (res) panels.value = res.panels || []
    error.value = err
    loading.value = false
  }

  async function loadPanel(id: string) {
    loading.value = true
    error.value = null
    const [res, err] = await trySafe(() => getPanel(id), '加载面板')
    if (res) currentPanel.value = res
    error.value = err
    loading.value = false
  }

  async function dispatchEvent(panelId: string, componentId: string, action: string, data?: Record<string, unknown>) {
    const [, err] = await trySafe(
      () => sendCanvasEvent(panelId, componentId, action, data),
      '发送 Canvas 事件',
    )
    error.value = err
  }

  // ─── Canvas 本地操作 ─────────────────────────────────

  function addNode(node: CanvasNode) {
    nodes.value.push(node)
  }

  function updateNode(id: string, updates: Partial<CanvasNode>) {
    const idx = nodes.value.findIndex((n) => n.id === id)
    if (idx !== -1) {
      nodes.value.splice(idx, 1, { ...nodes.value[idx]!, ...updates } as CanvasNode)
    }
  }

  function removeNode(id: string) {
    nodes.value = nodes.value.filter((n) => n.id !== id)
    edges.value = edges.value.filter((e) => e.from !== id && e.to !== id)
  }

  function addEdge(edge: CanvasEdge) {
    const exists = edges.value.some((e) => e.from === edge.from && e.to === edge.to)
    if (!exists) {
      edges.value.push(edge)
    }
  }

  function removeEdge(id: string) {
    edges.value = edges.value.filter((e) => e.id !== id)
  }

  function clearCanvas() {
    nodes.value = []
    edges.value = []
    currentPanel.value = null
    currentWorkflowId.value = null
  }

  // ─── 工作流 CRUD ────────────────────────────────────

  async function saveWorkflow(name: string, description?: string) {
    loading.value = true
    error.value = null
    const id = currentWorkflowId.value || `wf-${crypto.randomUUID().slice(0, 8)}`
    const [res, err] = await trySafe(
      () => apiSaveWorkflow({
        id,
        name,
        description,
        nodes: JSON.parse(JSON.stringify(nodes.value)),
        edges: JSON.parse(JSON.stringify(edges.value)),
      }),
      '保存工作流',
    )
    if (res) {
      currentWorkflowId.value = res.id
      // 刷新工作流列表
      await loadWorkflows()
    }
    error.value = err
    loading.value = false
    return res
  }

  async function loadWorkflows() {
    const [res, err] = await trySafe(() => apiGetWorkflows(), '加载工作流列表')
    if (res) savedWorkflows.value = res
    error.value = err
  }

  async function deleteWorkflow(id: string) {
    const [, err] = await trySafe(() => apiDeleteWorkflow(id), '删除工作流')
    if (!err) {
      savedWorkflows.value = savedWorkflows.value.filter((w) => w.id !== id)
      if (currentWorkflowId.value === id) {
        currentWorkflowId.value = null
      }
    }
    error.value = err
  }

  function loadWorkflowToCanvas(workflow: Workflow) {
    clearCanvas()
    currentWorkflowId.value = workflow.id
    for (const n of workflow.nodes) {
      addNode(n)
    }
    for (const e of workflow.edges) {
      addEdge(e)
    }
  }

  /** 验证工作流，返回错误信息列表 */
  function validateWorkflow(): string[] {
    const errors: string[] = []
    if (nodes.value.length === 0) {
      errors.push('validationNoNodes')
      return errors
    }

    // Check for orphan edges (referencing non-existent nodes)
    const nodeIds = new Set(nodes.value.map((n) => n.id))
    const hasOrphanEdges = edges.value.some((e) => !nodeIds.has(e.from) || !nodeIds.has(e.to))
    if (hasOrphanEdges) {
      errors.push('validationOrphanEdges')
    }

    // Check for disconnected nodes (nodes not referenced by any edge)
    if (nodes.value.length > 1) {
      const connectedNodes = new Set<string>()
      for (const e of edges.value) {
        connectedNodes.add(e.from)
        connectedNodes.add(e.to)
      }
      const disconnected = nodes.value.some((n) => !connectedNodes.has(n.id))
      if (disconnected) {
        errors.push('validationDisconnected')
      }
    }

    // Check for cycles using DFS
    const adj = new Map<string, string[]>()
    for (const n of nodes.value) adj.set(n.id, [])
    for (const e of edges.value) {
      if (adj.has(e.from)) adj.get(e.from)!.push(e.to)
    }
    const visited = new Set<string>()
    const inStack = new Set<string>()
    function hasCycle(nodeId: string): boolean {
      visited.add(nodeId)
      inStack.add(nodeId)
      for (const next of adj.get(nodeId) || []) {
        if (inStack.has(next)) return true
        if (!visited.has(next) && hasCycle(next)) return true
      }
      inStack.delete(nodeId)
      return false
    }
    for (const n of nodes.value) {
      if (!visited.has(n.id) && hasCycle(n.id)) {
        errors.push('validationCycle')
        break
      }
    }

    return errors
  }

  /** 计算拓扑排序 */
  function topologicalOrder(): string[] {
    const adj = new Map<string, string[]>()
    const inDeg = new Map<string, number>()
    for (const n of nodes.value) {
      adj.set(n.id, [])
      inDeg.set(n.id, 0)
    }
    for (const e of edges.value) {
      if (adj.has(e.from)) adj.get(e.from)!.push(e.to)
      inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1)
    }
    const queue: string[] = []
    for (const [nid, deg] of inDeg) {
      if (deg === 0) queue.push(nid)
    }
    const order: string[] = []
    while (queue.length > 0) {
      const cur = queue.shift()!
      order.push(cur)
      for (const next of adj.get(cur) || []) {
        const newDeg = (inDeg.get(next) || 1) - 1
        inDeg.set(next, newDeg)
        if (newDeg === 0) queue.push(next)
      }
    }
    // Add any remaining nodes not in topological order (cycle nodes)
    const orderSet = new Set(order)
    for (const n of nodes.value) {
      if (!orderSet.has(n.id)) order.push(n.id)
    }
    return order
  }

  async function runWorkflow() {
    if (runStatus.value === 'running') return
    if (nodes.value.length === 0) return
    runStatus.value = 'running'
    runOutput.value = ''
    runResult.value = null
    error.value = null

    // Reset node run statuses
    const statusMap: Record<string, 'idle' | 'running' | 'completed' | 'failed'> = {}
    for (const n of nodes.value) statusMap[n.id] = 'idle'
    nodeRunStatus.value = statusMap

    // 1. 确保工作流已保存
    const id = currentWorkflowId.value || `wf-${crypto.randomUUID().slice(0, 8)}`
    if (!currentWorkflowId.value) {
      currentWorkflowId.value = id
    }

    const [savedWf] = await trySafe(
      () => apiSaveWorkflow({
        id,
        name: `Workflow ${id}`,
        nodes: JSON.parse(JSON.stringify(nodes.value)),
        edges: JSON.parse(JSON.stringify(edges.value)),
      }),
      '自动保存工作流',
    )
    if (savedWf) currentWorkflowId.value = savedWf.id

    const order = topologicalOrder()

    // 2. 提交后端执行
    const [res, err] = await trySafe(
      () => apiRunWorkflow(savedWf?.id || id),
      '运行工作流',
    )

    if (res) {
      // 后端返回成功 — 按拓扑顺序播放节点动画
      for (const nid of order) {
        nodeRunStatus.value = { ...nodeRunStatus.value, [nid]: 'running' }
        await new Promise((r) => setTimeout(r, 250))
        nodeRunStatus.value = { ...nodeRunStatus.value, [nid]: 'completed' }
      }
      runStatus.value = res.status
      runOutput.value = res.output || res.error || ''
      runResult.value = {
        output: res.output,
        error: res.error,
        startedAt: res.started_at,
        finishedAt: res.finished_at,
      }
    } else {
      // 后端不可用 — 本地模拟执行
      for (const nid of order) {
        nodeRunStatus.value = { ...nodeRunStatus.value, [nid]: 'running' }
        await new Promise((r) => setTimeout(r, 300))
        nodeRunStatus.value = { ...nodeRunStatus.value, [nid]: 'completed' }
      }
      runStatus.value = 'completed'
      runOutput.value = '工作流本地模拟执行完成（后端不可用）'
      runResult.value = {
        output: '工作流本地模拟执行完成（后端不可用）',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }
    }
    error.value = err
  }

  return {
    // state
    panels,
    currentPanel,
    nodes,
    edges,
    loading,
    error,
    savedWorkflows,
    runStatus,
    runOutput,
    currentWorkflowId,
    nodeRunStatus,
    runResult,
    // actions
    loadPanels,
    loadPanel,
    dispatchEvent,
    addNode,
    updateNode,
    removeNode,
    addEdge,
    removeEdge,
    clearCanvas,
    saveWorkflow,
    loadWorkflows,
    deleteWorkflow,
    loadWorkflowToCanvas,
    validateWorkflow,
    topologicalOrder,
    runWorkflow,
  }
})
