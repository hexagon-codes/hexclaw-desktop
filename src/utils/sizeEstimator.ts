/**
 * SizeEstimator — 统一大小估算器
 *
 * 策略：JSON.stringify().length。
 * 估算 ≠ 精确内存占用，用于相对比较和 Budget 报警。
 *
 * @see docs/agents-OS/Context-Contract.md
 */

export function estimateSize(obj: unknown): number {
  if (obj === null || obj === undefined) return 0
  try {
    return JSON.stringify(obj).length
  } catch {
    return 0
  }
}
