/** Agent 角色（后端 /api/v1/roles 返回） */
export interface AgentRole {
  name: string
  title: string
  goal: string
}


/** 多 Agent 路由配置（后端 /api/v1/agents 返回） */
export interface AgentConfig {
  name: string
  display_name: string
  model: string
  provider: string
}
