/**
 * Canvas/A2UI API
 *
 * 面板管理、事件处理、工作流 CRUD 与执行。
 */

import { apiGet, apiPost, apiDelete } from './client'
import { logger } from '@/utils/logger'
import type { Workflow, WorkflowRun } from '@/types'

/** 面板概要 */
export interface PanelSummary {
  id: string
  title: string
  component_count: number
  version: number
}

/** 获取面板列表 */
export function listPanels() {
  return apiGet<{ panels: PanelSummary[]; total: number }>('/api/v1/canvas/panels')
}

/** 获取面板详情 */
export function getPanel(id: string) {
  return apiGet<Record<string, unknown>>(`/api/v1/canvas/panels/${encodeURIComponent(id)}`)
}

/** 发送 Canvas 事件 */
export function sendCanvasEvent(panelId: string, componentId: string, action: string, data?: Record<string, unknown>) {
  return apiPost<Record<string, unknown>>('/api/v1/canvas/events', {
    panel_id: panelId,
    component_id: componentId,
    action,
    data,
  })
}

// ─── 工作流 CRUD ─────────────────────────────────────

const WORKFLOWS_STORAGE_KEY = 'hexclaw_workflows'

/** 从 localStorage 读取工作流列表（后端 API 不可用时的降级方案） */
function getLocalWorkflows(): Workflow[] {
  try {
    const raw = localStorage.getItem(WORKFLOWS_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

/** 保存工作流列表到 localStorage */
function setLocalWorkflows(workflows: Workflow[]) {
  localStorage.setItem(WORKFLOWS_STORAGE_KEY, JSON.stringify(workflows))
}

/** 保存工作流 */
export async function saveWorkflow(workflow: Omit<Workflow, 'created_at' | 'updated_at'>): Promise<Workflow> {
  try {
    return await apiPost<Workflow>('/api/v1/canvas/workflows', workflow)
  } catch (e) {
    logger.warn('Failed to save workflow to backend, falling back to localStorage', e)
    const workflows = getLocalWorkflows()
    const now = new Date().toISOString()
    const existing = workflows.findIndex((w) => w.id === workflow.id)
    const saved: Workflow = { ...workflow, created_at: existing >= 0 ? workflows[existing]!.created_at : now, updated_at: now }
    if (existing >= 0) {
      workflows[existing] = saved
    } else {
      workflows.push(saved)
    }
    setLocalWorkflows(workflows)
    return saved
  }
}

/** 获取已保存的工作流列表 */
export async function getWorkflows(): Promise<Workflow[]> {
  try {
    const res = await apiGet<{ workflows: Workflow[] }>('/api/v1/canvas/workflows')
    return res.workflows || []
  } catch (e) {
    logger.warn('Failed to load workflows from backend, falling back to localStorage', e)
    return getLocalWorkflows()
  }
}

/** 删除工作流 */
export async function deleteWorkflow(id: string): Promise<void> {
  try {
    await apiDelete<{ message: string }>(`/api/v1/canvas/workflows/${encodeURIComponent(id)}`)
  } catch (e) {
    logger.warn('Failed to delete workflow from backend, falling back to localStorage', e)
    const workflows = getLocalWorkflows().filter((w) => w.id !== id)
    setLocalWorkflows(workflows)
  }
}

/** 运行工作流 — 失败时抛出异常，由 store 层处理降级逻辑 */
export async function runWorkflow(id: string): Promise<WorkflowRun> {
  return apiPost<WorkflowRun>(`/api/v1/canvas/workflows/${encodeURIComponent(id)}/run`)
}

/** 查询工作流运行状态 */
export async function getWorkflowRun(runId: string): Promise<WorkflowRun> {
  return apiGet<WorkflowRun>(`/api/v1/canvas/runs/${encodeURIComponent(runId)}`)
}
