/** 模型能力标记 */
export type ModelCapability = 'text' | 'vision' | 'video' | 'audio' | 'code'

/** 模型选项 */
export interface ModelOption {
  id: string
  name: string
  isCustom?: boolean
  /** 模型支持的能力，默认 ['text'] */
  capabilities?: ModelCapability[]
}

/** Provider 配置 */
export interface ProviderConfig {
  id: string
  /** 后端运行时识别的 provider key（对应 hexclaw /api/v1/config/llm 的 map key） */
  backendKey?: string
  name: string
  type: ProviderType
  enabled: boolean
  apiKey: string
  baseUrl: string
  models: ModelOption[]
  /** 当前 provider 在后端运行时默认使用的模型 */
  selectedModelId?: string
}

/** 支持的 Provider 类型 */
export type ProviderType =
  | 'openai'
  | 'deepseek'
  | 'anthropic'
  | 'gemini'
  | 'qwen'
  | 'ark'
  | 'ollama'
  | 'custom'

/** Provider 预设信息 */
export interface ProviderPreset {
  type: ProviderType
  name: string
  defaultBaseUrl: string
  defaultModels: ModelOption[]
  placeholder: string
}

/** LLM 配置 (多 Provider) */
export interface LLMRoutingSettings {
  enabled: boolean
  strategy: string
}

export interface LLMConfig {
  providers: ProviderConfig[]
  defaultModel: string
  defaultProviderId?: string
  routing?: LLMRoutingSettings
}

/** 对话级参数 */
export interface ChatParams {
  model: string
  temperature: number
  maxTokens: number
}

/** 安全配置 */
export interface SecurityConfig {
  gateway_enabled: boolean
  injection_detection: boolean
  pii_filter: boolean
  content_filter: boolean
  max_tokens_per_request: number
  rate_limit_rpm: number
  conversation_encrypt?: boolean
  secure_storage?: boolean
  key_rotation?: boolean
}

/** 通用配置 */
export interface GeneralConfig {
  language: string
  log_level: string
  data_dir: string
  auto_start: boolean
  welcomeCompleted?: boolean
  defaultAgentRole?: string
}

/** 通知配置 */
export interface NotificationConfig {
  system_enabled: boolean
  sound_enabled: boolean
  agent_complete: boolean
  cron_notify?: boolean
  dnd_enabled?: boolean
}

/** MCP 配置 */
export interface MCPConfig {
  default_protocol: string
  auto_reconnect?: boolean
}

/** 应用配置 */
export interface AppConfig {
  llm: LLMConfig
  security: SecurityConfig
  general: GeneralConfig
  notification: NotificationConfig
  mcp: MCPConfig
}

/** 后端 LLM Provider 配置（匹配 hexclaw API） */
export interface BackendLLMProvider {
  api_key: string
  base_url: string
  model: string
  compatible: string
}

/** 后端 LLM 配置（匹配 GET/PUT /api/v1/config/llm） */
export interface BackendLLMConfig {
  default: string
  providers: Record<string, BackendLLMProvider>
  routing: { enabled: boolean; strategy: string }
  cache: { enabled: boolean; similarity: number; ttl: string; max_entries: number }
}

export interface BackendRuntimeConfig {
  server: {
    host: string
    port: number
    mode: string
  }
  llm: {
    default: string
    providers: Record<
      string,
      {
        model: string
        base_url: string
        has_key: boolean
      }
    >
  }
  knowledge: { enabled: boolean }
  mcp: { enabled: boolean }
  cron: { enabled: boolean }
  webhook: { enabled: boolean }
  canvas: { enabled: boolean }
  voice: { enabled: boolean }
  security: {
    gateway_enabled: boolean
    injection_detection: boolean
    pii_filter: boolean
    content_filter: boolean
    rate_limit_rpm: number
    max_tokens_per_request: number
  }
}

/** 单个 Provider 的连接测试请求 */
export interface LLMConnectionTestRequest {
  provider: {
    type: ProviderType
    base_url: string
    api_key: string
    model: string
  }
}

/** 单个 Provider 的连接测试结果 */
export interface LLMConnectionTestResponse {
  ok: boolean
  message: string
  provider?: string
  model?: string
  latency_ms?: number
}
