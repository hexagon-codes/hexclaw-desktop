import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getRoles } from '@/api/agents'
import { trySafe } from '@/utils/errors'
import type { AgentRole, ApiError } from '@/types'

export const useAgentsStore = defineStore('agents', () => {
  const roles = ref<AgentRole[]>([])
  const loading = ref(false)
  const error = ref<ApiError | null>(null)

  /** 加载角色列表（只读，来自后端） */
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

  return {
    roles,
    loading,
    error,
    loadRoles,
  }
})
