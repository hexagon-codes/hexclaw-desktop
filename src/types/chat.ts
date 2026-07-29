import type { MessageContent, RenderManifest } from '@/contracts/message-content'

export type ThinkingState = 'running' | 'completed' | 'failed' | 'cancelled'
export type ReasoningVisibility = 'visible' | 'not_exposed'

export interface ReasoningDisclosure {
  visibility: ReasoningVisibility
  source: string
  dialect: string
  provider: string
  model: string
}

export type RuntimeEventKind = 'tool_started' | 'tool_completed' | 'tool_failed' | 'terminal'

export interface RuntimeEvent {
  version: 1
  sequence: number
  event_id: string
  kind: RuntimeEventKind
  tool_call_id?: string
  tool_name?: string
  terminal_status?: Extract<ThinkingState, 'completed' | 'failed' | 'cancelled'>
}

export interface RuntimeWireFrame {
  assistantMessageId?: string
  messageId?: string
  sequence: number
  reasoningDisclosure: ReasoningDisclosure | { visibility: 'not_exposed' }
  runtimeEvent?: RuntimeEvent
}

export interface RuntimeWireSnapshot {
  assistantMessageId?: string
  aliases: string[]
  lastSequence: number
  runtimeEvents: RuntimeEvent[]
  reasoningDisclosure?: ReasoningDisclosure
  acceptedFrames: Record<number, string>
}

export interface ChatMessageMetadata extends Record<string, unknown> {
  thinking_state?: ThinkingState
  thinking_duration?: number | string
  reasoning_visibility?: ReasoningVisibility
  reasoning_disclosure?: ReasoningDisclosure
  assistant_message_id?: string
  message_id?: string
  assistant_message_aliases?: string[]
  runtime_events?: RuntimeEvent[]
  last_sequence?: number
}

const THINKING_STATES = new Set<ThinkingState>(['running', 'completed', 'failed', 'cancelled'])
const REASONING_VISIBILITIES = new Set<ReasoningVisibility>(['visible', 'not_exposed'])
const RUNTIME_TOOL_KINDS = new Set<RuntimeEventKind>(['tool_started', 'tool_completed', 'tool_failed'])
const RUNTIME_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function stableFrameDigest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFrameDigest).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableFrameDigest(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function normalizeReasoningDisclosure(
  value: unknown,
  route?: { provider?: string; model?: string },
): ReasoningDisclosure | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['visibility', 'source', 'dialect', 'provider', 'model'])) {
    return undefined
  }
  if (
    !REASONING_VISIBILITIES.has(value.visibility as ReasoningVisibility)
    || !nonEmptyString(value.source)
    || !nonEmptyString(value.dialect)
    || !nonEmptyString(value.provider)
    || !nonEmptyString(value.model)
  ) {
    return undefined
  }
  if (
    (route?.provider && value.provider !== route.provider)
    || (route?.model && value.model !== route.model)
  ) {
    return undefined
  }
  return {
    visibility: value.visibility as ReasoningVisibility,
    source: value.source,
    dialect: value.dialect,
    provider: value.provider,
    model: value.model,
  }
}

export function normalizeRuntimeEvent(value: unknown, sequence: number): RuntimeEvent | undefined {
  if (!isRecord(value) || value.version !== 1 || !nonEmptyString(value.event_id)) return undefined
  if (RUNTIME_TOOL_KINDS.has(value.kind as RuntimeEventKind)) {
    if (
      !hasExactKeys(value, ['version', 'event_id', 'kind', 'tool_call_id', 'tool_name'])
      || !nonEmptyString(value.tool_call_id)
      || !nonEmptyString(value.tool_name)
    ) {
      return undefined
    }
    return {
      version: 1,
      sequence,
      event_id: value.event_id,
      kind: value.kind as RuntimeEventKind,
      tool_call_id: value.tool_call_id,
      tool_name: value.tool_name,
    }
  }
  if (
    value.kind !== 'terminal'
    || !hasExactKeys(value, ['version', 'event_id', 'kind', 'terminal_status'])
    || !RUNTIME_TERMINAL_STATES.has(value.terminal_status as string)
  ) {
    return undefined
  }
  return {
    version: 1,
    sequence,
    event_id: value.event_id,
    kind: 'terminal',
    terminal_status: value.terminal_status as RuntimeEvent['terminal_status'],
  }
}

export function createRuntimeWireSnapshot(): RuntimeWireSnapshot {
  return {
    aliases: [],
    lastSequence: 0,
    runtimeEvents: [],
    acceptedFrames: {},
  }
}

export function mergeRuntimeWireFrame(
  current: RuntimeWireSnapshot,
  raw: unknown,
  route?: { provider?: string; model?: string },
): { snapshot: RuntimeWireSnapshot; frame?: RuntimeWireFrame; accepted: boolean } {
  if (!isRecord(raw)) return { snapshot: current, accepted: false }
  const canonical = nonEmptyString(raw.assistant_message_id) ? raw.assistant_message_id : undefined
  const alias = nonEmptyString(raw.message_id) ? raw.message_id : undefined
  if (canonical && alias && canonical !== alias) return { snapshot: current, accepted: false }
  const candidateId = canonical ?? alias
  if (candidateId && current.assistantMessageId && candidateId !== current.assistantMessageId) {
    return { snapshot: current, accepted: false }
  }

  const sequence = Number.isSafeInteger(raw.sequence) && Number(raw.sequence) > 0
    ? Number(raw.sequence)
    : 0
  if (sequence === 0) {
    if (candidateId || raw.reasoning_disclosure != null || raw.runtime_event != null) {
      return { snapshot: current, accepted: false }
    }
    return {
      snapshot: current,
      accepted: true,
      frame: {
        sequence: 0,
        reasoningDisclosure: { visibility: 'not_exposed' },
      },
    }
  }

  const digest = stableFrameDigest(raw)
  if (sequence <= current.lastSequence) {
    return {
      snapshot: current,
      accepted: current.acceptedFrames[sequence] === digest,
    }
  }
  if (sequence !== current.lastSequence + 1 || !candidateId) {
    return { snapshot: current, accepted: false }
  }

  const disclosure = normalizeReasoningDisclosure(raw.reasoning_disclosure, route)
  const runtimeEvent = normalizeRuntimeEvent(raw.runtime_event, sequence)
  let runtimeEvents = current.runtimeEvents
  if (runtimeEvent) {
    const existing = runtimeEvents.find((event) => event.event_id === runtimeEvent.event_id)
    if (!existing) runtimeEvents = [...runtimeEvents, runtimeEvent]
  }
  const next: RuntimeWireSnapshot = {
    assistantMessageId: current.assistantMessageId ?? candidateId,
    aliases: Array.from(new Set([...current.aliases, ...(alias ? [alias] : [])])),
    lastSequence: sequence,
    runtimeEvents,
    reasoningDisclosure: disclosure ?? current.reasoningDisclosure,
    acceptedFrames: { ...current.acceptedFrames, [sequence]: digest },
  }
  return {
    snapshot: next,
    accepted: true,
    frame: {
      assistantMessageId: next.assistantMessageId,
      messageId: alias,
      sequence,
      reasoningDisclosure: disclosure ?? { visibility: 'not_exposed' },
      runtimeEvent,
    },
  }
}

export function normalizeRuntimeSnapshotMetadata(
  source: Record<string, unknown> | undefined,
  fallbackAssistantMessageId?: string,
  route?: { provider?: string; model?: string },
): ChatMessageMetadata {
  const metadata: ChatMessageMetadata = { ...(source ?? {}) }
  const canonical = nonEmptyString(metadata.assistant_message_id)
    ? metadata.assistant_message_id
    : nonEmptyString(metadata.message_id)
      ? metadata.message_id
      : fallbackAssistantMessageId
  const alias = nonEmptyString(metadata.message_id) ? metadata.message_id : undefined
  const identityConflict = !!(
    nonEmptyString(metadata.assistant_message_id)
    && alias
    && metadata.assistant_message_id !== alias
  )
  metadata.assistant_message_id = identityConflict ? fallbackAssistantMessageId : canonical
  if (metadata.assistant_message_id) metadata.message_id = metadata.assistant_message_id
  else {
    delete metadata.assistant_message_id
    delete metadata.message_id
  }

  const disclosure = normalizeReasoningDisclosure(metadata.reasoning_disclosure, route)
  if (disclosure) metadata.reasoning_disclosure = disclosure
  else delete metadata.reasoning_disclosure
  metadata.reasoning_visibility = disclosure?.visibility ?? 'not_exposed'
  if (disclosure?.visibility !== 'visible') delete metadata.reasoning

  const lastSequence = Number.isSafeInteger(metadata.last_sequence) && Number(metadata.last_sequence) >= 0
    ? Number(metadata.last_sequence)
    : 0
  metadata.last_sequence = lastSequence
  const events: RuntimeEvent[] = []
  const eventIds = new Set<string>()
  const eventSequences = new Set<number>()
  if (!identityConflict && Array.isArray(metadata.runtime_events)) {
    for (const candidate of metadata.runtime_events) {
      if (!isRecord(candidate)) continue
      const sequence = Number(candidate.sequence)
      if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > lastSequence) continue
      const { sequence: omittedSequence, ...wire } = candidate
      void omittedSequence
      const normalized = normalizeRuntimeEvent(wire, sequence)
      if (!normalized || eventIds.has(normalized.event_id) || eventSequences.has(sequence)) continue
      eventIds.add(normalized.event_id)
      eventSequences.add(sequence)
      events.push(normalized)
    }
  }
  metadata.runtime_events = events.sort((a, b) => a.sequence - b.sequence)
  const aliases = Array.isArray(metadata.assistant_message_aliases)
    ? metadata.assistant_message_aliases.filter(nonEmptyString)
    : []
  metadata.assistant_message_aliases = Array.from(new Set(aliases))
  return metadata
}


export function normalizeThinkingDuration(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const duration = Number(value)
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

export function normalizeThinkingMetadata(
  source: Record<string, unknown> | undefined,
  reasoning?: string,
  terminalState?: Extract<ThinkingState, 'completed' | 'failed' | 'cancelled'>,
): ChatMessageMetadata | undefined {
  const metadata: ChatMessageMetadata = { ...(source ?? {}) }
  const duration = normalizeThinkingDuration(metadata.thinking_duration)
  if (duration == null) delete metadata.thinking_duration
  else metadata.thinking_duration = duration

  const disclosure = normalizeReasoningDisclosure(metadata.reasoning_disclosure)
  const explicitVisibility = REASONING_VISIBILITIES.has(
    metadata.reasoning_visibility as ReasoningVisibility,
  )
    ? metadata.reasoning_visibility as ReasoningVisibility
    : undefined
  const hasReasoning = !!reasoning?.trim()
  const visibility = disclosure?.visibility
    ?? (explicitVisibility === 'not_exposed' || hasReasoning || duration != null ? 'not_exposed' : undefined)
  if (visibility) metadata.reasoning_visibility = visibility
  else delete metadata.reasoning_visibility

  const explicitState = THINKING_STATES.has(metadata.thinking_state as ThinkingState)
    ? metadata.thinking_state as ThinkingState
    : undefined
  const hasThinkingEvidence = hasReasoning || duration != null || disclosure != null || explicitState != null
  const inferredState = hasThinkingEvidence
    ? terminalState ?? (metadata.is_error === true ? 'failed' : 'completed')
    : undefined
  const state = explicitState ?? inferredState
  if (state) metadata.thinking_state = state
  else delete metadata.thinking_state

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

/** 工具调用 */
export interface ToolCall {
  id: string
  name: string
  arguments: string
  result?: string
  /** Canonical tool output; result remains the legacy/plain-text fallback. */
  message_content?: MessageContent
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
  | { type: 'text'; text: string; message_content?: MessageContent }
  | { type: 'thinking'; thinking: string; duration?: number }
  | { type: 'tool_use'; id: string; name: string; input: string; status?: 'running' | 'success' | 'error' }
  | { type: 'tool_result'; toolUseId: string; toolName: string; output: string; isError: boolean; message_content?: MessageContent }
  | { type: 'code'; language: string; content: string; title?: string }
  | { type: 'buttons'; prompt?: string; buttons: InteractiveButton[]; resolved?: { action: string; label: string } }

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** v0.5.0 canonical Markdown/LaTeX envelope; content remains the legacy fallback. */
  message_content?: MessageContent
  /** Persisted/returned render evidence when the target surface owns one. */
  render_manifest?: RenderManifest
  /** Per-block receipts when an ordered text↔tool message has several canonical sources. */
  render_manifests?: RenderManifest[]
  reasoning?: string
  timestamp: string
  created_at?: string
  agent_id?: string
  agent_name?: string
  tool_calls?: ToolCall[]
  metadata?: ChatMessageMetadata
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
