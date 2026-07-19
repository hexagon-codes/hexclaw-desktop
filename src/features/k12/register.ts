/**
 * K12 场景包装配入口（features/k12/register）· 架构 §6.2 装配器职责。
 *
 * 纯声明式：只 merge i18n + 注册 schema/descriptor/resolver 进 registry，**零业务条件、不改 shell**。
 * 卸载即注销（禁用 K12 → registry.reset 后平台回通用形态，AP-1 自检通过）。
 */
import { i18n } from '@/i18n'
import { scenarioRegistry } from '@/shell/scenario/registry'
import type { ScenarioContext } from '@/shell/scenario/registry'
import { K12_SCHEMAS } from './schemas'
import { K12_VIEW_DESCRIPTOR, K12_SCENARIO_ID } from './descriptor'
import K12ChatEnhancement from './views/K12ChatEnhancement.vue'
import K12AgentCard from './views/K12AgentCard.vue'
import K12ProfileForm from './views/K12ProfileForm.vue'
import K12WebhookPanel from './views/K12WebhookPanel.vue'
import k12ZhCN from './i18n/zh-CN'
import k12En from './i18n/en'
import k12UgCN from './i18n/ug-CN'

let registered = false

/** 判定某实例是否为 K12 辅导实例（据 agent 元数据；后端 descriptor 就绪后由响应直接决定） */
export function isK12Instance(ctx: ScenarioContext): boolean {
  const m = ctx.metadata
  return m?.scenario === K12_SCENARIO_ID || m?.template === K12_SCENARIO_ID
}

/** 装配 K12 场景包（幂等） */
export function registerK12Scenario(): void {
  if (registered) return
  registered = true

  // 1) i18n 三语 merge —— K12 文案唯一注入点（模式卸载即随皮肤消失）
  i18n.global.mergeLocaleMessage('zh-CN', { k12: k12ZhCN })
  i18n.global.mergeLocaleMessage('zh', { k12: k12ZhCN })
  i18n.global.mergeLocaleMessage('en', { k12: k12En })
  i18n.global.mergeLocaleMessage('ug-CN', { k12: k12UgCN })

  // 2) 记录集 schema → RecordSchemaRegistry
  K12_SCHEMAS.forEach((s) => scenarioRegistry.registerSchema(s))

  // 3) 视图描述符 + agent→描述符解析器 → ViewExtensionRegistry
  scenarioRegistry.registerDescriptor(K12_SCENARIO_ID, K12_VIEW_DESCRIPTOR)
  scenarioRegistry.registerResolver((ctx) => (isK12Instance(ctx) ? K12_VIEW_DESCRIPTOR : null))
  // 3b) 实例内部名模式（BUG-20260712）：实例删除后元数据不复存在，shell 靠名字形状识别
  // 遗留孤儿会话（标题恰为 k12-tutor-xxx → 列表显示「已删除的智能体」而非裸 ID）
  scenarioRegistry.registerInstanceIdPattern(new RegExp(`^${K12_SCENARIO_ID}-`))

  // 4) 会话增强组件（头部 tab + 记录视图 + 备课卡侧栏）→ chat shell 用 <component :is> 渲染
  scenarioRegistry.registerChatEnhancement(K12ChatEnhancement)
  // 4b) 智能体卡扩展（错题/待复习计数 + 快捷入口）→ AgentsView 对场景实例渲染
  scenarioRegistry.registerAgentCardExtension(K12AgentCard)
  // 5) 建档模板（模板库露出「作业辅导助手」卡 + 建档表单）→ AgentsView 动态渲染，不 import 场景包
  scenarioRegistry.registerScenarioTemplate({
    key: K12_SCENARIO_ID,
    icon: '🎓',
    nameKey: 'k12.templateName',
    descKey: 'k12.templateDesc',
    form: K12ProfileForm,
  })
  // 6) 自动化 Webhook 管理扩展；通用自动化面板只消费中性 registry 描述。
  scenarioRegistry.registerWebhookManagementExtension({
    key: K12_SCENARIO_ID,
    title: 'K12 批改与回传事件',
    description: '按孩子绑定 TutorAgent · HMAC-SHA256 · 防重放 · 可查询 Receipt',
    component: K12WebhookPanel,
  })
}

/** 测试用：复位装配标志（配合 scenarioRegistry.reset） */
export function __resetK12Registration(): void {
  registered = false
}
