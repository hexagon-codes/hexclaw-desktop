/**
 * Canvas/A2UI API
 *
 * 面板管理、事件处理、工作流 CRUD 与执行。
 */

import { apiGet, apiPost, apiDelete } from './client'
import { DESKTOP_USER_ID } from '@/constants'
import { logger } from '@/utils/logger'
import type { Workflow, WorkflowRun } from '@/types'

/** Selected K12 child context. The backend must still derive/verify this against authenticated context. */
export interface K12WorkflowOwner {
  agentId: string
  learnerId: string
}

export interface K12WorkflowScope extends K12WorkflowOwner {
  version: string
}

export interface K12WorkflowRunRequest extends K12WorkflowScope {
  objectId: string
  input: string
  platform: string
  instanceId: string
  chatId: string
  metadata?: Record<string, string>
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`K12 workflow ${field} 必填`)
  return normalized
}

function ownerQuery(owner: K12WorkflowOwner): Record<string, string> {
  return {
    user_id: DESKTOP_USER_ID,
    scenario: 'k12',
    agent_id: nonEmpty(owner.agentId, 'agent_id'),
    learner_id: nonEmpty(owner.learnerId, 'learner_id'),
  }
}

function ownerQueryString(owner: K12WorkflowOwner): string {
  const query = new URLSearchParams(ownerQuery(owner))
  return query.toString()
}

/** 面板概要 */
export interface PanelSummary {
  id: string
  title: string
  component_count: number
  version: number
}

/** 获取面板列表 */
export function listPanels(owner?: K12WorkflowOwner) {
  return apiGet<{ panels: PanelSummary[]; total: number }>(
    '/api/v1/canvas/panels',
    owner ? ownerQuery(owner) : undefined,
  )
}

/** 获取面板详情 */
export function getPanel(id: string, owner?: K12WorkflowOwner) {
  return apiGet<Record<string, unknown>>(
    `/api/v1/canvas/panels/${encodeURIComponent(id)}`,
    owner ? ownerQuery(owner) : undefined,
  )
}

/** 发送 Canvas 事件 */
export function sendCanvasEvent(
  panelId: string,
  componentId: string,
  action: string,
  data?: Record<string, unknown>,
  owner?: K12WorkflowOwner,
) {
  return apiPost<Record<string, unknown>>('/api/v1/canvas/events', {
    panel_id: panelId,
    component_id: componentId,
    action,
    data,
    ...(owner ? ownerQuery(owner) : {}),
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

function k12ScopeFromDefinition(
  workflow: Omit<Workflow, 'created_at' | 'updated_at'>,
  scope?: K12WorkflowScope,
): K12WorkflowScope | undefined {
  if (scope) {
    return {
      agentId: nonEmpty(scope.agentId, 'agent_id'),
      learnerId: nonEmpty(scope.learnerId, 'learner_id'),
      version: nonEmpty(scope.version, 'version'),
    }
  }
  const data = workflow.data
  if (data?.scenario !== 'k12') return undefined
  return {
    agentId: nonEmpty(String(data.agent_id ?? ''), 'agent_id'),
    learnerId: nonEmpty(String(data.learner_id ?? ''), 'learner_id'),
    version: nonEmpty(String(data.version ?? ''), 'version'),
  }
}

function freezeK12Definition(
  workflow: Omit<Workflow, 'created_at' | 'updated_at'>,
  scope: K12WorkflowScope,
): Omit<Workflow, 'created_at' | 'updated_at'> {
  return {
    ...workflow,
    data: {
      ...workflow.data,
      scenario: 'k12',
      agent_id: scope.agentId,
      learner_id: scope.learnerId,
      version: scope.version,
    },
  }
}

/** 保存工作流 */
export async function saveWorkflow(
  workflow: Omit<Workflow, 'created_at' | 'updated_at'>,
  scope?: K12WorkflowScope,
): Promise<Workflow> {
  const k12Scope = k12ScopeFromDefinition(workflow, scope)
  const payload = k12Scope ? freezeK12Definition(workflow, k12Scope) : workflow
  try {
    return await apiPost<Workflow>('/api/v1/canvas/workflows', payload)
  } catch (e) {
    // A global browser key has no K12 owner/version boundary. Falling back would turn
    // an unavailable backend into a false save and can surface another child's graph.
    if (k12Scope) throw e
    logger.warn('Failed to save workflow to backend, falling back to localStorage', e)
    const workflows = getLocalWorkflows()
    const now = new Date().toISOString()
    const existing = workflows.findIndex((w) => w.id === payload.id)
    const saved: Workflow = { ...payload, created_at: existing >= 0 ? workflows[existing]!.created_at : now, updated_at: now }
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
export async function getWorkflows(owner?: K12WorkflowOwner): Promise<Workflow[]> {
  try {
    const res = await apiGet<{ workflows: Workflow[] }>(
      '/api/v1/canvas/workflows',
      owner ? ownerQuery(owner) : undefined,
    )
    const workflows = res.workflows || []
    if (!owner) return workflows
    return workflows.filter((workflow) => {
      const data = workflow.data
      return data?.scenario === 'k12' &&
        data.agent_id === owner.agentId &&
        data.learner_id === owner.learnerId
    })
  } catch (e) {
    if (owner) throw e
    logger.warn('Failed to load workflows from backend, falling back to localStorage', e)
    return getLocalWorkflows()
  }
}

/** 删除工作流 */
export async function deleteWorkflow(id: string, owner?: K12WorkflowOwner): Promise<void> {
  const path = `/api/v1/canvas/workflows/${encodeURIComponent(id)}${owner ? `?${ownerQueryString(owner)}` : ''}`
  try {
    await apiDelete<{ message: string }>(path)
  } catch (e) {
    if (owner) throw e
    logger.warn('Failed to delete workflow from backend, falling back to localStorage', e)
    const workflows = getLocalWorkflows().filter((w) => w.id !== id)
    setLocalWorkflows(workflows)
  }
}

/** 运行工作流 — 失败时抛出异常，由 store 层处理降级逻辑 */
export async function runWorkflow(id: string, request?: K12WorkflowRunRequest): Promise<WorkflowRun> {
  const path = `/api/v1/canvas/workflows/${encodeURIComponent(id)}/run`
  if (!request) return apiPost<WorkflowRun>(path)
  const query = ownerQuery(request)
  const version = nonEmpty(request.version, 'version')
  const objectId = nonEmpty(request.objectId, 'object_id')
  return apiPost<WorkflowRun>(path, {
    input: nonEmpty(request.input, 'input'),
    user_id: DESKTOP_USER_ID,
    platform: nonEmpty(request.platform, 'platform'),
    instance_id: nonEmpty(request.instanceId, 'instance_id'),
    chat_id: nonEmpty(request.chatId, 'chat_id'),
    metadata: {
      ...request.metadata,
      scenario: query.scenario,
      agent_id: query.agent_id,
      learner_id: query.learner_id,
      workflow_version: version,
      object_id: objectId,
    },
  })
}

/** 查询工作流运行状态 */
export async function getWorkflowRun(runId: string, owner?: K12WorkflowOwner): Promise<WorkflowRun> {
  return apiGet<WorkflowRun>(
    `/api/v1/canvas/runs/${encodeURIComponent(runId)}`,
    owner ? ownerQuery(owner) : undefined,
  )
}

/** 续接一次失败/中断的运行（Ph5）：复用已完成节点输出，只重算失败/未达节点。返回新运行。 */
export async function resumeWorkflowRun(runId: string, scope?: K12WorkflowScope): Promise<WorkflowRun> {
  const path = `/api/v1/canvas/runs/${encodeURIComponent(runId)}/resume`
  if (!scope) return apiPost<WorkflowRun>(path)
  return apiPost<WorkflowRun>(path, {
    ...ownerQuery(scope),
    workflow_version: nonEmpty(scope.version, 'version'),
  })
}
