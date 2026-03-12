import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  getRoles,
  createRole as apiCreateRole,
  updateRole as apiUpdateRole,
  deleteRole as apiDeleteRole,
} from '@/api/agents'
import { trySafe } from '@/utils/errors'
import type { AgentRole, AgentRoleInput, ApiError } from '@/types'

export const useAgentsStore = defineStore('agents', () => {
  const roles = ref<AgentRole[]>([])
  const selectedRoleId = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<ApiError | null>(null)

  /** 加载角色列表 */
  async function loadRoles() {
    loading.value = true
    error.value = null
    const [res, err] = await trySafe(() => getRoles(), '加载角色列表')
    if (res) {
      roles.value = res.roles || []
    }
    error.value = err
    loading.value = false
  }

  /** 创建角色 */
  async function createRole(input: AgentRoleInput) {
    const [role, err] = await trySafe(() => apiCreateRole(input), '创建角色')
    if (err) { error.value = err; throw err }
    roles.value.push(role!)
    return role!
  }

  /** 更新角色 */
  async function updateRole(id: string, input: Partial<AgentRoleInput>) {
    const [role, err] = await trySafe(() => apiUpdateRole(id, input), '更新角色')
    if (err) { error.value = err; throw err }
    const idx = roles.value.findIndex((r) => r.id === id)
    if (idx >= 0) roles.value[idx] = role!
    return role!
  }

  /** 删除角色 */
  async function deleteRole(id: string) {
    const [, err] = await trySafe(() => apiDeleteRole(id), '删除角色')
    if (err) { error.value = err; throw err }
    roles.value = roles.value.filter((r) => r.id !== id)
    if (selectedRoleId.value === id) selectedRoleId.value = null
  }

  return {
    roles,
    selectedRoleId,
    loading,
    error,
    loadRoles,
    createRole,
    updateRole,
    deleteRole,
  }
})
