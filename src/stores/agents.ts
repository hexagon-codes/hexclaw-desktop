import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getRoles, getAgents } from '@/api/agents'
import { trySafe } from '@/utils/errors'
import type { AgentRole, AgentConfig, ApiError } from '@/types'

export const useAgentsStore = defineStore('agents', () => {
  const roles = ref<AgentRole[]>([])
  const registeredAgents = ref<AgentConfig[]>([])
  const defaultAgentName = ref('')
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

  /** 加载已注册 Agent 列表（含 model 偏好） */
  async function loadAgents() {
    const [res] = await trySafe(() => getAgents(), '加载 Agent 列表')
    if (res) {
      registeredAgents.value = res.agents || []
      defaultAgentName.value = res.default || ''
    }
  }

  /** 按名称查找已注册 Agent 配置 */
  function findAgent(name: string): AgentConfig | undefined {
    return registeredAgents.value.find((a) => a.name === name)
  }

  return {
    roles,
    registeredAgents,
    defaultAgentName,
    loading,
    error,
    loadRoles,
    loadAgents,
    findAgent,
  }
})
