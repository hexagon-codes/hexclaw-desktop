/** LLM 配置 */
export interface LLMConfig {
  provider: string
  model: string
  api_key: string
  base_url?: string
  temperature: number
  max_tokens: number
}

/** 安全配置 */
export interface SecurityConfig {
  gateway_enabled: boolean
  injection_detection: boolean
  pii_filter: boolean
  content_filter: boolean
  max_tokens_per_request: number
  rate_limit_rpm: number
}

/** 通用配置 */
export interface GeneralConfig {
  language: string
  log_level: string
  data_dir: string
  auto_start: boolean
}

/** 通知配置 */
export interface NotificationConfig {
  system_enabled: boolean
  sound_enabled: boolean
  agent_complete: boolean
}

/** MCP 配置 */
export interface MCPConfig {
  default_protocol: string
}

/** 应用配置 */
export interface AppConfig {
  llm: LLMConfig
  security: SecurityConfig
  general: GeneralConfig
  notification: NotificationConfig
  mcp: MCPConfig
}
