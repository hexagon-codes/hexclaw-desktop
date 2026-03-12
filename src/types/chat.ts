/** 工具调用 */
export interface ToolCall {
  id: string
  name: string
  arguments: string
  result?: string
}

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  agent_id?: string
  agent_name?: string
  tool_calls?: ToolCall[]
  metadata?: Record<string, unknown>
}

/** 聊天会话 */
export interface ChatSession {
  id: string
  title: string
  agent_id: string
  agent_name: string
  created_at: string
  updated_at: string
  message_count: number
}

/** 聊天请求 */
export interface ChatRequest {
  message: string
  session_id?: string
  agent_id?: string
  role_id?: string
}
