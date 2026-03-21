/** 行级 diff 结果 */
export interface DiffLine {
  type: 'add' | 'remove' | 'equal'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

const MAX_LCS_CELLS = 4_000_000

/**
 * Simple line-by-line diff for large files (O(m+n) memory).
 * Falls back to this when LCS would exceed MAX_LCS_CELLS.
 */
function computeDiffSimple(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = []
  const maxLen = Math.max(oldLines.length, newLines.length)
  let oi = 0, ni = 0
  while (oi < oldLines.length && ni < newLines.length) {
    if (oldLines[oi] === newLines[ni]) {
      result.push({ type: 'equal', content: oldLines[oi]!, oldLineNo: oi + 1, newLineNo: ni + 1 })
      oi++; ni++
    } else {
      result.push({ type: 'remove', content: oldLines[oi]!, oldLineNo: oi + 1 })
      result.push({ type: 'add', content: newLines[ni]!, newLineNo: ni + 1 })
      oi++; ni++
    }
  }
  while (oi < oldLines.length) {
    result.push({ type: 'remove', content: oldLines[oi]!, oldLineNo: oi + 1 })
    oi++
  }
  while (ni < newLines.length) {
    result.push({ type: 'add', content: newLines[ni]!, newLineNo: ni + 1 })
    ni++
  }
  return result
}

/**
 * 行级 diff（LCS 算法，滚动数组 + 方向矩阵）
 *
 * 对于超大文件（m*n > 4M cells）降级到简单逐行比较以避免 OOM。
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const m = oldLines.length
  const n = newLines.length

  if (m * n > MAX_LCS_CELLS) {
    return computeDiffSimple(oldLines, newLines)
  }

  let prev = new Array<number>(n + 1).fill(0)
  let curr = new Array<number>(n + 1).fill(0)

  // 0=diag(match), 1=left, 2=up
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
