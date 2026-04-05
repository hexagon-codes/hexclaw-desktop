/**
 * computeStructuredDiff 单元测试
 *
 * 验证结构化 hunk 分组、上下文行、合并逻辑和统计信息
 */
import { describe, it, expect } from 'vitest'
import { computeStructuredDiff } from '../diff'

/** 生成 N 行文本 */
function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')
}

describe('computeStructuredDiff', () => {
  // ─── 1. 相同文本 → 空 hunks ──────────────────────────
  it('identical texts → empty hunks, stats all zeros for additions/deletions', () => {
    const text = 'aaa\nbbb\nccc'
    const result = computeStructuredDiff(text, text)
    expect(result.hunks).toHaveLength(0)
    expect(result.stats.additions).toBe(0)
    expect(result.stats.deletions).toBe(0)
    expect(result.stats.unchanged).toBe(3)
  })

  // ─── 2. 单行变更 → 一个 hunk + context ────────────────
  it('single line change → one hunk with context lines', () => {
    const oldText = lines(10)
    // 修改第 5 行
    const newLines = oldText.split('\n')
    newLines[4] = 'CHANGED 5'
    const newText = newLines.join('\n')

    const result = computeStructuredDiff(oldText, newText, 3)
    expect(result.hunks).toHaveLength(1)

    const hunk = result.hunks[0]!
    // hunk 应包含 3 行前上下文 + remove + add + 3 行后上下文 = 8 行
    expect(hunk.lines).toHaveLength(8)
    expect(hunk.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    expect(result.stats.additions).toBe(1)
    expect(result.stats.deletions).toBe(1)
  })

  // ─── 3. 多处分散变更 → 多个 hunk ─────────────────────
  it('multiple scattered changes → multiple hunks', () => {
    // 20 行，修改第 3 行和第 18 行（间距 > 2*3=6）
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const newLines = [...oldLines]
    newLines[2] = 'CHANGED 3'
    newLines[17] = 'CHANGED 18'
    const result = computeStructuredDiff(oldLines.join('\n'), newLines.join('\n'), 3)

    expect(result.hunks.length).toBe(2)
    expect(result.stats.additions).toBe(2)
    expect(result.stats.deletions).toBe(2)
  })

  // ─── 4. 文件开头变更 → 无前置上下文 ──────────────────
  it('change at file start → hunk with no preceding context', () => {
    const oldText = lines(8)
    const newLines = oldText.split('\n')
    newLines[0] = 'CHANGED 1'
    const newText = newLines.join('\n')

    const result = computeStructuredDiff(oldText, newText, 3)
    expect(result.hunks).toHaveLength(1)

    const hunk = result.hunks[0]!
    // 第一行就是变更，前面没有 context
    // remove + add + 3 行 trailing context = 5 行
    expect(hunk.lines).toHaveLength(5)
    expect(hunk.oldStart).toBe(1)
    expect(hunk.newStart).toBe(1)
  })

  // ─── 5. 文件末尾变更 → 无后置上下文 ──────────────────
  it('change at file end → hunk with no trailing context', () => {
    const oldText = lines(8)
    const newLines = oldText.split('\n')
    newLines[7] = 'CHANGED 8'
    const newText = newLines.join('\n')

    const result = computeStructuredDiff(oldText, newText, 3)
    expect(result.hunks).toHaveLength(1)

    const hunk = result.hunks[0]!
    // 3 行 leading context + remove + add = 5 行
    expect(hunk.lines).toHaveLength(5)
  })

  // ─── 6. 相邻变更合并为一个 hunk ──────────────────────
  it('adjacent changes merged into one hunk', () => {
    // 15 行，修改第 5 行和第 8 行（间距 2，< 2*3=6）
    const oldLines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`)
    const newLines = [...oldLines]
    newLines[4] = 'CHANGED 5'
    newLines[7] = 'CHANGED 8'
    const result = computeStructuredDiff(oldLines.join('\n'), newLines.join('\n'), 3)

    // 间距 2 < 6，应合并为一个 hunk
    expect(result.hunks).toHaveLength(1)
  })

  // ─── 7. 大文件小变更 → 只包含受影响区域 ──────────────
  it('large file with small change → only affected hunk, not entire file', () => {
    const oldLines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
    const newLines = [...oldLines]
    newLines[99] = 'CHANGED 100'
    const result = computeStructuredDiff(oldLines.join('\n'), newLines.join('\n'), 3)

    expect(result.hunks).toHaveLength(1)
    const hunk = result.hunks[0]!
    // 3 + remove + add + 3 = 8 行，远少于 200
    expect(hunk.lines.length).toBeLessThan(20)
    expect(hunk.lines.length).toBe(8)
  })

  // ─── 8. contextLines 参数生效 ─────────────────────────
  describe('context lines parameter', () => {
    const makeChange = () => {
      const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
      const newLines = [...oldLines]
      newLines[9] = 'CHANGED 10' // 修改第 10 行
      return { oldText: oldLines.join('\n'), newText: newLines.join('\n') }
    }

    it('contextLines = 0 → only changed lines', () => {
      const { oldText, newText } = makeChange()
      const result = computeStructuredDiff(oldText, newText, 0)
      expect(result.hunks).toHaveLength(1)
      // 0 context → remove + add = 2 行
      expect(result.hunks[0]!.lines).toHaveLength(2)
      expect(result.hunks[0]!.lines.every((l) => l.type !== 'equal')).toBe(true)
    })

    it('contextLines = 1 → 1 line before and after', () => {
      const { oldText, newText } = makeChange()
      const result = computeStructuredDiff(oldText, newText, 1)
      expect(result.hunks).toHaveLength(1)
      // 1 + remove + add + 1 = 4 行
      expect(result.hunks[0]!.lines).toHaveLength(4)
    })

    it('contextLines = 3 (default) → 3 lines before and after', () => {
      const { oldText, newText } = makeChange()
      const result = computeStructuredDiff(oldText, newText, 3)
      expect(result.hunks).toHaveLength(1)
      // 3 + remove + add + 3 = 8 行
      expect(result.hunks[0]!.lines).toHaveLength(8)
    })

    it('contextLines = 5 → 5 lines before and after', () => {
      const { oldText, newText } = makeChange()
      const result = computeStructuredDiff(oldText, newText, 5)
      expect(result.hunks).toHaveLength(1)
      // 5 + remove + add + 5 = 12 行
      expect(result.hunks[0]!.lines).toHaveLength(12)
    })
  })

  // ─── 9. 统计数据正确 ─────────────────────────────────
  it('stats calculation correct', () => {
    // 删除 2 行，新增 3 行，保留 3 行
    const oldText = 'keep1\nremove1\nkeep2\nremove2\nkeep3'
    const newText = 'keep1\nadd1\nkeep2\nadd2\nadd3\nkeep3'
    const result = computeStructuredDiff(oldText, newText)

    expect(result.stats.deletions).toBe(2)
    expect(result.stats.additions).toBe(3)
    expect(result.stats.unchanged).toBe(3)
  })

  // ─── Header 格式验证 ─────────────────────────────────
  it('hunk header has correct format', () => {
    const result = computeStructuredDiff('a\nb\nc', 'a\nB\nc', 1)
    expect(result.hunks).toHaveLength(1)
    const hunk = result.hunks[0]!
    expect(hunk.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    // old: 1 context + 1 removed = 2 old lines; new: 1 context + 1 added = 2 new lines ...
    // actually: context_before(a) + remove(b) + add(B) + context_after(c) → old=3 new=3
    expect(hunk.oldLines).toBe(3)
    expect(hunk.newLines).toBe(3)
  })

  // ─── 纯新增行 ────────────────────────────────────────
  it('pure addition → stats reflect only additions', () => {
    const result = computeStructuredDiff('a\nb', 'a\nx\nb')
    expect(result.stats.additions).toBe(1)
    expect(result.stats.deletions).toBe(0)
    expect(result.hunks).toHaveLength(1)
  })

  // ─── 纯删除行 ────────────────────────────────────────
  it('pure deletion → stats reflect only deletions', () => {
    const result = computeStructuredDiff('a\nx\nb', 'a\nb')
    expect(result.stats.deletions).toBe(1)
    expect(result.stats.additions).toBe(0)
    expect(result.hunks).toHaveLength(1)
  })

  // ─── 空字符串 ────────────────────────────────────────
  it('empty to content → single add hunk', () => {
    const result = computeStructuredDiff('', 'hello')
    expect(result.stats.additions).toBe(1)
    expect(result.stats.deletions).toBe(1) // empty string splits to [''] which differs from ['hello']
    expect(result.hunks).toHaveLength(1)
  })
})
