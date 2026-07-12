import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { getRoles, getAgents } from '@/api/agents'
import { trySafe } from '@/utils/errors'
import { userVisibleAgents } from '@/utils/imChannelBinding'
import type { AgentRole, AgentConfig, ApiError } from '@/types'

export const useAgentsStore = defineStore('agents', () => {
  const roles = ref<AgentRole[]>([])
  const registeredAgents = ref<AgentConfig[]>([])
  const agentsLoaded = ref(false)
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

  /** 加载已注册 Agent 列表（含 model 偏好）。
   * 经单一可见性边界 userVisibleAgents 剔除匿名「频道默认模型」Agent（`@im/<platform>`）——它们是
   * IM 频道默认模型的承载体，不是用户管理对象，不应泄漏进 Agent 管理页 / 路由下拉 / 聊天 Agent 选择器。 */
  async function loadAgents() {
    const [res] = await trySafe(() => getAgents(), '加载 Agent 列表')
    if (res) {
      registeredAgents.value = userVisibleAgents(res.agents || [])
      defaultAgentName.value = res.default || ''
      agentsLoaded.value = true
    }
  }

  /** 按名称查找已注册 Agent 配置 */
  function findAgent(name: string): AgentConfig | undefined {
    return registeredAgents.value.find((a) => a.name === name)
  }

  /**
   * 按**内部名或显示名**查找 Agent（BUG-20260712 #A）。
   * 会话标题被 session-title-heal 自愈成 display_name 后，「据标题反查 agent」的兜底若只按内部名
   * 匹配（findAgent）必然失败 → agentRole 不恢复 → 从「会话」列表打开 K12 会话不显示辅导 UI。
   * 优先精确内部名，退而按显示名——让标题反查在自愈前/后都可靠。
   */
  function findAgentByNameOrDisplay(nameOrDisplay: string): AgentConfig | undefined {
    const q = nameOrDisplay.trim()
    if (!q) return undefined
    return (
      registeredAgents.value.find((a) => a.name === q) ??
      registeredAgents.value.find((a) => (a.display_name ?? '').trim() === q)
    )
  }

  /** @ 召唤面板的 Agent 数据源（BUG-20260703 问题2）：与「我的智能体」同源——
   * registeredAgents（已经 userVisibleAgents 过滤）映射为 MentionPopup 形状。
   * 此前误用内置角色工厂 roles，把用户根本没有的模板 Agent 全列进 @ 面板。 */
  const mentionableAgents = computed(() =>
    registeredAgents.value.map((a) => ({
      name: a.name,
      title: a.display_name || a.name,
      goal: a.description || '',
    })),
  )

  return {
    roles,
    registeredAgents,
    agentsLoaded,
    defaultAgentName,
    mentionableAgents,
    loading,
    error,
    loadRoles,
    loadAgents,
    findAgent,
    findAgentByNameOrDisplay,
  }
})
