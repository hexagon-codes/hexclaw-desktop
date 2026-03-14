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

/** 聊天附件 */
export interface ChatAttachment {
  type: 'image' | 'video' | 'file'
  name: string
  mime: string
  /** Base64 encoded data */
  data: string
}

/** 聊天请求 */
export interface ChatRequest {
  message: string
  session_id?: string
  agent_id?: string
  role_id?: string
  attachments?: ChatAttachment[]
  /** LLM 模型 ID */
  model?: string
  /** Provider ID（前端配置的服务商） */
  provider_id?: string
  /** 采样温度 */
  temperature?: number
  /** 最大 token 数 */
  max_tokens?: number
}

/** 产物类型 */
export interface Artifact {
  id: string
  type: 'code' | 'html' | 'file' | 'markdown'
  title: string
  language?: string
  content: string
  previousContent?: string
  messageId: string
  createdAt: string
}

/** 聊天模式 */
export type ChatMode = 'chat' | 'agent'

/** 执行模式 */
export type ExecMode = 'craft' | 'auto'
