import { apiGet, apiPost, apiDelete } from './client'
import type { AgentRole, AgentConfig } from '@/types'

export type { AgentRole, AgentConfig }

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

/** 注册 Agent */
export function registerAgent(agent: AgentConfig) {
  return apiPost<{ message: string; name: string }>('/api/v1/agents', agent)
}

/** 注销 Agent */
export function unregisterAgent(name: string) {
  return apiDelete<{ message: string }>(`/api/v1/agents/${encodeURIComponent(name)}`)
}
