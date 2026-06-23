/**
 * Canvas Store
 *
 * 管理画布面板状态，对接后端 Panel API，工作流 CRUD 和执行。
 */

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import {
  listPanels,
  getPanel,
  sendCanvasEvent,
  saveWorkflow as apiSaveWorkflow,
  getWorkflows as apiGetWorkflows,
  deleteWorkflow as apiDeleteWorkflow,
  runWorkflow as apiRunWorkflow,
  getWorkflowRun as apiGetWorkflowRun,
  type PanelSummary,
} from '@/api/canvas'
import { trySafe } from '@/utils/errors'
import type { CanvasNode, CanvasEdge, Workflow, WorkflowRun, WorkflowNodeRun, WorkflowRunStatus, ApiError } from '@/types'

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
  // 'unavailable' 为前端专属态：后端未提供/未启用工作流引擎（404），区别于真正的执行失败。
  const runStatus = ref<WorkflowRunStatus | 'idle' | 'unavailable'>('idle')
  const runOutput = ref<string>('')
  const currentWorkflowId = ref<string | null>(null)
  const nodeRunStatus = ref<Record<string, 'idle' | 'running' | 'completed' | 'failed'>>({})
  const runResult = ref<{ output?: string; error?: string; startedAt?: string; finishedAt?: string; nodeResults?: WorkflowNodeRun[] } | null>(null)

  // 试运行前置校验：返回拦截原因（null = 可运行）。未配置的步骤——模型步骤无指令(prompt 空，
  // UI 显示"未配置指令")、工具步骤未选工具——不允许试运行。否则会把空指令提交后端执行、产出
  // 无意义结果（BUG-20260623：空工作流点试运行仍输出通用问候）。供 runWorkflow 闸门 + UI 禁用按钮复用。
  const runBlockReason = computed<string | null>(() => {
    if (nodes.value.length === 0) return '请先添加步骤再试运行'
    for (const n of nodes.value) {
      const cfg = (n.config ?? {}) as Record<string, unknown>
      if (n.type === 'agent' && !String(cfg.prompt ?? '').trim()) {
        return `「${n.label || '模型'}」步骤未配置指令，请先填写指令再试运行`
      }
      if (n.type === 'tool' && !String(cfg.tool ?? '').trim()) {
        return `「${n.label || '工具'}」步骤未选择工具，请先配置再试运行`
      }
    }
    return null
  })

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
    if (edge.from === edge.to) return // 禁止自环
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
    // 未配置/空工作流不提交后端执行（BUG-20260623）。保持 idle，原因由 UI 经 runBlockReason 提示。
    if (runBlockReason.value) return
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

    const existingName = savedWorkflows.value.find(w => w.id === id)?.name
    const [savedWf] = await trySafe(
      () => apiSaveWorkflow({
        id,
        name: existingName || `Workflow ${id}`,
        nodes: JSON.parse(JSON.stringify(nodes.value)),
        edges: JSON.parse(JSON.stringify(edges.value)),
      }),
      '自动保存工作流',
    )
    if (savedWf) currentWorkflowId.value = savedWf.id

    const order = topologicalOrder()

    // 2. 提交后端执行（异步：后端立即返回 run id + status=running，真正执行在 goroutine 里跑）
    const [res, err] = await trySafe(
      () => apiRunWorkflow(savedWf?.id || id),
      '运行工作流',
    )

    if (res) {
      // 3. 后端已受理执行 — 先标记所有节点为 running（驱动节点动画），
      //    随后用真实 node_results / 轮询结果回填逐节点最终态。
      for (const nid of order) {
        nodeRunStatus.value = { ...nodeRunStatus.value, [nid]: 'running' }
      }
      applyNodeResults(res)
      let final: WorkflowRun = res
      if ((res.status === 'running' || res.status === 'pending') && res.id) {
        final = await pollWorkflowRun(res.id)
      }

      // 4. 用真实 node_results 回填逐节点状态与产物
      applyNodeResults(final)
      // 后端未返回逐节点结果时，按整体执行结果兜底逐节点状态：
      // 整体成功 → 全部 completed；整体失败 → 全部 failed。
      const fallbackNodeStatus = final.status === 'failed' ? 'failed' : 'completed'
      if (!final.node_results || final.node_results.length === 0) {
        for (const nid of order) {
          nodeRunStatus.value = { ...nodeRunStatus.value, [nid]: fallbackNodeStatus }
        }
      }
      runStatus.value = final.status
      runOutput.value = final.output || final.error || ''
      runResult.value = {
        output: final.output,
        error: final.error,
        startedAt: final.started_at,
        finishedAt: final.finished_at,
        nodeResults: final.node_results,
      }
      error.value = null
    } else if (err?.status === 404 || err?.code === 'NOT_FOUND') {
      // 后端未提供/未启用工作流引擎（404）—— 不是「执行失败」。
      // 节点从未运行，保持 idle（标 failed 会误导用户以为自己的工作流挂了）。
      runStatus.value = 'unavailable'
      const msg = '⚠ 工作流引擎未启用（当前后端未提供该功能）'
      runOutput.value = msg
      runResult.value = {
        output: msg,
        error: err?.message ?? 'Workflow engine not enabled',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }
      error.value = err
    } else {
      // 后端不可用 / 执行失败 — 标记所有节点为 failed，明确告知非模拟
      for (const nid of order) {
        nodeRunStatus.value = { ...nodeRunStatus.value, [nid]: 'failed' }
      }
      runStatus.value = 'failed'
      const msg = '⚠ 工作流未能提交后端执行（引擎不可用）'
      runOutput.value = msg
      runResult.value = {
        output: msg,
        error: err?.message ?? 'Backend unavailable',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }
      error.value = err
    }
  }

  /** 把后端 node_results 的状态回填到 nodeRunStatus（实时驱动节点动画）。 */
  function applyNodeResults(run: WorkflowRun) {
    if (!run.node_results || run.node_results.length === 0) return
    const map = { ...nodeRunStatus.value }
    for (const nr of run.node_results) {
      map[nr.node_id] =
        nr.status === 'completed' || nr.status === 'skipped' ? 'completed'
        : nr.status === 'failed' ? 'failed'
        : nr.status === 'running' ? 'running'
        : 'idle'
    }
    nodeRunStatus.value = map
  }

  /** 轮询后端运行记录直到完成/失败（前端 2min 兜底；后端单 run 上限 10min）。 */
  async function pollWorkflowRun(runId: string): Promise<WorkflowRun> {
    const deadline = Date.now() + 120_000
    let last: WorkflowRun | null = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600))
      const [snap] = await trySafe(() => apiGetWorkflowRun(runId), '查询运行状态')
      if (snap) {
        last = snap
        applyNodeResults(snap)
        if (snap.status !== 'running' && snap.status !== 'pending') return snap
      }
    }
    return (
      last ?? {
        id: runId,
        workflow_id: currentWorkflowId.value ?? '',
        status: 'failed',
        error: '运行超时（前端轮询 2 分钟未完成）',
        started_at: new Date().toISOString(),
      }
    )
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
    runBlockReason,
  }
})
