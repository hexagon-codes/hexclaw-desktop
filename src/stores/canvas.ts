/**
 * Canvas 工作流 Store
 *
 * 管理画布节点/边状态、工作流 CRUD、执行与轮询。
 */

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import * as canvasApi from '@/api/canvas'
import { trySafe } from '@/utils/errors'
import { logger } from '@/utils/logger'
import type { CanvasNode, CanvasEdge, Workflow, WorkflowRun, ApiError } from '@/types'

export const useCanvasStore = defineStore('canvas', () => {
  // ─── State ───────────────────────────────────────────
  const workflows = ref<Workflow[]>([])
  const currentWorkflow = ref<Workflow | null>(null)
  const nodes = ref<CanvasNode[]>([])
  const edges = ref<CanvasEdge[]>([])
  const currentRun = ref<WorkflowRun | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const executing = ref(false)
  const error = ref<ApiError | null>(null)

  // ─── 变更计数 (替代 JSON.stringify 深比较) ─────────────
  const changeCount = ref(0)
  const savedChangeCount = ref(0)

  // ─── Getters ─────────────────────────────────────────
  const isDirty = computed(() => {
    return changeCount.value !== savedChangeCount.value
  })

  const isRunning = computed(() => currentRun.value?.status === 'running')

  // ─── 轮询计时器管理 ─────────────────────────────────
  const pollTimer = ref<ReturnType<typeof setTimeout> | null>(null)

  function cancelPoll() {
    if (pollTimer.value !== null) {
      clearTimeout(pollTimer.value)
      pollTimer.value = null
    }
  }

  // ─── Actions ─────────────────────────────────────────

  async function loadWorkflows() {
    loading.value = true
    error.value = null
    const [res, err] = await trySafe(() => canvasApi.listWorkflows(), '加载工作流列表')
    if (res) workflows.value = res
    error.value = err
    loading.value = false
  }

  async function loadWorkflow(id: string) {
    loading.value = true
    error.value = null
    const [res, err] = await trySafe(() => canvasApi.getWorkflow(id), '加载工作流')
    if (res) {
      currentWorkflow.value = res
      nodes.value = [...res.nodes]
      edges.value = [...res.edges]
    }
    error.value = err
    loading.value = false
  }

  async function saveWorkflow(name: string, description?: string) {
    saving.value = true
    error.value = null

    const data = { name, description, nodes: nodes.value, edges: edges.value }

    if (currentWorkflow.value) {
      const [res, err] = await trySafe(
        () => canvasApi.updateWorkflow(currentWorkflow.value!.id, data),
        '保存工作流',
      )
      if (res) {
        currentWorkflow.value = res
        savedChangeCount.value = changeCount.value
      }
      error.value = err
    } else {
      const [res, err] = await trySafe(() => canvasApi.createWorkflow(data), '创建工作流')
      if (res) {
        currentWorkflow.value = res
        workflows.value.push(res)
        savedChangeCount.value = changeCount.value
      }
      error.value = err
    }
    saving.value = false
  }

  async function deleteWorkflow(id: string) {
    const [, err] = await trySafe(() => canvasApi.deleteWorkflow(id), '删除工作流')
    if (!err) {
      workflows.value = workflows.value.filter((w) => w.id !== id)
      if (currentWorkflow.value?.id === id) {
        currentWorkflow.value = null
        nodes.value = []
        edges.value = []
      }
    }
    error.value = err
  }

  async function executeWorkflow() {
    if (!currentWorkflow.value) return
    executing.value = true
    error.value = null
    const [res, err] = await trySafe(
      () => canvasApi.executeWorkflow(currentWorkflow.value!.id),
      '执行工作流',
    )
    if (res) currentRun.value = res
    error.value = err
    executing.value = false

    // 轮询执行状态
    if (res && res.status === 'running') {
      pollRunStatus(currentWorkflow.value.id, res.id)
    }
  }

  async function pollRunStatus(workflowId: string, runId: string) {
    cancelPoll()
    const poll = async () => {
      const [res] = await trySafe(
        () => canvasApi.getWorkflowRun(workflowId, runId),
        '查询执行状态',
      )
      if (res) {
        currentRun.value = res
        if (res.status === 'running' || res.status === 'pending') {
          pollTimer.value = setTimeout(poll, 2000)
        } else {
          pollTimer.value = null
          executing.value = false
          logger.info(`工作流执行完成: ${res.status}`)
        }
      }
    }
    pollTimer.value = setTimeout(poll, 2000)
  }

  // ─── Canvas 操作 ─────────────────────────────────────

  function addNode(node: CanvasNode) {
    nodes.value.push(node)
    changeCount.value++
  }

  function updateNode(id: string, updates: Partial<CanvasNode>) {
    const idx = nodes.value.findIndex((n) => n.id === id)
    if (idx !== -1) {
      nodes.value[idx] = { ...nodes.value[idx], ...updates }
      changeCount.value++
    }
  }

  function removeNode(id: string) {
    nodes.value = nodes.value.filter((n) => n.id !== id)
    edges.value = edges.value.filter((e) => e.from !== id && e.to !== id)
    changeCount.value++
  }

  function addEdge(edge: CanvasEdge) {
    const exists = edges.value.some((e) => e.from === edge.from && e.to === edge.to)
    if (!exists) {
      edges.value.push(edge)
      changeCount.value++
    }
  }

  function removeEdge(id: string) {
    edges.value = edges.value.filter((e) => e.id !== id)
    changeCount.value++
  }

  function clearCanvas() {
    nodes.value = []
    edges.value = []
    currentRun.value = null
  }

  function newWorkflow() {
    currentWorkflow.value = null
    clearCanvas()
  }

  /** 清理资源，停止轮询 */
  function $dispose() {
    cancelPoll()
  }

  return {
    // state
    workflows,
    currentWorkflow,
    nodes,
    edges,
    currentRun,
    loading,
    saving,
    executing,
    error,
    changeCount,
    savedChangeCount,
    // getters
    isDirty,
    isRunning,
    // actions
    loadWorkflows,
    loadWorkflow,
    saveWorkflow,
    deleteWorkflow,
    executeWorkflow,
    addNode,
    updateNode,
    removeNode,
    addEdge,
    removeEdge,
    clearCanvas,
    newWorkflow,
    cancelPoll,
    $dispose,
  }
})
