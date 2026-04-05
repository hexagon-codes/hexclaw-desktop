/** 行级 diff 结果 */
export interface DiffLine {
  type: 'add' | 'remove' | 'equal'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

/** 结构化 Diff Hunk — 一组连续变更 + 上下文 */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
  header: string // e.g., "@@ -10,5 +12,7 @@"
}

/** 结构化 Diff 结果 */
export interface StructuredDiff {
  hunks: DiffHunk[]
  stats: { additions: number; deletions: number; unchanged: number }
}

const MAX_LCS_CELLS = 4_000_000

/**
 * Pre-pass: strip common prefix and suffix to reduce the LCS input size.
 * Sparse edits (1k lines with a few changes) become tiny LCS problems.
 */
function trimCommon(oldLines: string[], newLines: string[]) {
  let prefixLen = 0
  const minLen = Math.min(oldLines.length, newLines.length)
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++
  }
  let suffixLen = 0
  const maxSuffix = minLen - prefixLen
  while (
    suffixLen < maxSuffix &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++
  }
  return {
    prefixLen,
    suffixLen,
    oldMiddle: oldLines.slice(prefixLen, oldLines.length - suffixLen),
    newMiddle: newLines.slice(prefixLen, newLines.length - suffixLen),
  }
}

/**
 * Simple line-by-line diff for large files (O(m+n) memory).
 * Falls back to this when LCS would exceed MAX_LCS_CELLS.
 */
function computeDiffSimple(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = []
  let oi = 0,
    ni = 0
  while (oi < oldLines.length && ni < newLines.length) {
    if (oldLines[oi] === newLines[ni]) {
      result.push({ type: 'equal', content: oldLines[oi]!, oldLineNo: oi + 1, newLineNo: ni + 1 })
      oi++
      ni++
    } else {
      result.push({ type: 'remove', content: oldLines[oi]!, oldLineNo: oi + 1 })
      result.push({ type: 'add', content: newLines[ni]!, newLineNo: ni + 1 })
      oi++
      ni++
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

  // Pre-pass: strip common prefix/suffix to shrink LCS input
  const { prefixLen, suffixLen, oldMiddle, newMiddle } = trimCommon(oldLines, newLines)
  const m = oldMiddle.length
  const n = newMiddle.length

  // Build prefix equal lines
  const result: DiffLine[] = []
  for (let k = 0; k < prefixLen; k++) {
    result.push({ type: 'equal', content: oldLines[k]!, oldLineNo: k + 1, newLineNo: k + 1 })
  }

  if (m === 0 && n === 0) {
    // Only suffix remains
  } else if (m * n > MAX_LCS_CELLS) {
    const simple = computeDiffSimple(oldMiddle, newMiddle)
    for (const l of simple) {
      if (l.oldLineNo) l.oldLineNo += prefixLen
      if (l.newLineNo) l.newLineNo += prefixLen
      result.push(l)
    }
  } else {
    // LCS on the reduced middle
    let prev = new Uint32Array(n + 1)
    let curr = new Uint32Array(n + 1)
    const dir = new Uint8Array(m * n)

    for (let i = 1; i <= m; i++) {
      curr[0] = 0
      for (let j = 1; j <= n; j++) {
        const idx = (i - 1) * n + (j - 1)
        if (oldMiddle[i - 1] === newMiddle[j - 1]) {
          curr[j] = prev[j - 1]! + 1
          dir[idx] = 0
        } else if (prev[j]! >= curr[j - 1]!) {
          curr[j] = prev[j]!
          dir[idx] = 2
        } else {
          curr[j] = curr[j - 1]!
          dir[idx] = 1
        }
      }
      const tmp = prev
      prev = curr
      curr = tmp
    }

    // Backtrack
    let i = m, j = n
    const stack: DiffLine[] = []
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0) {
        const idx = (i - 1) * n + (j - 1)
        const d = dir[idx]!
        if (d === 0) {
          stack.push({ type: 'equal', content: oldMiddle[i - 1]!, oldLineNo: i + prefixLen, newLineNo: j + prefixLen })
          i--; j--
        } else if (d === 1) {
          stack.push({ type: 'add', content: newMiddle[j - 1]!, newLineNo: j + prefixLen })
          j--
        } else {
          stack.push({ type: 'remove', content: oldMiddle[i - 1]!, oldLineNo: i + prefixLen })
          i--
        }
      } else if (j > 0) {
        stack.push({ type: 'add', content: newMiddle[j - 1]!, newLineNo: j + prefixLen })
        j--
      } else {
        stack.push({ type: 'remove', content: oldMiddle[i - 1]!, oldLineNo: i + prefixLen })
        i--
      }
    }
    while (stack.length) result.push(stack.pop()!)
  }

  // Append suffix equal lines
  const oldSuffixStart = oldLines.length - suffixLen
  const newSuffixStart = newLines.length - suffixLen
  for (let k = 0; k < suffixLen; k++) {
    result.push({
      type: 'equal',
      content: oldLines[oldSuffixStart + k]!,
      oldLineNo: oldSuffixStart + k + 1,
      newLineNo: newSuffixStart + k + 1,
    })
  }

  return result
}

/**
 * 结构化 diff：将 flat DiffLine[] 按 hunk 分组，附带上下文行和统计信息
 *
 * 匹配 claw-code 的 StructuredPatchHunk 模式。
 */
export function computeStructuredDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
): StructuredDiff {
  const allLines = computeDiff(oldText, newText)

  // ── 统计 ──
  let additions = 0
  let deletions = 0
  let unchanged = 0
  for (const l of allLines) {
    if (l.type === 'add') additions++
    else if (l.type === 'remove') deletions++
    else unchanged++
  }
  const stats = { additions, deletions, unchanged }

  // 快速路径：无变更
  if (additions === 0 && deletions === 0) {
    return { hunks: [], stats }
  }

  // ── 找出所有变更行的索引 ──
  const changeIndices: number[] = []
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i]!.type !== 'equal') {
      changeIndices.push(i)
    }
  }

  // ── 将变更分成组（gap < 2*contextLines 时合并） ──
  const groups: Array<{ first: number; last: number }> = []
  let groupStart = changeIndices[0]!
  let groupEnd = changeIndices[0]!

  for (let k = 1; k < changeIndices.length; k++) {
    const idx = changeIndices[k]!
    // 两组变更之间的 equal 行数
    if (idx - groupEnd - 1 <= 2 * contextLines) {
      // 合并
      groupEnd = idx
    } else {
      groups.push({ first: groupStart, last: groupEnd })
      groupStart = idx
      groupEnd = idx
    }
  }
  groups.push({ first: groupStart, last: groupEnd })

  // ── 为每组构建 hunk ──
  const hunks: DiffHunk[] = []

  for (const g of groups) {
    const start = Math.max(0, g.first - contextLines)
    const end = Math.min(allLines.length - 1, g.last + contextLines)
    const hunkLines = allLines.slice(start, end + 1)

    // 计算 oldStart / newStart 基于 hunk 第一行
    const firstLine = hunkLines[0]!
    let oldStart: number
    let newStart: number
    if (firstLine.type === 'equal') {
      oldStart = firstLine.oldLineNo!
      newStart = firstLine.newLineNo!
    } else if (firstLine.type === 'remove') {
      oldStart = firstLine.oldLineNo!
      // newStart: 从之前的 equal 行推算，或默认 1
      newStart = inferNewStart(allLines, start)
    } else {
      // add
      newStart = firstLine.newLineNo!
      oldStart = inferOldStart(allLines, start)
    }

    let oldLineCount = 0
    let newLineCount = 0
    for (const l of hunkLines) {
      if (l.type === 'equal') {
        oldLineCount++
        newLineCount++
      } else if (l.type === 'remove') {
        oldLineCount++
      } else {
        newLineCount++
      }
    }

    const header = `@@ -${oldStart},${oldLineCount} +${newStart},${newLineCount} @@`
    hunks.push({
      oldStart,
      oldLines: oldLineCount,
      newStart,
      newLines: newLineCount,
      lines: hunkLines,
      header,
    })
  }

  return { hunks, stats }
}

/** 从给定位置向前回溯推算 newLineNo */
function inferNewStart(allLines: DiffLine[], idx: number): number {
  for (let i = idx - 1; i >= 0; i--) {
    const l = allLines[i]!
    if (l.newLineNo !== undefined) return l.newLineNo + 1
  }
  return 1
}

/** 从给定位置向前回溯推算 oldLineNo */
function inferOldStart(allLines: DiffLine[], idx: number): number {
  for (let i = idx - 1; i >= 0; i--) {
    const l = allLines[i]!
    if (l.oldLineNo !== undefined) return l.oldLineNo + 1
  }
  return 1
}
