/**
 * MarkdownRenderer Code Review — 验证性能和生命周期修复
 */
import { describe, it, expect } from 'vitest'

describe('MarkdownRenderer — 性能和生命周期（修复后）', () => {
  it('MarkdownIt 实例被缓存在 computed 外部', async () => {
    const sourceCode = await import('../MarkdownRenderer.vue?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain('mdInstance')
    expect(raw).toContain('const rendered = computed')
    expect(raw).not.toContain('const md = createMarkdownRenderer')
  })

  it('使用实例计数器替代模块级 initialized 标志', async () => {
    const sourceCode = await import('../MarkdownRenderer.vue?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain('activeInstanceCount')
    expect(raw).not.toContain('let initialized = false')
  })
})
