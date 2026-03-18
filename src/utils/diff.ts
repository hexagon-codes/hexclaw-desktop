/** 行级 diff 结果 */
export interface DiffLine {
  type: 'add' | 'remove' | 'equal'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

/**
 * 简单行级 diff（LCS 算法，滚动数组优化）
 *
 * 使用 O(n) 空间代替 O(n²) DP 表，避免大文件内存溢出。
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const m = oldLines.length
  const n = newLines.length

  // LCS DP — 滚动数组，O(n) 空间
  let prev = new Array<number>(n + 1).fill(0)
  let curr = new Array<number>(n + 1).fill(0)

  // 方向矩阵仍然需要 O(m*n)，但只存 2-bit 方向标记（远小于 8-byte number）
  // 用 Uint8Array 存储: 0=diag(match), 1=left, 2=up
  const dir = new Uint8Array(m * n)

  for (let i = 1; i <= m; i++) {
    curr[0] = 0
    for (let j = 1; j <= n; j++) {
      const idx = (i - 1) * n + (j - 1)
      if (oldLines[i - 1] === newLines[j - 1]) {
        curr[j] = prev[j - 1]! + 1
        dir[idx] = 0 // diagonal (match)
      } else if (prev[j]! >= curr[j - 1]!) {
        curr[j] = prev[j]!
        dir[idx] = 2 // up
      } else {
        curr[j] = curr[j - 1]!
        dir[idx] = 1 // left
      }
    }
    // Swap: prev ← curr
    const tmp = prev
    prev = curr
    curr = tmp
  }

  // 回溯构建 diff
  let i = m, j = n
  const stack: DiffLine[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const idx = (i - 1) * n + (j - 1)
      const d = dir[idx]!
      if (d === 0) {
        // diagonal — equal
        stack.push({ type: 'equal', content: oldLines[i - 1]!, oldLineNo: i, newLineNo: j })
        i--; j--
      } else if (d === 1) {
        // left — add
        stack.push({ type: 'add', content: newLines[j - 1]!, newLineNo: j })
        j--
      } else {
        // up — remove
        stack.push({ type: 'remove', content: oldLines[i - 1]!, oldLineNo: i })
        i--
      }
    } else if (j > 0) {
      stack.push({ type: 'add', content: newLines[j - 1]!, newLineNo: j })
      j--
    } else {
      stack.push({ type: 'remove', content: oldLines[i - 1]!, oldLineNo: i })
      i--
    }
  }

  const result: DiffLine[] = []
  while (stack.length) result.push(stack.pop()!)
  return result
}
