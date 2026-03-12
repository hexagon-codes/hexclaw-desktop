import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { AgentRole, AgentRoleInput } from '@/types'

export type { AgentRole, AgentRoleInput }

/** 获取角色列表 */
export function getRoles() {
  return apiGet<{ roles: AgentRole[] }>('/api/v1/roles')
}

/** 获取单个角色 */
export function getRole(id: string) {
  return apiGet<AgentRole>(`/api/v1/roles/${id}`)
}

/** 创建角色 */
export function createRole(role: AgentRoleInput) {
  return apiPost<AgentRole>('/api/v1/roles', role)
}

/** 更新角色 */
export function updateRole(id: string, role: Partial<AgentRoleInput>) {
  return apiPut<AgentRole>(`/api/v1/roles/${id}`, role)
}

/** 删除角色 */
export function deleteRole(id: string) {
  return apiDelete(`/api/v1/roles/${id}`)
}
