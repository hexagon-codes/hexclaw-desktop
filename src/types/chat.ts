/** 工具调用 */
export interface ToolCall {
  id: string
  name: string
  arguments: string
  result?: string
  /** 后端 wire 字段（snake_case 对齐 hexagon ToolResult / adapter.ToolCall）：
   *  status/duration_ms 由 hexagon 框架在工具执行点产出并透传，前端直接渲染；
   *  is_error 为结构化错误信号的向后兼容钩子。未下发时优雅降级（前端诚实推导）。 */
  status?: 'running' | 'success' | 'error'
  is_error?: boolean
  duration_ms?: number
}

/** v0.4.0 G3 通用交互式消息协议（与后端 adapter/interactive.go 对齐） */
export type InteractiveType = 'buttons' | 'select' | 'approval' | 'card'

export interface InteractiveButton {
  /** 按钮显示文案 */
  label: string
  /** 点击后回传给后端的 action 标识 */
  action: string
  /** 可选 payload，原样回传 */
  payload?: string
  /** 可视化样式：primary 醒目 / secondary 次要 / danger 危险 */
  variant?: 'primary' | 'secondary' | 'danger'
}

/** select 类型的选项 */
export interface InteractiveOption {
  label: string
  value: string
  description?: string
}

/** approval 类型的审批载荷 */
export interface InteractiveApproval {
  subject: string
  summary?: string
  approve_label?: string
  reject_label?: string
  approve_action?: string
  reject_action?: string
}

/** 卡片字段（key-value） */
export interface CardField {
  label: string
  value: string
  short?: boolean
}

/** card 类型的富信息卡片 */
export interface InteractiveCard {
  title: string
  fields?: CardField[]
  buttons?: InteractiveButton[]
  image?: string
  footer?: string
}

/** 用户已交互的结果 */
export interface InteractiveResolved {
  action: string
  label?: string
  value?: string
  approved?: boolean
  timestamp?: string
}

/** 通用交互载荷 — 4 种 type 对应不同子字段 */
export interface InteractivePayload {
  type: InteractiveType
  prompt?: string
  buttons?: InteractiveButton[]
  options?: InteractiveOption[]
  approval?: InteractiveApproval
  card?: InteractiveCard
  resolved?: InteractiveResolved
}

/** 消息内容块 — 强类型替代松散 JSON */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; duration?: number }
  | { type: 'tool_use'; id: string; name: string; input: string; status?: 'running' | 'success' | 'error' }
  | { type: 'tool_result'; toolUseId: string; toolName: string; output: string; isError: boolean }
  | { type: 'code'; language: string; content: string; title?: string }
  | { type: 'buttons'; prompt?: string; buttons: InteractiveButton[]; resolved?: { action: string; label: string } }

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string
  timestamp: string
  created_at?: string
  agent_id?: string
  agent_name?: string
  tool_calls?: ToolCall[]
  metadata?: Record<string, unknown>
  /** 结构化内容块（优先使用，fallback 到 content 字段） */
  blocks?: ContentBlock[]
  /** v0.4.0 G3 结构化交互载荷（替代 metadata.interactive_buttons JSON 字符串） */
  interactive?: InteractivePayload
}

/** 聊天会话 */
export interface ChatSession {
  id: string
  title: string
  agent_id?: string
  agent_name?: string
  created_at: string
  updated_at: string
  message_count: number
  /** 分支会话的源会话 id（BUG-20260703 P2-1 fork）；非分支为空 */
  parent_session_id?: string
}

/** `@` 召唤的上下文引用（知识库文档 / 连接 / 历史会话）。
 *  仅注入到发送给后端的 backendText，不污染用户气泡显示。Agent 不走此结构（走 @name 路由）。 */
export interface ChatContextRef {
  type: 'knowledge' | 'connection' | 'session'
  /** 实体唯一 id（doc id / connection id / session id） */
  id: string
  /** chip 显示名 */
  label: string
  /** 注入 backendText 的已解析内容（知识正文片段 / 连接说明 / 会话摘要） */
  content: string
}

/**
 * 文档引用（仅用于气泡展示文件卡片）。
 *
 * 文档（PDF/DOCX/…）的正文已解析进**隐藏上下文**（backendText）给模型，气泡里只显示这张卡片，
 * 不把正文灌进可见消息。卡片 ref（name/mime/size）**不进 attachments**（后端只把图片当多模态送模型），
 * 但 BUG-20260626 起经 metadata.documents 透传后端持久化，切会话/重启重载后卡片仍在（不再退化纯文本）。
 */
export interface ChatDocumentRef {
  name: string
  mime: string
  /** 字节大小，用于卡片副标题 */
  size: number
  /** 会话内预览句柄：用于点击卡片预览原文件（仅本会话有效，重载后失效——优雅降级，卡片仍展示） */
  id?: string
}

/** 聊天附件 */
export interface ChatAttachment {
  type: 'image' | 'video' | 'audio' | 'file'
  name: string
  mime: string
  /**
   * 附件数据。可能是：
   * - base64（历史数据 / 上传时），形如 "xxxxxx"
   * - data URL（图像生成 base64 包装后），形如 "data:image/png;base64,xxx"
   * - HTTP(S) URL（video gen / voice chat 的持久化路径或 Provider 临时 URL）
   *
   * 渲染处按 data.startsWith('http') / 'data:' 自动判别。
   */
  data: string
}

/** 聊天请求 */
export interface ChatRequest {
  message: string
  session_id?: string
  agent_id?: string
  role_id?: string
  attachments?: ChatAttachment[]
  /** Provider 名称（与后端配置键一致） */
  provider?: string
  /** LLM 模型 ID */
  model?: string
  /** Provider ID（前端配置的服务商） */
  provider_id?: string
  /** 采样温度 */
  temperature?: number
  /** 最大 token 数 */
  max_tokens?: number
  /** 客户端生成的请求 ID，用于流式恢复/日志关联 */
  request_id?: string
  /** 请求级元数据，例如 thinking 开关 */
  metadata?: Record<string, string>
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
  blockIndex?: number
  createdAt: string
}

/** 聊天模式 */
export type ChatMode = 'chat' | 'agent' | 'research'

/** 执行模式 */
export type ExecMode = 'craft' | 'auto'
