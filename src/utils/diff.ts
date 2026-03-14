/** 行级 diff 结果 */
export interface DiffLine {
  type: 'add' | 'remove' | 'equal'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

/** 简单行级 diff（LCS 算法） */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const m = oldLines.length
  const n = newLines.length

  // LCS DP
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }

  // 回溯构建 diff
  const result: DiffLine[] = []
  let i = m, j = n
  const stack: DiffLine[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'equal', content: oldLines[i - 1]!, oldLineNo: i, newLineNo: j })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      stack.push({ type: 'add', content: newLines[j - 1]!, newLineNo: j })
      j--
    } else {
      stack.push({ type: 'remove', content: oldLines[i - 1]!, oldLineNo: i })
      i--
    }
  }

  while (stack.length) result.push(stack.pop()!)
  return result
}
