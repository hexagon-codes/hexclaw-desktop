import { apiGet } from './client'

// ─── Types ──────────────────────────────────────────

export interface BudgetStatus {
  tokens_used: number
  tokens_max: number
  tokens_remaining: number
  cost_used: number
  cost_max: number
  cost_remaining: number
  duration_used: string
  duration_max: string
  duration_remaining: string
  exhausted: boolean
}

export interface ToolCacheStats {
  entries: number
  hits: number
  misses: number
  hit_rate: number
}

export interface ToolMetricItem {
  tool: string
  call_count: number
  success_rate: number
  avg_latency_ms: number
  cached_count: number
}

export interface ToolMetrics {
  tools: ToolMetricItem[]
}

export interface ToolPermissionRule {
  pattern: string
  action: string
}

export interface ToolPermissions {
  rules: ToolPermissionRule[] | null
}

// ─── API ────────────────────────────────────────────

/** 获取 Budget 用量状态 */
export function getBudgetStatus() {
  return apiGet<BudgetStatus>('/api/v1/budget/status')
}

/** 获取工具缓存统计 */
export function getToolCacheStats() {
  return apiGet<ToolCacheStats>('/api/v1/tools/cache/stats')
}

/** 获取工具调用指标 */
export function getToolMetrics() {
  return apiGet<ToolMetrics>('/api/v1/tools/metrics')
}

/** 获取工具权限规则 */
export function getToolPermissions() {
  return apiGet<ToolPermissions>('/api/v1/tools/permissions')
}
