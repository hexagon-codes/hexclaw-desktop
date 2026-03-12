/**
 * Canvas 工作流 API
 *
 * 工作流的 CRUD 操作及执行。
 */

import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Workflow, WorkflowRun } from '@/types'

/** 获取工作流列表 */
export function listWorkflows() {
  return apiGet<Workflow[]>('/api/workflows')
}

/** 获取单个工作流 */
export function getWorkflow(id: string) {
  return apiGet<Workflow>(`/api/workflows/${id}`)
}

/** 创建工作流 */
export function createWorkflow(data: Omit<Workflow, 'id' | 'created_at' | 'updated_at'>) {
  return apiPost<Workflow>('/api/workflows', data)
}

/** 更新工作流 */
export function updateWorkflow(id: string, data: Partial<Workflow>) {
  return apiPut<Workflow>(`/api/workflows/${id}`, data)
}

/** 删除工作流 */
export function deleteWorkflow(id: string) {
  return apiDelete<void>(`/api/workflows/${id}`)
}

/** 执行工作流 */
export function executeWorkflow(id: string) {
  return apiPost<WorkflowRun>(`/api/workflows/${id}/run`)
}

/** 查询工作流执行状态 */
export function getWorkflowRun(workflowId: string, runId: string) {
  return apiGet<WorkflowRun>(`/api/workflows/${workflowId}/runs/${runId}`)
}
