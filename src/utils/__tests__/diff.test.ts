/**
 * diff.ts 单元测试
 *
 * 验证 LCS diff 算法的正确性和边界情况
 */
import { describe, it, expect } from 'vitest'
import { computeDiff } from '../diff'

describe('computeDiff', () => {
  it('空字符串 diff 应该只有一个 equal 空行', () => {
    const result = computeDiff('', '')
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('equal')
  })

  it('相同内容应该全部是 equal', () => {
    const text = 'line1\nline2\nline3'
    const result = computeDiff(text, text)
    expect(result.every((d) => d.type === 'equal')).toBe(true)
    expect(result).toHaveLength(3)
  })

  it('完全不同的内容应该全部是 remove + add', () => {
    const result = computeDiff('aaa', 'bbb')
    const removes = result.filter((d) => d.type === 'remove')
    const adds = result.filter((d) => d.type === 'add')
    expect(removes).toHaveLength(1)
    expect(adds).toHaveLength(1)
  })

  it('新增行应该被正确标记', () => {
    const result = computeDiff('line1\nline2', 'line1\nline1.5\nline2')
    const adds = result.filter((d) => d.type === 'add')
    expect(adds).toHaveLength(1)
    expect(adds[0]!.content).toBe('line1.5')
  })

  it('删除行应该被正确标记', () => {
    const result = computeDiff('line1\nline2\nline3', 'line1\nline3')
    const removes = result.filter((d) => d.type === 'remove')
    expect(removes).toHaveLength(1)
    expect(removes[0]!.content).toBe('line2')
  })

  it('行号应该正确', () => {
    const result = computeDiff('a\nb\nc', 'a\nc')
    const equalLines = result.filter(l => l.type === 'equal')
    const removeLines = result.filter(l => l.type === 'remove')
    const addLines = result.filter(l => l.type === 'add')

    for (const line of equalLines) {
      expect(line.oldLineNo).toBeDefined()
      expect(line.newLineNo).toBeDefined()
    }
    for (const line of removeLines) {
      expect(line.oldLineNo).toBeDefined()
    }
    for (const line of addLines) {
      expect(line.newLineNo).toBeDefined()
    }
  })

  // ─── 性能改进验证 ──────────────────────────────────
  it('大文件 diff 不应该超时（1000 行）', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`)
    const oldText = lines.join('\n')
    // 修改 10% 的行
    const newLines = lines.map((l, i) => (i % 10 === 0 ? `modified ${i}` : l))
    const newText = newLines.join('\n')

    const start = performance.now()
    const result = computeDiff(oldText, newText)
    const elapsed = performance.now() - start

    expect(result.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1000)
  })

  it('滚动数组优化: 使用 Uint8Array 方向矩阵而非完整 DP 表', async () => {
    // 验证源码使用了优化实现
    const sourceCode = await import('../diff?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default
    // 应使用 Uint8Array 方向矩阵
    expect(raw).toContain('Uint8Array')
    // 不应有完整的 (m+1)*(n+1) 二维数组
    expect(raw).not.toContain('Array.from({ length: m + 1 }, () => new Array<number>(n + 1)')
  })
})
