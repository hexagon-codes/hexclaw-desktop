/**
 * ViewExtensionRegistry（L4 侧）· 架构 §6.4 六个 registry 注入缝之一。
 *
 * 场景包（features/*）通过本 registry 注册：视图描述符 / 记录 schema / 动作 handler，
 * **无需改动 shell**。验收（§6.4）：加一个 mock 场景包，不改 chat shell/records 即能挂
 * 一个记录集 + 一个动作 + 一个视图槽（tab）+ 一个侧栏。
 *
 * 领域无关红线：本文件零场景领域字面量（回归锁 §4.4）。
 */
import type { Component } from 'vue'
import type { InstanceViewDescriptor, RecordSchema } from '@/contracts'
import type { ChatAttachment } from '@/types'
import { EMPTY_VIEW_DESCRIPTOR } from '@/contracts'

/** 解析描述符时传入的实例上下文（来自 agent 实例） */
export interface ScenarioContext {
  agentId: string
  agentName?: string
  /** 当前会话稳定 ID；场景包仅可用于服务端来源关联与最小恢复绑定。 */
  sessionId?: string
  metadata?: Record<string, unknown>
}

/** 场景实例的权威可见身份及其历史自动生成别名；不包含用户自定义会话标题。 */
export interface ScenarioIdentityProjection {
  displayName: string
  generatedAliases: readonly string[]
}

/** 身份投影解析器：场景包只从自身权威 metadata 生成，缺少事实时返回 null。 */
export type IdentityProjectionResolver = (ctx: ScenarioContext) => ScenarioIdentityProjection | null

/**
 * 场景投影到通用 composer 的结构化 chip。shell 只转发稳定 action id，
 * 不解释 action 的领域含义；无 actionId 时仍是普通可关闭提示。
 */
export interface ScenarioComposerChip {
  id: string
  label: string
  actionId?: string
}

/** shell 将一次 composer action 转成带序号的命令，避免连续点击同一 action 被 watch 去重。 */
export interface ScenarioComposerAction {
  id: string
  sequence: number
}

/** 场景图片任务请求的显式模型路由。服务端仍须按能力目录重新校验。 */
export interface ScenarioImageModelRoute {
  provider: string
  model: string
  capability: 'vision'
}

/** 场景文本任务的显式模型路由；与输入框展示使用同一冻结事实。 */
export interface ScenarioTextModelRoute {
  provider: string
  model: string
  capability: 'text'
}

/** 场景资产固化后的最小回执；shell 只消费稳定身份，显示地址由认证读取链路生成。 */
export interface ScenarioComposerImageAssetReceipt {
  assetId: string
}

/** 当前 WebView 内的图片预览所有权；只在运行时转交，禁止序列化或持久化。 */
export interface ScenarioComposerImagePreviewOwnership {
  url: string
  release: () => void
}

/**
 * 通用 composer 拦截图片后交给场景包的完整事实。
 *
 * 新选图片只携带原始 File（可能绑定 native grant）和本会话受控预览；不能在 WebView
 * 编码为 data URL。dataUrl 仅保留给历史消息或显式重提的兼容输入，不能由新的选择/拖入路径写入。
 * attachment 是同一图片在会话消息中的投影；requestId/route/sourceSessionId 只由拥有消息身份
 * 与会话状态的 shell 注入，输入组件不猜测。
 */
export interface ScenarioComposerImagePayload {
  attachment: ChatAttachment
  /** 新选择/拖入图片的原始浏览器 File；仅运行时携带，不写入消息或持久状态。 */
  file?: File
  /** 仅当前 WebView 会话可用的预览 URL；持久化前绝不能替代资产回执。 */
  previewUrl?: string
  /** 预览的幂等释放权；只在输入组件与 shell 间转交，不进入消息、场景状态或持久层。 */
  previewOwnership?: ScenarioComposerImagePreviewOwnership
  /** 历史 data URL / 显式重提兼容输入；新选择/拖入路径禁止赋值。 */
  dataUrl?: string
  /**
   * 场景资产已被 Sidecar 固化后，由 shell 将同一用户消息写成稳定投影。
   * 该回调仅存在于当前运行时，既不序列化也不进入场景持久状态；返回 false 时场景不得创建任务。
   */
  onSourceStored?: (receipt: ScenarioComposerImageAssetReceipt) => Promise<boolean>
  /** 图片随消息携带的用户说明；为空时保持纯图片语义。 */
  contextText?: string
  /** §4.10 desktop request_id；与持久用户消息 ID 同源，同图再次提交也必须得到新 ID。 */
  requestId?: string
  /** 该图片 attempt 唯一允许投影和建 Job 的来源会话；禁止同 Agent 会话间串任务。 */
  sourceSessionId?: string
  route?: ScenarioImageModelRoute
}

/** 通用消息之后的场景投影锚点；消息 ID 由 shell 生成，只含 nanoid 安全字符。 */
export function scenarioMessageAnchorId(messageId: string): string {
  return `hc-chat-scenario-inline-${messageId}`
}

/**
 * 场景组件可请求通用 composer 执行的最小命令集。命令只操作输入控件，
 * 不发送消息、不携带领域语义，具体文案仍留在 feature 包。
 */
export type ScenarioComposerCommand =
  | { type: 'focus' }
  | { type: 'set-input'; text: string; focus?: boolean }

/** 描述符解析器：命中则返回该实例的视图描述符，否则 null */
export type DescriptorResolver = (ctx: ScenarioContext) => InstanceViewDescriptor | null

/** 动作 handler（场景侧栏/备份/打印/导出…由场景包提供，shell 只派发） */
export type ActionHandler = (ctx: ScenarioContext) => void

/** 场景建档模板（在通用模板库中露出一张卡 + 其专属建档表单组件） */
export interface ScenarioTemplate {
  key: string
  /** emoji 图标 */
  icon?: string
  /** 卡片名称 / 描述 i18n key */
  nameKey: string
  descKey: string
  /** 建档表单组件（emit created/close） */
  form: Component
}

/** 场景包注入自动化页的 Webhook 管理扩展；通用面板只负责装配与展开。 */
export interface WebhookManagementExtension {
  key: string
  title: string
  description: string
  component: Component
}

interface RegistryState {
  descriptors: Map<string, InstanceViewDescriptor>
  schemas: Map<string, RecordSchema>
  resolvers: DescriptorResolver[]
  identityProjectionResolvers: IdentityProjectionResolver[]
  actionHandlers: Map<string, ActionHandler>
  /** 会话增强组件（场景包提供；chat shell 只用 <component :is> 渲染，不 import 场景包） */
  chatEnhancement: Component | null
  /** 智能体卡扩展组件（场景实例卡上的计数/快捷入口；AgentsView 只渲染，不认识场景） */
  agentCardExtension: Component | null
  /** 智能体卡标题徽章 i18n key；由场景包声明，shell 只负责标题行投影。 */
  agentCardBadgeKey: string | null
  /** 场景建档模板（模板库露出 + 建档表单） */
  scenarioTemplates: ScenarioTemplate[]
  /** 自动化 Webhook 页的场景管理扩展（领域 UI 仍由 features/* 提供） */
  webhookManagementExtensions: WebhookManagementExtension[]
  /** 应用根级展示扩展；通用壳只负责装配，不解释场景语义。 */
  globalPresentationExtensions: Component[]
  /** 系统外观设置扩展；具体可见内容与状态仍由场景包拥有。 */
  appearanceSettingsExtensions: Component[]
  /** 场景实例内部名模式（BUG-20260712：实例已删除时元数据不复存在，shell 靠名字形状
   *  识别遗留孤儿会话——如标题恰为某场景实例内部名 → 显示「已删除的智能体」） */
  instanceIdPatterns: RegExp[]
}

function createState(): RegistryState {
  return {
    descriptors: new Map(),
    schemas: new Map(),
    resolvers: [],
    identityProjectionResolvers: [],
    actionHandlers: new Map(),
    chatEnhancement: null,
    agentCardExtension: null,
    agentCardBadgeKey: null,
    scenarioTemplates: [],
    webhookManagementExtensions: [],
    globalPresentationExtensions: [],
    appearanceSettingsExtensions: [],
    instanceIdPatterns: [],
  }
}

let state = createState()

export const scenarioRegistry = {
  /** 注册场景视图描述符（按 scenarioId） */
  registerDescriptor(scenarioId: string, descriptor: InstanceViewDescriptor): void {
    state.descriptors.set(scenarioId, descriptor)
  },
  getDescriptor(scenarioId: string): InstanceViewDescriptor | undefined {
    return state.descriptors.get(scenarioId)
  },

  /** 注册记录集 schema（按 collection） */
  registerSchema(schema: RecordSchema): void {
    state.schemas.set(schema.collection, schema)
  },
  getSchema(collection: string): RecordSchema | undefined {
    return state.schemas.get(collection)
  },

  /** 注册 agent→描述符解析器（场景包据实例元数据决定是否接管） */
  registerResolver(resolver: DescriptorResolver): void {
    state.resolvers.push(resolver)
  },
  /** 解析某实例的视图描述符；无场景命中返回空描述符（普通会话零增强） */
  resolveDescriptor(ctx: ScenarioContext): InstanceViewDescriptor {
    for (const resolve of state.resolvers) {
      const d = resolve(ctx)
      if (d) return d
    }
    return EMPTY_VIEW_DESCRIPTOR
  },

  /** 注册场景身份投影；通用 shell 不解释任何领域名称或历史别名。 */
  registerIdentityProjectionResolver(resolver: IdentityProjectionResolver): void {
    state.identityProjectionResolvers.push(resolver)
  },
  resolveIdentityProjection(ctx: ScenarioContext): ScenarioIdentityProjection | null {
    for (const resolve of state.identityProjectionResolvers) {
      const projection = resolve(ctx)
      if (projection) return projection
    }
    return null
  },
  /**
   * 只把内部 ID、空值和场景声明的历史自动名称投影到当前权威身份。
   * 其他候选值视为用户自定义标题，逐字符保留。
   */
  projectInstanceDisplayName(ctx: ScenarioContext, candidate?: string | null): string {
    const raw = (candidate ?? '').trim()
    const projection = this.resolveIdentityProjection(ctx)
    if (!projection) return raw
    if (raw === '' || raw === ctx.agentId.trim() || projection.generatedAliases.includes(raw)) {
      return projection.displayName
    }
    return raw
  },

  /** 注册会话增强组件（场景包提供，如 K12 头部 tab + 记录视图 + 侧栏） */
  registerChatEnhancement(component: Component): void {
    state.chatEnhancement = component
  },
  /** 取会话增强组件（chat shell 用 <component :is> 渲染；无场景为 null） */
  get chatEnhancement(): Component | null {
    return state.chatEnhancement
  },

  /** 注册智能体卡扩展组件（场景实例卡上的计数 + 快捷入口） */
  registerAgentCardExtension(component: Component): void {
    state.agentCardExtension = component
  },
  get agentCardExtension(): Component | null {
    return state.agentCardExtension
  },
  registerAgentCardBadge(labelKey: string): void {
    state.agentCardBadgeKey = labelKey
  },
  get agentCardBadgeKey(): string | null {
    return state.agentCardBadgeKey
  },
  /** 某实例是否为场景实例（有增强视图）——供通用视图判定是否渲染扩展 */
  isScenarioInstance(ctx: ScenarioContext): boolean {
    return this.resolveDescriptor(ctx).headerTabs.length > 0
  },

  /** 注册场景实例内部名模式（场景包装配时声明，如 K12 的 `k12-tutor-*`） */
  registerInstanceIdPattern(pattern: RegExp): void {
    state.instanceIdPatterns.push(pattern)
  },
  /** 某字符串是否形如某场景实例内部名（实例已删、无元数据可查时的孤儿识别兜底） */
  matchesInstanceId(id: string): boolean {
    return !!id && state.instanceIdPatterns.some((re) => re.test(id))
  },

  /** 注册场景建档模板（在通用模板库中露出） */
  registerScenarioTemplate(tpl: ScenarioTemplate): void {
    state.scenarioTemplates.push(tpl)
  },
  get scenarioTemplates(): ScenarioTemplate[] {
    return state.scenarioTemplates
  },

  /** 注册自动化 Webhook 页扩展（通用面板不 import 任一场景包）。 */
  registerWebhookManagementExtension(extension: WebhookManagementExtension): void {
    state.webhookManagementExtensions.push(extension)
  },
  get webhookManagementExtensions(): readonly WebhookManagementExtension[] {
    return state.webhookManagementExtensions
  },

  /** 注册应用根级展示扩展（通用 Layout 不 import 任一场景包）。 */
  registerGlobalPresentationExtension(component: Component): void {
    state.globalPresentationExtensions.push(component)
  },
  get globalPresentationExtensions(): readonly Component[] {
    return state.globalPresentationExtensions
  },

  /** 注册系统外观设置扩展（通用设置页不持有场景状态）。 */
  registerAppearanceSettingsExtension(component: Component): void {
    state.appearanceSettingsExtensions.push(component)
  },
  get appearanceSettingsExtensions(): readonly Component[] {
    return state.appearanceSettingsExtensions
  },

  /** 注册动作 handler */
  registerActionHandler(actionId: string, handler: ActionHandler): void {
    state.actionHandlers.set(actionId, handler)
  },
  hasAction(actionId: string): boolean {
    return state.actionHandlers.has(actionId)
  },
  runAction(actionId: string, ctx: ScenarioContext): void {
    state.actionHandlers.get(actionId)?.(ctx)
  },

  /** 测试用：清空所有注册 */
  reset(): void {
    state = createState()
  },
}

export type ScenarioRegistry = typeof scenarioRegistry
