/** Agent 角色（后端 /api/v1/roles 返回） */
export interface AgentRole {
  name: string
  title: string
  goal: string
  backstory?: string
  expertise?: string[]
  tools?: string[]
  constraints?: string[]
}


/** 多 Agent 路由配置（后端 /api/v1/agents 返回） */
export interface AgentConfig {
  name: string
  display_name: string
  description?: string
  model: string
  provider: string
  system_prompt?: string
  skills?: string[]
  max_tokens?: number
  temperature?: number
  // 与后端契约对齐：router/agent_router.go AgentConfig.Metadata 是 map[string]string，
  // 非字符串值透传即 JSON decode 400（BUG-20260703 B1）。
  metadata?: Record<string, string>
}

/** 路由规则（platform/instance/user/chat → agent_name） */
export interface AgentRule {
  id: number
  platform: string
  instance_id: string
  user_id: string
  chat_id: string
  agent_name: string
  priority: number
}
