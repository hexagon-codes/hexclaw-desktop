/**
 * RuntimeBudget — Runtime 资源预算类型定义
 *
 * 非功能性约束的数值边界，Phase 4 固定 warn-only。
 *
 * @see docs/agents-OS/Runtime-Budget.md
 */

export interface RuntimeBudget {
  /** 单 Context 大小上限（bytes） */
  maxContextSize: number
  /** 同时加载的层数上限 */
  maxLayers: number
}

export const DEFAULT_BUDGET: RuntimeBudget = {
  maxContextSize: 1_048_576, // 1MB
  maxLayers: 5,
}
