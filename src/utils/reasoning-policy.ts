import type {
  DefaultReasoningPolicy,
  ModelReasoningControl,
  ModelReasoningSupport,
  ReasoningEffort,
  ReasoningPolicy,
} from '@/types'

export type {
  DefaultReasoningPolicy,
  ReasoningEffort,
  ReasoningPolicy,
} from '@/types'

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const DEFAULT_REASONING_POLICY: DefaultReasoningPolicy = { mode: 'auto' }

type ReasoningPolicySource = 'session' | 'agent' | 'global' | 'native'

export interface ResolvedReasoningPolicy {
  source: ReasoningPolicySource
  policy: ReasoningPolicy
}

export interface ReasoningRequest {
  thinkingEnabled: boolean
  thinkingEffort?: ReasoningEffort
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

export function cloneReasoningPolicy(policy: ReasoningPolicy): ReasoningPolicy {
  return policy.mode === 'effort'
    ? { mode: 'effort', effort: policy.effort }
    : { mode: policy.mode }
}

/** 不可信持久化值只接受完整的策略对象，其余统一视为 inherit。 */
export function normalizeReasoningPolicy(value: unknown): ReasoningPolicy {
  if (!isRecord(value) || typeof value.mode !== 'string') return { mode: 'inherit' }
  if (value.mode === 'effort') {
    if (!hasExactKeys(value, ['mode', 'effort']) || !isReasoningEffort(value.effort)) {
      return { mode: 'inherit' }
    }
    return { mode: 'effort', effort: value.effort }
  }
  if (
    (value.mode === 'inherit' || value.mode === 'auto' || value.mode === 'on' || value.mode === 'off') &&
    hasExactKeys(value, ['mode'])
  ) {
    return { mode: value.mode }
  }
  return { mode: 'inherit' }
}

/** 全局默认不能继承任何上层策略；旧值或非法值统一回到 auto。 */
export function normalizeDefaultReasoningPolicy(value: unknown): DefaultReasoningPolicy {
  const policy = normalizeReasoningPolicy(value)
  if (policy.mode === 'effort') return policy
  if (policy.mode === 'auto' || policy.mode === 'on' || policy.mode === 'off') {
    return { mode: policy.mode }
  }
  return { ...DEFAULT_REASONING_POLICY }
}

/** 只向 UI 暴露精确模型声明的 effort 值，畸形声明一律为空。 */
export function allowedReasoningEfforts(
  control: ModelReasoningControl | undefined,
): ReasoningEffort[] {
  if (control?.dialect !== 'reasoning_effort' || !Array.isArray(control.allowed_efforts)) return []
  const seen = new Set<ReasoningEffort>()
  const efforts: ReasoningEffort[] = []
  for (const effort of control.allowed_efforts) {
    if (!isReasoningEffort(effort) || seen.has(effort)) return []
    seen.add(effort)
    efforts.push(effort)
  }
  return efforts.length > 0 ? efforts : []
}

/** 从已验证的模型能力导出其原生思考策略，未知或不支持时保持关闭。 */
export function nativeReasoningPolicyFromControl(
  reasoningSupport: ModelReasoningSupport,
  control: ModelReasoningControl | undefined,
): ReasoningPolicy {
  if (reasoningSupport !== 'supported' || !control) return { mode: 'off' }
  if (control.dialect !== 'reasoning_effort') return { mode: 'on' }
  const efforts = allowedReasoningEfforts(control)
  return isReasoningEffort(control.on) && efforts.includes(control.on)
    ? { mode: 'effort', effort: control.on }
    : { mode: 'off' }
}

function normalizeNativePolicy(value: unknown): ReasoningPolicy {
  const policy = normalizeReasoningPolicy(value)
  return policy.mode === 'on' || policy.mode === 'off' || policy.mode === 'effort'
    ? policy
    : { mode: 'off' }
}

/** 统一实现 session > Agent > global > native 的优先级，auto 显式委托给模型原生值。 */
export function resolveReasoningPolicy(input: {
  sessionPolicy?: unknown
  agentPolicy?: unknown
  globalPolicy?: unknown
  nativePolicy?: unknown
}): ResolvedReasoningPolicy {
  const nativePolicy = normalizeNativePolicy(input.nativePolicy)
  const candidates: Array<{ source: Exclude<ReasoningPolicySource, 'native'>; policy: ReasoningPolicy }> = [
    { source: 'session', policy: normalizeReasoningPolicy(input.sessionPolicy) },
    { source: 'agent', policy: normalizeReasoningPolicy(input.agentPolicy) },
    { source: 'global', policy: normalizeDefaultReasoningPolicy(input.globalPolicy) },
  ]
  const selected = candidates.find((candidate) => candidate.policy.mode !== 'inherit')
  if (!selected) return { source: 'native', policy: cloneReasoningPolicy(nativePolicy) }
  return {
    source: selected.source,
    policy: selected.policy.mode === 'auto'
      ? cloneReasoningPolicy(nativePolicy)
      : cloneReasoningPolicy(selected.policy),
  }
}

/** 已解析策略转换为发送事实；布尔 dialect 永不取得 thinkingEffort。 */
export function toReasoningRequest(
  policyValue: unknown,
  reasoningSupport: ModelReasoningSupport,
  control: ModelReasoningControl | undefined,
): ReasoningRequest {
  const policy = normalizeReasoningPolicy(policyValue)
  if (reasoningSupport !== 'supported' || !control || policy.mode === 'off') {
    return { thinkingEnabled: false }
  }
  if (policy.mode === 'on') return { thinkingEnabled: true }
  if (policy.mode !== 'effort') return { thinkingEnabled: false }

  const efforts = allowedReasoningEfforts(control)
  return control.dialect === 'reasoning_effort' && efforts.includes(policy.effort)
    ? { thinkingEnabled: true, thinkingEffort: policy.effort }
    : { thinkingEnabled: true }
}
