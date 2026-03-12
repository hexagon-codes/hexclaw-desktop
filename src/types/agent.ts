/** Agent 角色 */
export interface AgentRole {
  id: string
  name: string
  display_name: string
  description: string
  system_prompt: string
  model: string
  temperature: number
  tools: string[]
  skills: string[]
  created_at: string
  updated_at: string
  status: 'active' | 'inactive'
}

/** 创建/更新角色请求 */
export interface AgentRoleInput {
  name: string
  display_name: string
  description: string
  system_prompt: string
  model?: string
  temperature?: number
  tools?: string[]
  skills?: string[]
}
