/** 模型能力标记 */
export type ModelCapability =
  | 'text'
  | 'vision'
  | 'video'
  | 'audio'
  | 'code'
  | 'image_generation'
  | 'video_generation'
  | 'embedding'

/** 模型推理能力只能来自 Provider 的显式证据，未知时不得按模型名推断。 */
export type ModelReasoningSupport = 'supported' | 'unsupported' | 'unknown'

export type ModelReasoningDialect =
  | 'reasoning_effort'
  | 'enable_thinking'
  | 'think'
  | 'thinking'

/** 可由精确模型能力声明的思考强度。 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 思考策略在会话、Agent、全局默认与模型原生层之间共享。 */
export type ReasoningPolicy =
  | { mode: 'inherit' | 'auto' | 'on' | 'off' }
  | { mode: 'effort'; effort: ReasoningEffort }

/** 全局默认不允许 inherit；缺失的旧配置在运行时归一为 auto。 */
export type DefaultReasoningPolicy =
  | { mode: 'auto' | 'on' | 'off' }
  | { mode: 'effort'; effort: ReasoningEffort }

/** 精确模型的上游推理开关映射。 */
export interface ModelReasoningControl {
  dialect: ModelReasoningDialect
  on: unknown
  off: unknown
  /** 仅 reasoning_effort dialect 可以声明的可选档位，顺序由 Provider 决定。 */
  allowed_efforts?: ReasoningEffort[]
}

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

/** Embedding execution metadata. Unknown custom embedding models may omit it until probed. */
export interface EmbeddingModelContract {
  protocol: 'openai_embeddings' | 'ollama_embeddings'
  dimension: number
  normalization: 'l2' | 'none'
}

/** 模型选项 */
export interface ModelOption {
  id: string
  name: string
  isCustom?: boolean
  /** 模型支持的能力（静态声明），默认 ['text'] */
  capabilities?: ModelCapability[]
  /** 模型是否支持推理；缺失或非法值在规范化后统一为 unknown。 */
  reasoningSupport?: ModelReasoningSupport
  /** 仅 supported 模型允许携带的精确上游控制映射。 */
  reasoningControl?: ModelReasoningControl
  /** Vector-space contract used by the semantic-index backend; never inferred generically from an id. */
  embedding?: EmbeddingModelContract
  /** A7 tool_call 动态探测结果（运行时由后端 /api/v1/llm/capabilities 注入） */
  toolReliability?: ModelToolReliability
}

/** 模型目录条目（从 Provider /models 同步的全量可用模型 + 可选元数据）
 *
 * 目录（catalog）≠ 启用（provider.models）：目录是"上游有什么"，只存本地缓存；
 * 启用是用户策展的子集，进配置持久化。聚合商（OpenRouter 339 模型）靠这层分离避免污染全应用模型选择器。
 *
 * 元数据字段来自 OpenRouter 等聚合商扩展格式，标准 OpenAI /models 只有裸 id 时缺省。
 */
export interface CatalogModel {
  id: string
  name: string
  /** 上下文窗口（token） */
  contextLength?: number
  /** 每 token 输入价（字符串，"0" = 免费侧条件之一） */
  promptPrice?: string
  /** 每 token 输出价 */
  completionPrice?: string
  /** 输入模态：text / image / file / audio … */
  inputModalities?: string[]
  /** 是否支持 tool calling */
  supportsTools?: boolean
  /** Provider 目录显式返回的推理能力。 */
  reasoningSupport?: ModelReasoningSupport
  reasoningControl?: ModelReasoningControl
}

/** 判断目录条目是否免费（prompt 和 completion 价格都为 0） */
export function isCatalogModelFree(m: CatalogModel): boolean {
  return m.promptPrice === '0' && m.completionPrice === '0'
}

/** 目录条目是否带元数据（决定管理器里能否显示徽章/筛选） */
export function catalogModelHasMetadata(m: CatalogModel): boolean {
  return m.promptPrice !== undefined || m.contextLength !== undefined || m.inputModalities !== undefined
}

/** Provider 配置 */
export type ProviderLocality = 'auto' | 'local' | 'cloud'
export type ProviderLocalitySource = 'system' | 'user'

export interface PrivateNetworkAccess {
  host: string
  allowed: boolean
}

export interface ProviderProbeReceipt {
  providerInstanceId: string
  outcome: 'passed' | 'failed'
  locality: 'local' | 'cloud'
  latencyMs: number
  testedAt: number
  errorCode?: string
  errorMessage?: string
}

export interface ProviderConfig {
  id: string
  /** 后端分配/确认的稳定 Provider 实例身份，不随展示名或 map key 变化。 */
  providerInstanceId?: string
  /** 服务端按当前连接指纹投影的最近一次显式测试回执。 */
  probeReceipt?: ProviderProbeReceipt
  /** 后端运行时识别的 provider key（对应 hexclaw /api/v1/config/llm 的 map key） */
  backendKey?: string
  name: string
  type: ProviderType
  enabled: boolean
  apiKey: string
  /** 已保存 Key 的真实长度（sidecar 脱敏元数据，仅长度不含 Key 内容；隐藏态掩码等长圆点用） */
  apiKeyLength?: number
  /** Stable Provider identity for a typed update; never resolves to plaintext in the renderer. */
  credentialRef?: string
  /** Sidecar reports that the owner-YAML Provider key is usable in this process. */
  credentialPresent?: boolean
  /** Explicit secret intent for the next config transaction. */
  apiKeyMutation?: 'preserve' | 'replace' | 'delete'
  baseUrl: string
  models: ModelOption[]
  /** 当前 provider 在后端运行时默认使用的模型 */
  selectedModelId?: string
  /** 后端模型规格来源；缺失的历史配置按 legacy 处理。 */
  modelSpecsMode?: 'legacy' | 'explicit'
  /** 模型算力/数据最终位置；本地反向代理云模型必须显式为 cloud */
  locality?: ProviderLocality
  /** 部署位置由系统推断还是用户确认。 */
  localitySource?: ProviderLocalitySource
  /** 用户确认时的规范化主机；Base URL 换主机后确认自动失效。 */
  confirmedEndpointHost?: string
  /** RFC1918/ULA 访问授权，严格绑定到单个规范化主机。 */
  privateNetworkAccess?: PrivateNetworkAccess
  /** 是否启用工具注入（undefined/null=自动，true=强制开，false=强制关） */
  toolsEnabled?: boolean | null
  /** 最大注入工具数（0或undefined=不限制） */
  maxTools?: number
  /** 本地模型驻留时长（仅 Ollama 生效，如 "5m"/"30m"；空=后端默认 30m · BUG-20260710 P1） */
  keepAlive?: string
  /** 本地模型上下文上限（仅 Ollama；0/undefined=后端自动） */
  numCtx?: number
}

/** 后端模型能力目录条目。capabilities 缺失与显式 [] 语义不同。 */
export interface BackendProviderModelSpec {
  id: string
  display_name: string
  is_custom?: boolean
  capabilities?: ModelCapability[]
  reasoning_support?: ModelReasoningSupport
  reasoning_control?: ModelReasoningControl
  embedding?: EmbeddingModelContract
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
  /** 旧持久化快照可缺失；Store 运行时读取统一归一为 { mode: 'auto' }。 */
  defaultReasoningPolicy?: DefaultReasoningPolicy
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
  /** 额外只读授权目录（用户经数据连接器授权的本地目录）。后端落 skill.sandbox.filesystem.allowed_paths。 */
  allowed_paths?: string[]
}

/** 沙箱配置「部分更新」——字段均可选，便于只改 allowed_paths 而不动 network。 */
export interface SandboxConfigUpdate {
  network_enabled?: boolean
  allowed_paths?: string[]
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
  provider_instance_id?: string
  display_name?: string
  api_key?: string
  /** 已保存 Key 的真实长度（sidecar 脱敏元数据，仅长度不含 Key 内容） */
  api_key_length?: number
  credential_ref?: string
  credential_present?: boolean
  api_key_mutation?: {
    mode: 'preserve' | 'replace' | 'delete'
    credential_ref?: string
  }
  base_url: string
  model: string
  models?: string[]              // 已配置的模型列表（桌面端持久化用）
  model_specs?: BackendProviderModelSpec[]
  model_specs_mode?: 'legacy' | 'explicit'
  compatible: string
  locality?: ProviderLocality    // auto/local/cloud；localhost 云代理应为 cloud
  locality_source?: ProviderLocalitySource
  confirmed_endpoint_host?: string
  private_network_access?: PrivateNetworkAccess
  tools_enabled?: boolean | null // null=自动（本地关/云开），true=强制开，false=强制关
  max_tools?: number             // 0=不限制
  enabled?: boolean              // false=禁用（后端保留 Key/配置但不参与路由）；缺省/true=启用
  keep_alive?: string            // 本地模型驻留时长（仅 Ollama；空=后端默认 30m · BUG-20260710 P1）
  num_ctx?: number               // 本地模型上下文上限；0=自动
}

/** Plaintext exists only for the duration of one native coordinator invoke. */
export interface ProviderCredentialReplacement {
  providerKey: string
  secret: string
}

/** 后端 LLM 配置（匹配 GET/PUT /api/v1/config/llm） */
export interface BackendLLMConfig {
  default: string
  providers: Record<string, BackendLLMProvider>
  routing: { enabled: boolean; strategy: string }
  cache: { enabled: boolean; similarity: number; ttl: string; max_entries: number }
  /** 旧 Sidecar 可能尚未返回该字段。 */
  default_reasoning_policy?: DefaultReasoningPolicy
  /** K12 solve/grade 的强文本路由；设置页不改写，后端在 provider 重命名时按稳定身份迁移。 */
  reasoning_provider?: string
  reasoning_model?: string
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
  sandbox: { network_enabled: boolean; allowed_paths?: string[] }
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
  sandbox?: SandboxConfigUpdate
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
    provider_instance_id?: string
    locality?: ProviderLocality
    private_network_access?: PrivateNetworkAccess
  }
}

/** 单个 Provider 的连接测试结果 */
export interface LLMConnectionTestResponse {
  ok: boolean
  message: string
  provider?: string
  model?: string
  latency_ms?: number
  persisted?: boolean
  tested_at?: string | number
  error_code?: string
  error_message?: string
}
