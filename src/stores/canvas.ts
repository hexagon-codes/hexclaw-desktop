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
  resumeWorkflowRun as apiResumeWorkflowRun,
  getWorkflowRuns as apiGetWorkflowRuns,
  cancelWorkflowRun as apiCancelWorkflowRun,
  deleteWorkflowRun as apiDeleteWorkflowRun,
  retryWorkflowDelivery as apiRetryWorkflowDelivery,
  retryWorkflowOutputFile as apiRetryWorkflowOutputFile,
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
  const workflowsLoaded = ref(false)
  const workflowsLoading = ref(false)
  const workflowLoadError = ref<ApiError | null>(null)
  const workflowCount = computed(() => workflowsLoaded.value ? savedWorkflows.value.length : undefined)
  const runHistoryCount = ref<number | undefined>()
  // 'unavailable' 为前端专属态：后端未提供/未启用工作流引擎（404），区别于真正的执行失败。
  const runStatus = ref<WorkflowRunStatus | 'idle' | 'unavailable'>('idle')
  const runOutput = ref<string>('')
  const currentWorkflowId = ref<string | null>(null)
  const nodeRunStatus = ref<Record<string, 'idle' | 'running' | 'completed' | 'failed' | 'skipped'>>({})
  const runResult = ref<{ output?: string; error?: string; startedAt?: string; finishedAt?: string; nodeResults?: WorkflowNodeRun[]; messageContent?: WorkflowRun['message_content']; deliveries?: WorkflowRun['deliveries']; generatedFiles?: WorkflowRun['generated_files'] } | null>(null)
  // 最近一次运行的 id（Ph5 续接用：失败后据此 resume，复用已完成节点）。
  const lastRunId = ref<string | null>(null)
  const runHistory = ref<WorkflowRun[]>([])
  const runHistoryLoading = ref(false)
  const runHistoryLoadError = ref<ApiError | null>(null)
  const workflowData = ref<Record<string, unknown> | undefined>()
  let observation = 0
  const deletedRunIds = new Set<string>()

  // 试运行前置校验：返回拦截原因（null = 可运行）。未配置的步骤——模型步骤无指令(prompt 空，
  // UI 显示"未配置指令")、工具步骤未选工具——不允许试运行。否则会把空指令提交后端执行、产出
  // 无意义结果（BUG-20260623：空工作流点试运行仍输出通用问候）。供 runWorkflow 闸门 + UI 禁用按钮复用。
  const runBlocker = computed<{ kind: 'Empty' | 'Agent' | 'Parallel' | 'Tool' | 'Import'; nodeId?: string; message: string } | null>(() => {
    if (nodes.value.length === 0) return { kind: 'Empty', message: '请先添加步骤再试运行' }
    for (const n of nodes.value) {
      const cfg = (n.config ?? {}) as Record<string, unknown>
      if (cfg.import_requires_review === true) return { kind: 'Import', nodeId: n.id, message: 'Review the imported source settings and select local execution resources before running' }
      if (n.type === 'agent' && !String(cfg.prompt ?? '').trim()) {
        return { kind: 'Agent', nodeId: n.id, message: `「${n.label || '模型'}」步骤未配置指令，请先填写指令再试运行` }
      }
      if (n.type === 'parallel') {
        const branches = cfg.branches
        if (Array.isArray(branches) && (!branches.length || branches.some((branch) => !String(branch.agent ?? '').trim()))) return { kind: 'Parallel', nodeId: n.id, message: 'Select an Agent for each parallel branch' }
        if (!branches && !(Array.isArray(cfg.roles) ? cfg.roles.length : String(cfg.roles ?? '').trim())) return { kind: 'Parallel', nodeId: n.id, message: 'Configure the parallel Agent branches' }
      }
      if (n.type === 'tool' && !String(cfg.tool ?? '').trim()) {
        return { kind: 'Tool', nodeId: n.id, message: `「${n.label || '工具'}」步骤未选择工具，请先配置再试运行` }
      }
    }
    return null
  })
  const runBlockReason = computed(() => runBlocker.value?.message ?? null)

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
    stopObserving(true)
    historyRequest += 1
    runHistory.value = []
    runHistoryLoading.value = false
    runHistoryLoadError.value = null
    workflowData.value = undefined
    nodes.value = []
    edges.value = []
    currentPanel.value = null
    currentWorkflowId.value = null
  }

  // ─── 工作流 CRUD ────────────────────────────────────

  async function saveWorkflow(name: string, description?: string) {
    loading.value = true
    error.value = null
    const originalNodes = nodes.value
    const originalId = currentWorkflowId.value
    const id = currentWorkflowId.value || `wf-${crypto.randomUUID().slice(0, 8)}`
    const [res, err] = await trySafe(
      () => apiSaveWorkflow({
        id,
        name,
        description,
        data: workflowData.value ? JSON.parse(JSON.stringify(workflowData.value)) : undefined,
        nodes: JSON.parse(JSON.stringify(nodes.value)),
        edges: JSON.parse(JSON.stringify(edges.value)),
      }),
      '保存工作流',
    )
    if (res) {
      if (nodes.value === originalNodes && currentWorkflowId.value === originalId) currentWorkflowId.value = res.id
      // 刷新工作流列表
      await loadWorkflows()
    }
    error.value = err
    loading.value = false
    return res
  }

  let workflowRequest = 0
  async function loadWorkflows() {
    const ticket = ++workflowRequest
    workflowsLoading.value = true
    workflowLoadError.value = null
    const [res, err] = await trySafe(() => apiGetWorkflows(), '加载工作流列表')
    if (ticket !== workflowRequest) return
    workflowsLoading.value = false
    workflowLoadError.value = err
    workflowsLoaded.value = !!res
    if (res) savedWorkflows.value = res
    error.value = err
  }

  async function deleteWorkflow(id: string) {
    const [, err] = await trySafe(() => apiDeleteWorkflow(id), '删除工作流')
    if (!err) {
      workflowRequest += 1
      workflowsLoading.value = false
      savedWorkflows.value = savedWorkflows.value.filter((w) => w.id !== id)
      if (currentWorkflowId.value === id) {
        clearCanvas()
      }
    }
    error.value = err
  }

  function loadWorkflowToCanvas(workflow: Workflow) {
    clearCanvas()
    currentWorkflowId.value = workflow.id
    workflowData.value = workflow.data
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
    // Index into the queue instead of Array.shift(): shift moves every remaining
    // element and turns a wide DAG into O(V²) work under full-suite load.
    let queueHead = 0
    while (queueHead < queue.length) {
      const cur = queue[queueHead++]!
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

  function projectRun(run: WorkflowRun) {
    if (deletedRunIds.has(run.id) || run.history_deleted) return
    lastRunId.value = run.id
    runStatus.value = run.status
    runOutput.value = run.output || run.error || ''
    runResult.value = { output: run.output, error: run.error, startedAt: run.started_at,
      finishedAt: run.finished_at, nodeResults: run.node_results, messageContent: run.message_content, deliveries: run.deliveries, generatedFiles: run.generated_files }
    const statuses: Record<string, 'idle' | 'running' | 'completed' | 'failed' | 'skipped'> = {}
    for (const result of run.node_results ?? []) {
      statuses[result.node_id] = result.status === 'completed' ? 'completed'
        : result.status === 'skipped' ? 'skipped' : result.status === 'failed' ? 'failed'
        : result.status === 'running' ? 'running' : 'idle'
    }
    nodeRunStatus.value = statuses
    const index = runHistory.value.findIndex((item) => item.id === run.id)
    if (index < 0) runHistory.value.unshift(run)
    else runHistory.value[index] = run
  }

  /** 观察与执行分离；离页只结束旧观察，不把远端运行判成失败。 */
  async function observeRun(initial: WorkflowRun) {
    const ticket = ++observation
    const workflowId = currentWorkflowId.value
    const deliveryObservationStarted = Date.now()
    let snapshot = initial
    while (ticket === observation && workflowId === currentWorkflowId.value && !deletedRunIds.has(snapshot.id)) {
      projectRun(snapshot)
      if (snapshot.status !== 'running' && snapshot.status !== 'pending') {
        const waiting = snapshot.deliveries?.some((delivery) => ['pending', 'preparing', 'sending'].includes(delivery.status) || delivery.status === 'accepted' && delivery.kind !== 'email')
          || snapshot.generated_files?.some((file) => file.status === 'pending' || file.status === 'rendering')
        if (!waiting || Date.now() - deliveryObservationStarted > 20_000) return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (ticket !== observation) return
      const [next, err] = await trySafe(() => apiGetWorkflowRun(initial.id), 'Query workflow run')
      if (ticket !== observation) return
      if (next) { snapshot = next; error.value = null }
      else { error.value = err; return }
    }
  }

  async function runWorkflow(input = '', savedDefinition?: Workflow) {
    if (runStatus.value === 'running' || runStatus.value === 'pending' || runBlockReason.value) return
    if (savedDefinition && savedDefinition.id !== currentWorkflowId.value) return
    const originalNodes = nodes.value
    runStatus.value = 'pending'
    const id = currentWorkflowId.value || `wf-${crypto.randomUUID().slice(0, 8)}`
    const existing = savedWorkflows.value.find((item) => item.id === id)
    const saved = savedDefinition ?? await saveWorkflow(existing?.name || `Workflow ${id}`)
    if (nodes.value !== originalNodes) return
    if (!saved) { runStatus.value = 'idle'; return }
    nodeRunStatus.value = {}
    runResult.value = null
    lastRunId.value = null
    const [run, err] = await trySafe(() => apiRunWorkflow(saved.id, {
      input, platform: 'desktop', idempotency_key: crypto.randomUUID(),
    }), 'Run workflow')
    if (nodes.value !== originalNodes) return
    if (run) {
      error.value = null
      void loadRunHistory(null, false)
      await observeRun(run)
    } else {
      runStatus.value = err?.status === 404 ? 'unavailable' : 'failed'
      error.value = err
      runOutput.value = err?.message || 'Workflow could not be submitted'
      runResult.value = { error: runOutput.value }
    }
  }

  async function resumeRun() {
    if (runStatus.value === 'running' || !lastRunId.value) return
    const [run, err] = await trySafe(() => apiResumeWorkflowRun(lastRunId.value!), 'Resume workflow')
    error.value = err
    if (run) {
      void loadRunHistory(null, false)
      await observeRun(run)
    }
  }

  let historyRequest = 0
  let runCountRequest = 0
  // 仅同步总量时不覆盖已选运行或其错误；编辑器清空也不使全局总量失效。
  async function loadRunHistory(id: string | null = currentWorkflowId.value, updateHistory = true) {
    const ticket = updateHistory ? ++historyRequest : historyRequest
    const countTicket = !id ? ++runCountRequest : runCountRequest
    if (updateHistory) {
      runHistoryLoading.value = true
      runHistoryLoadError.value = null
    }
    const [result, err] = await trySafe(() => apiGetWorkflowRuns(id || undefined), 'Load workflow runs')
    if (!id && countTicket === runCountRequest) runHistoryCount.value = result ? (result.runs ?? []).length : undefined
    if (!updateHistory || ticket !== historyRequest) return
    runHistoryLoading.value = false
    runHistoryLoadError.value = err
    error.value = err
    if (result) runHistory.value = result.runs ?? []
  }

  function stopObserving(clearResult = false) {
    observation += 1
    if (clearResult) {
      runStatus.value = 'idle'
      lastRunId.value = null
      runResult.value = null
      runOutput.value = ''
      nodeRunStatus.value = {}
    }
  }

  async function cancelRun() {
    if (!lastRunId.value) return
    const [, err] = await trySafe(() => apiCancelWorkflowRun(lastRunId.value!), 'Cancel workflow')
    error.value = err
  }

  async function retryDelivery(runId: string, deliveryId: string) {
    const [run, err] = await trySafe(() => apiRetryWorkflowDelivery(runId, deliveryId), 'Retry workflow delivery')
    error.value = err
    if (run && !deletedRunIds.has(runId)) await observeRun(run)
    return !err
  }

  async function retryOutputFile(runId: string, fileId: string) {
    const [run, err] = await trySafe(() => apiRetryWorkflowOutputFile(runId, fileId), 'Retry workflow output file')
    error.value = err
    if (run && !deletedRunIds.has(runId)) await observeRun(run)
    return !err
  }

  async function inspectRun(id: string) {
    const ticket = ++observation
    const [run, err] = await trySafe(() => apiGetWorkflowRun(id), 'Query workflow run')
    if (ticket !== observation || deletedRunIds.has(id)) return
    error.value = err
    if (run) await observeRun(run)
  }

  async function deleteRun(id: string): Promise<boolean> {
    const [, err] = await trySafe(() => apiDeleteWorkflowRun(id), 'Delete workflow run')
    error.value = err
    if (err) return false
    deletedRunIds.add(id)
    // 旧列表与计数回执不可把已删除项重新发布。
    historyRequest += 1
    runCountRequest += 1
    runHistoryLoading.value = false
    runHistoryLoadError.value = null
    runHistory.value = runHistory.value.filter((run) => run.id !== id)
    if (runHistoryCount.value !== undefined) runHistoryCount.value = Math.max(0, runHistoryCount.value - 1)
    if (lastRunId.value === id) stopObserving(true)
    return true
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
    workflowCount,
    runHistoryCount,
    workflowsLoading,
    workflowLoadError,
    runHistoryLoading,
    runHistoryLoadError,
    runStatus,
    runOutput,
    currentWorkflowId,
    workflowData,
    nodeRunStatus,
    runResult,
    lastRunId,
    runHistory,
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
    resumeRun,
    loadRunHistory,
    cancelRun,
    inspectRun,
    retryDelivery,
    retryOutputFile,
    deleteRun,
    stopObserving,
    runBlockReason,
    runBlocker,
  }
})
