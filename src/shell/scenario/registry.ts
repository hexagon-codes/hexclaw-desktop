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
import { EMPTY_VIEW_DESCRIPTOR } from '@/contracts'

/** 解析描述符时传入的实例上下文（来自 agent 实例） */
export interface ScenarioContext {
  agentId: string
  agentName?: string
  metadata?: Record<string, unknown>
}

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

interface RegistryState {
  descriptors: Map<string, InstanceViewDescriptor>
  schemas: Map<string, RecordSchema>
  resolvers: DescriptorResolver[]
  actionHandlers: Map<string, ActionHandler>
  /** 会话增强组件（场景包提供；chat shell 只用 <component :is> 渲染，不 import 场景包） */
  chatEnhancement: Component | null
  /** 智能体卡扩展组件（场景实例卡上的计数/快捷入口；AgentsView 只渲染，不认识场景） */
  agentCardExtension: Component | null
  /** 场景建档模板（模板库露出 + 建档表单） */
  scenarioTemplates: ScenarioTemplate[]
  /** 设置页扩展组件（场景专属备份/偏好等；SettingsView 只渲染，不认识场景 · M2-20260710） */
  settingsExtension: Component | null
  /** 场景实例内部名模式（BUG-20260712：实例已删除时元数据不复存在，shell 靠名字形状
   *  识别遗留孤儿会话——如标题恰为某场景实例内部名 → 显示「已删除的智能体」） */
  instanceIdPatterns: RegExp[]
}

function createState(): RegistryState {
  return {
    descriptors: new Map(),
    schemas: new Map(),
    resolvers: [],
    actionHandlers: new Map(),
    chatEnhancement: null,
    agentCardExtension: null,
    scenarioTemplates: [],
    settingsExtension: null,
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
  registerSettingsExtension(component: Component): void {
    state.settingsExtension = component
  },
  get agentCardExtension(): Component | null {
    return state.agentCardExtension
  },
  get settingsExtension(): Component | null {
    return state.settingsExtension
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
