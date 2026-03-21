import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { AgentRole, AgentConfig, AgentRule } from '@/types'

export type { AgentRole, AgentConfig, AgentRule }

// --- 角色 API (只读) ---

/** 获取角色列表 */
export function getRoles() {
  return apiGet<{ roles: AgentRole[] }>('/api/v1/roles')
}

// --- 多 Agent 路由 API ---

/** 获取已注册的 Agent 列表 */
export function getAgents() {
  return apiGet<{ agents: AgentConfig[]; total: number; default: string }>('/api/v1/agents')
}

/** 设置默认 Agent */
export function setDefaultAgent(name: string) {
  return apiPost<{ message: string; name: string }>('/api/v1/agents/default', { name })
}

/** 注册 Agent */
export function registerAgent(agent: AgentConfig) {
  return apiPost<{ message: string; name: string }>('/api/v1/agents', agent)
}

/** 更新 Agent 路由配置 */
export function updateAgent(name: string, updates: Partial<AgentConfig>) {
  return apiPut<{ message: string }>(`/api/v1/agents/${encodeURIComponent(name)}`, updates)
}

/** 注销 Agent */
export function unregisterAgent(name: string) {
  return apiDelete<{ message: string }>(`/api/v1/agents/${encodeURIComponent(name)}`)
}

// --- 路由规则 API ---

/** 获取路由规则列表 */
export function getRules() {
  return apiGet<{ rules: AgentRule[]; total: number }>('/api/v1/agents/rules')
}

/** 添加路由规则 */
export function addRule(rule: Omit<AgentRule, 'id'>) {
  return apiPost<{ message: string; id: number }>('/api/v1/agents/rules', rule)
}

/** 删除路由规则 */
export function deleteRule(id: number) {
  return apiDelete<{ message: string }>(`/api/v1/agents/rules/${id}`)
}
