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

/** 应用配置 */
export interface AppConfig {
  llm: LLMConfig
  security: SecurityConfig
  general: GeneralConfig
}
