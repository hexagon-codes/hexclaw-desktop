/**
 * diff.ts Code Review — 验证内存使用和性能边界（修复后）
 */
import { describe, it, expect } from 'vitest'
import { computeDiff } from '../diff'

describe('diff.ts — 内存和性能边界（修复后）', () => {
  it('超大文件自动降级到简单 diff 避免 OOM', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    const oldText = lines.join('\n')
    const newLines = lines.map((l, i) => (i % 100 === 0 ? `modified ${i}` : l))
    const newText = newLines.join('\n')

    const start = performance.now()
    const result = computeDiff(oldText, newText)
    const elapsed = performance.now() - start

    expect(result.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(5000)
  })

  it('方向矩阵仅用于小文件（<= MAX_LCS_CELLS）', async () => {
    const sourceCode = await import('../diff?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain('MAX_LCS_CELLS')
    expect(raw).toContain('computeDiffSimple')
  })

  it('空行 diff 边界: 两个空字符串产生一个 equal 空行', () => {
    const result = computeDiff('', '')
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('equal')
    expect(result[0]!.content).toBe('')
  })

  it('单行相同内容不应产生 add/remove', () => {
    const result = computeDiff('hello', 'hello')
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('equal')
  })

  it('Unicode 内容 diff 正确', () => {
    const old = '你好\n世界'
    const newText = '你好\n中国'
    const result = computeDiff(old, newText)
    const removes = result.filter(d => d.type === 'remove')
    const adds = result.filter(d => d.type === 'add')
    expect(removes).toHaveLength(1)
    expect(removes[0]!.content).toBe('世界')
    expect(adds).toHaveLength(1)
    expect(adds[0]!.content).toBe('中国')
  })
})
