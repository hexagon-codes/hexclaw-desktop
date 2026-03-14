/**
 * Canvas Store
 *
 * 管理画布面板状态，对接后端 Panel API。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import { listPanels, getPanel, sendCanvasEvent, type PanelSummary } from '@/api/canvas'
import { trySafe } from '@/utils/errors'
import type { CanvasNode, CanvasEdge, ApiError } from '@/types'

export const useCanvasStore = defineStore('canvas', () => {
  // ─── State ───────────────────────────────────────────
  const panels = ref<PanelSummary[]>([])
  const currentPanel = ref<Record<string, unknown> | null>(null)
  const nodes = ref<CanvasNode[]>([])
  const edges = ref<CanvasEdge[]>([])
  const loading = ref(false)
  const error = ref<ApiError | null>(null)

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
  }

  return {
    // state
    panels,
    currentPanel,
    nodes,
    edges,
    loading,
    error,
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
  }
})
