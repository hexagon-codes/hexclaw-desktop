/**
 * canvas condition 节点配置校验（与后端 workflow_condition.go parseConditionRules 对齐）。
 * 在保存/运行工作流前调用，把「非法 op / 缺 target / target 不是本节点出边」等错误在前端
 * 提前暴露，而非等到后端运行时才 failed。
 */
import {
  CONDITION_OPERATORS,
  type CanvasEdge,
  type ConditionNodeConfig,
  type ConditionOperator,
  type ConditionRule,
} from '@/types/canvas'

function isOperator(op: unknown): op is ConditionOperator {
  return typeof op === 'string' && (CONDITION_OPERATORS as string[]).includes(op)
}

/** 从任意 config 读出 condition 配置（宽松解析，便于校验旧数据）。 */
export function parseConditionConfig(config: Record<string, unknown> | undefined): ConditionNodeConfig {
  const raw = config ?? {}
  const list = Array.isArray(raw.conditions) ? raw.conditions : []
  const conditions: ConditionRule[] = list.map((item) => {
    const m = (item ?? {}) as Record<string, unknown>
    return {
      op: (m.op as ConditionOperator) ?? ('eq' as ConditionOperator),
      value: typeof m.value === 'string' ? m.value : m.value != null ? String(m.value) : undefined,
      target: typeof m.target === 'string' ? m.target : '',
    }
  })
  return {
    source: typeof raw.source === 'string' ? raw.source : undefined,
    conditions,
    default: typeof raw.default === 'string' ? raw.default : undefined,
  }
}

/**
 * 校验一个 condition 节点。返回错误信息数组（空=合法）。
 * @param nodeId condition 节点 id
 * @param config 节点 config
 * @param edges  整个工作流的边（用于校验 target/default 确为本节点出边）
 */
export function validateConditionConfig(
  nodeId: string,
  config: Record<string, unknown> | undefined,
  edges: CanvasEdge[],
): string[] {
  const errors: string[] = []
  const cfg = parseConditionConfig(config)
  const outgoing = new Set(edges.filter((e) => e.from === nodeId).map((e) => e.to))

  // 无条件规则 = 占位/直通，合法（向后兼容）。
  if (cfg.conditions.length === 0 && !cfg.default) return errors

  cfg.conditions.forEach((rule, i) => {
    if (!isOperator(rule.op)) {
      errors.push(`条件 ${i + 1}：op=${String(rule.op)} 不支持`)
    }
    if (!rule.target) {
      errors.push(`条件 ${i + 1}：缺少 target（命中时激活的下游节点）`)
    } else if (!outgoing.has(rule.target)) {
      errors.push(`条件 ${i + 1}：target=${rule.target} 不是本节点的出边`)
    }
  })
  if (cfg.default && !outgoing.has(cfg.default)) {
    errors.push(`default=${cfg.default} 不是本节点的出边`)
  }
  return errors
}
