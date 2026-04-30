/** 模型能力标记 */
export type ModelCapability = 'text' | 'vision' | 'video' | 'audio' | 'code' | 'image_generation' | 'video_generation'

/** A7 模型 tool_call 可靠度等级（后端 llmrouter.ReliabilityLevel 映射） */
export type ToolCallReliability = 'unknown' | 'good' | 'partial' | 'bad'

/** A7 能力探测结果（动态，30 天缓存，用户可手动刷新） */
export interface ModelToolReliability {
  level: ToolCallReliability
  /** ISO 8601 时间；缺失表示未探测过 */
  lastProbe?: string
  /** 探测失败原因，用于 tooltip */
  probeError?: string
}

/** 模型选项 */
export interface ModelOption {
  id: string
  name: string
  isCustom?: boolean
  /** 模型支持的能力（静态声明），默认 ['text'] */
  capabilities?: ModelCapability[]
  /** A7 tool_call 动态探测结果（运行时由后端 /api/v1/llm/capabilities 注入） */
  toolReliability?: ModelToolReliability
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
  /** 是否启用工具注入（undefined/null=自动，true=强制开，false=强制关） */
  toolsEnabled?: boolean | null
  /** 最大注入工具数（0或undefined=不限制） */
  maxTools?: number
}

/** 支持的 Provider 类型 */
export type ProviderType =
  | 'openai'
  | 'deepseek'
  | 'anthropic'
  | 'gemini'
  | 'qwen'
  | 'ark'
  | 'zhipu'
  | 'kimi'
  | 'ernie'
  | 'hunyuan'
  | 'spark'
  | 'minimax'
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

/** 工具注入全局设置 */
export interface ToolsInjectionSettings {
  enabled: 'auto' | 'on' | 'off' // auto=按 provider 类型自动判断
  maxTools: number                // 0=不限制
}

/** B1: Agent 策略模式（前端持久化，发消息时随 metadata.agent_mode 传后端）
 *
 * 与后端 engine/agent_mode.go 的 7+1 模式一致：
 * - auto: 启发式路由
 * - react: 默认工具循环
 * - plan-execute: 先规划再执行（多步题）
 * - reflection: 答后自查（判题）
 * - tot: Tree-of-Thought 多解择优
 * - self-reflect: 每步反思
 * - mem-augmented: 个性化档案优先
 * - debate: 双视角辩论
 */
export type AgentMode =
  | 'auto'
  | 'react'
  | 'plan-execute'
  | 'reflection'
  | 'tot'
  | 'self-reflect'
  | 'mem-augmented'
  | 'debate'

export interface LLMConfig {
  providers: ProviderConfig[]
  defaultModel: string
  defaultProviderId?: string
  routing?: LLMRoutingSettings
  tools?: ToolsInjectionSettings
  /** B1 Agent 模式；默认 'auto' */
  agentMode?: AgentMode
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
  rate_limit_rpm: number
  /** @deprecated 后端不消费此字段，仅为兼容旧配置保留 */
  max_tokens_per_request?: number
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

/** 记忆配置 */
export interface MemoryConfig {
  enabled: boolean
}

/** 沙箱配置 */
export interface SandboxConfig {
  network_enabled: boolean
}

/** 应用配置 */
export interface AppConfig {
  llm: LLMConfig
  security: SecurityConfig
  general: GeneralConfig
  notification: NotificationConfig
  mcp: MCPConfig
  /** Legacy configs created before the memory toggle existed may omit this field. */
  memory?: MemoryConfig
  /** Sandbox configuration for code execution. */
  sandbox?: SandboxConfig
}

/** 后端 LLM Provider 配置（匹配 hexclaw API） */
export interface BackendLLMProvider {
  api_key: string
  base_url: string
  model: string
  models?: string[]              // 已配置的模型列表（桌面端持久化用）
  compatible: string
  tools_enabled?: boolean | null // null=自动（本地关/云开），true=强制开，false=强制关
  max_tools?: number             // 0=不限制
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
  sandbox: { network_enabled: boolean }
  security: {
    gateway_enabled: boolean
    injection_detection: boolean
    pii_filter: boolean
    content_filter: boolean
    rate_limit_rpm: number
  }
}

export interface RuntimeConfigUpdateRequest {
  security?: SecurityConfig
  sandbox?: SandboxConfig
}

export interface ConfigUpdateResponse {
  message: string
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
