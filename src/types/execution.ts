/**
 * Execution — Runtime State Machine 类型定义
 *
 * Execution Runtime = Runtime State Machine。
 * 不是 Agent Thought Runtime / Tool Runtime / Workflow Engine。
 *
 * @see docs/agents-OS/Execution-Spec.md
 */

// ─── 状态 ──────────────────────────────────────────────

/** Execution 生命周期状态 */
export type ExecutionState = 'idle' | 'preparing' | 'running' | 'completed' | 'failed'

/** Execution 当前阶段（有限枚举，不允许自由文本） */
export type ExecutionStage = 'preparing' | 'executing' | 'finalizing'

// ─── 状态转换 ──────────────────────────────────────────

/** Execution 状态转换表 */
export const EXECUTION_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  'idle':       ['preparing'],
  'preparing':  ['running'],
  'running':    ['completed', 'failed'],
  'completed':  [],
  'failed':     [],
}

/** 检查状态转换是否合法 */
export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return EXECUTION_TRANSITIONS[from]?.includes(to) ?? false
}

// ─── 中间状态 ──────────────────────────────────────────

/**
 * 轻量中间状态。
 * 不允许 Record<string, unknown> / 大文本 / reasoning trace。
 */
export interface ExecutionIntermediateState {
  progress?: number
  lastUpdate?: string    // ISO
}
