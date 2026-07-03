import { apiGet, apiPost, apiPut, apiDelete } from './client'
import { DESKTOP_USER_ID } from '@/constants'

/**
 * 自动化权限治理 API —— 对齐后端 api/handler_autonomy.go。
 *
 * 创建流静默预检（条件式向导）+ 设置页治理（Profile/决策日志/任务级授权）
 * 的统一数据面。判定是确定性的（Profile 矩阵 + 任务级授权求值）；
 * `estimated` 是预估口径：漏判由运行时审批兜底，多判不产生任何授权。
 */

/** 能力类别判定状态：auto=矩阵自动放行 / granted=任务级授权覆盖 / approval=转审批 */
export type CapabilityState = 'auto' | 'granted' | 'approval'

export interface CapabilityVerdict {
  category: string
  tools: string[]
  state: CapabilityState
}

/** 未归类的具体工具（MCP/连接器）的判定 —— 即原型中的「外部写入」风险面。 */
export interface ToolVerdict {
  tool: string
  state: CapabilityState
}

export interface PreflightResult {
  source: string
  profile: string
  capabilities: CapabilityVerdict[]
  extra_tools?: ToolVerdict[]
  estimated: string[]
  needs_decision: string[]
  /**
   * all_clear = 预估范围内没有需人工处理的项，不是「运行时绝不会触发审批」——
   * basis=heuristic 时预估可能漏判（GO-10），运行时审批兜底。
   */
  all_clear: boolean
  /** 预估口径：static=工具清单静态分析（确定性）；heuristic=含 prompt 关键词预估。 */
  basis?: 'static' | 'heuristic'
}

export interface PreflightRequest {
  source: 'cron' | 'webhook' | 'workflow' | 'heartbeat' | 'spawn'
  task_ref?: string
  prompt?: string
  deliver?: boolean
  tools?: string[]
  /** 给 workflow_id 由后端做节点静态分析（最准确路径）。 */
  workflow_id?: string
  /** 绑 cron job 的 webhook：给 cron_job_id 由后端解析 job 的 SourcePrompt 预检（FS-4）。 */
  cron_job_id?: string
}

/** 创建流静默预检：表单内容变化/提交前调用，全绿则不出现任何权限步骤。 */
export function preflightAutonomy(req: PreflightRequest) {
  return apiPost<PreflightResult>('/api/v1/autonomy/preflight', req)
}

export interface MatrixCell {
  category: string
  state: 'auto' | 'approval'
}

export interface MatrixRow {
  source: string
  cells: MatrixCell[]
}

/** 生效策略矩阵快照（设置页只读诊断视图）。 */
export interface MatrixView {
  profile: string
  categories: string[]
  rows: MatrixRow[]
}

export type AutonomyProfile = 'function_first' | 'balanced' | 'strict' | 'full_access'

export interface AutonomyProfileInfo {
  profile: AutonomyProfile
  profiles: AutonomyProfile[]
  matrix: MatrixView
}

export function getAutonomyProfile() {
  return apiGet<AutonomyProfileInfo>('/api/v1/autonomy/profile')
}

/** 切换 Profile：后端持久化配置 + 权限闸热更新，无需重启。 */
export function updateAutonomyProfile(profile: AutonomyProfile) {
  return apiPut<{ profile: AutonomyProfile; matrix: MatrixView }>('/api/v1/autonomy/profile', {
    profile,
  })
}

/** 一条持久化的权限决策记录（本地审计库）。 */
export interface AutonomyDecision {
  id: string
  at: string
  source: string
  task_ref?: string
  tool: string
  capability?: string
  profile: string
  decision: 'allow' | 'pending' | 'deny'
  via: 'matrix' | 'task_grant' | 'solve_grant' | 'policy'
  reason?: string
}

export function listAutonomyDecisions(params?: {
  source?: string
  task_ref?: string
  decision?: string
  limit?: number
}) {
  return apiGet<{ decisions: AutonomyDecision[]; total: number }>(
    '/api/v1/autonomy/decisions',
    params as Record<string, string | number> | undefined,
  )
}

/** 任务级授权：仅对指定任务放行 entries（类别名/精确工具名/glob），删除任务即回收。 */
export interface AutonomyGrant {
  id: string
  task_ref: string
  source: string
  entries: string[]
  note?: string
  created_at: string
}

export function listAutonomyGrants(taskRef?: string) {
  return apiGet<{ grants: AutonomyGrant[]; total: number }>(
    '/api/v1/autonomy/grants',
    taskRef ? { task_ref: taskRef } : undefined,
  )
}

export function createAutonomyGrant(data: {
  task_ref: string
  source?: string
  entries: string[]
  note?: string
}) {
  return apiPost<{ grant: AutonomyGrant }>('/api/v1/autonomy/grants', data)
}

export function revokeAutonomyGrant(id: string) {
  return apiDelete<{ message: string }>(`/api/v1/autonomy/grants/${encodeURIComponent(id)}`)
}

/** 总览里单个自动化任务的权限状态（预估口径 + 决策日志事实口径叠加）。 */
export interface AutonomyTaskStatus {
  task_ref: string
  kind: 'cron' | 'webhook' | 'workflow'
  name: string
  enabled: boolean
  status?: string
  needs_decision?: string[]
  all_clear: boolean
  last_block?: AutonomyDecision
  preflight?: PreflightResult
}

export interface AutonomySummary {
  profile: AutonomyProfile
  counts: { tasks: number; ready: number; pending: number; grants: number }
  pending: AutonomyTaskStatus[]
  tasks: AutonomyTaskStatus[]
}

export function getAutonomySummary() {
  return apiGet<AutonomySummary>('/api/v1/autonomy/summary', { user_id: DESKTOP_USER_ID })
}
