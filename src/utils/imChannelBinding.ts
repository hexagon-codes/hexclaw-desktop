/**
 * IM 通道「频道默认模型」绑定的纯逻辑——与视图解耦，便于单测。
 *
 * 产品决策（参见 IM 模型绑定评审）：频道默认模型**不**在 routing Rule 上加并列的
 * `model` 字段，而是用一个**匿名 Agent**（命名前缀 `@im/<platform>`）承载该通道的默认
 * 模型。这样始终保持「Rule → Agent → model」单一真相源，避免「频道绑的模型」与「Agent
 * 偏好的模型」双真相源冲突；同时给「不想建 Agent、只想给通道选个模型」的用户一条快捷路径。
 */

/** 承载「频道默认模型」的匿名 Agent 命名前缀。 */
export const CHANNEL_DEFAULT_PREFIX = '@im/'

/** 是否是承载「频道默认模型」的匿名 Agent（应从用户可见 Agent 列表过滤）。 */
export function isChannelDefaultAgent(name: string): boolean {
  return name.startsWith(CHANNEL_DEFAULT_PREFIX)
}

/** 某平台的频道默认匿名 Agent 名（一个平台一个）。 */
export function channelDefaultAgentName(platform: string): string {
  return `${CHANNEL_DEFAULT_PREFIX}${platform}`
}

/**
 * 从一组 agents 中剔除隐藏的「频道默认模型」匿名 Agent（`@im/*`），得到「用户可见 Agent」集合。
 *
 * 这是匿名频道默认 Agent 对用户可见性的【单一边界】——所有「把 agents 列给用户看/选」的前端站点
 * （Agent 管理页 / 路由规则下拉 / 聊天 Agent 选择器 / IM 通道绑定）都必须经此函数，而**不是**各自
 * 手写 `.filter((a) => !isChannelDefaultAgent(a.name))`。散落的内联过滤正是 AP-108 的根因（一处漏过
 * 滤即泄漏进用户列表）；收敛成单一来源后，新增列表站点只要不经此边界即被结构守卫挡下
 * （见 audit-im-model-binding-invariants ②）。
 */
export function userVisibleAgents<T extends { name: string }>(agents: T[]): T[] {
  return agents.filter((a) => !isChannelDefaultAgent(a.name))
}

export type EffectiveModelSource = 'agent' | 'global'

export interface EffectiveModel {
  /** 生效模型 ID（空 = 全局也未配默认）。 */
  modelId: string
  /** 精确 Provider 实例身份；全局默认优先使用稳定 providerId。 */
  providerId?: string
  /** Agent 保存的是后端 Provider key，不能只凭裸 modelId 匹配能力。 */
  providerKey?: string
  /** 来源：命名 Agent 偏好 / 频道默认模型 / 全局默认。 */
  source: EffectiveModelSource
  /** source==='agent' 时的 Agent 展示名。 */
  agentLabel?: string
}

/**
 * 解析某通道的「生效默认模型」+ 来源。
 *
 * 纯接待模型：模型 100% 跟随接待者（Agent），渠道层只读、不另设模型。
 * 注：对话内 `/model` 覆盖是逐对话运行时态，不在此通道级静态解析里体现。
 *
 * - 无绑定 Agent（= 小蟹·默认助理接待）→ 全局默认。
 * - 绑定命名 Agent：有 model → 用该 Agent 模型偏好；无 model → 退回全局默认（仍标注来源 Agent，
 *   供 UI 显示「<Agent> · 跟随全局默认」，保留接待者关联）。
 */
export function resolveEffectiveModel(
  boundAgent:
    | { name: string; model?: string; provider?: string; display_name?: string }
    | undefined,
  globalDefault:
    | string
    | { modelId: string; providerId?: string; providerKey?: string },
): EffectiveModel {
  const globalModel =
    typeof globalDefault === 'string'
      ? { modelId: globalDefault }
      : globalDefault
  if (!boundAgent) {
    return {
      modelId: globalModel.modelId,
      ...(globalModel.providerId ? { providerId: globalModel.providerId } : {}),
      ...(globalModel.providerKey ? { providerKey: globalModel.providerKey } : {}),
      source: 'global',
    }
  }
  const agentLabel = boundAgent.display_name || boundAgent.name
  return boundAgent.model
    ? {
        modelId: boundAgent.model,
        ...(boundAgent.provider ? { providerKey: boundAgent.provider } : {}),
        source: 'agent',
        agentLabel,
      }
    : {
        modelId: globalModel.modelId,
        ...(globalModel.providerId ? { providerId: globalModel.providerId } : {}),
        ...(globalModel.providerKey ? { providerKey: globalModel.providerKey } : {}),
        source: 'global',
        agentLabel,
      }
}

interface ExactChannelModelIdentity {
  providerId: string
  providerKey: string
  modelId: string
}

/**
 * 按 Agent/provider 实例的精确身份匹配通道只读投影。
 *
 * 同一 modelId 可以同时存在于多个 Provider，缺少 Provider 身份时宁可不展示能力，
 * 也不能把另一 Provider 的推理支持误归到当前 Agent。
 */
export function resolveExactChannelModel<T extends ExactChannelModelIdentity>(
  effective: EffectiveModel,
  models: readonly T[],
): T | undefined {
  if (!effective.modelId) return undefined
  if (effective.providerId) {
    return models.find(
      (model) =>
        model.providerId === effective.providerId && model.modelId === effective.modelId,
    )
  }
  if (effective.providerKey) {
    return models.find(
      (model) =>
        model.providerKey === effective.providerKey && model.modelId === effective.modelId,
    )
  }
  return undefined
}
