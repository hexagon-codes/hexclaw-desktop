/**
 * @ 召唤上下文注入工具单测。
 */
import { describe, it, expect } from 'vitest'
import { clampContent, formatContextBlock, CONTEXT_CONTENT_BUDGET } from '@/utils/chat-context'
import type { ChatContextRef } from '@/types'

const ref = (over: Partial<ChatContextRef>): ChatContextRef => ({
  type: 'knowledge', id: 'd1', label: 'doc', content: 'hello', ...over,
})

describe('clampContent', () => {
  it('短内容原样', () => {
    expect(clampContent('abc')).toBe('abc')
  })
  it('超预算截断 + 省略标记', () => {
    const long = 'x'.repeat(CONTEXT_CONTENT_BUDGET + 100)
    const out = clampContent(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain('已截断')
  })
})

describe('formatContextBlock', () => {
  it('空引用 → 空串', () => {
    expect(formatContextBlock([])).toBe('')
  })
  it('过滤空 content', () => {
    expect(formatContextBlock([ref({ content: '   ' })])).toBe('')
  })
  it('多条引用拼成带来源说明的块', () => {
    const block = formatContextBlock([
      ref({ content: '知识正文' }),
      ref({ type: 'connection', content: '【连接·github】' }),
    ])
    expect(block).toContain('参考上下文')
    expect(block).toContain('知识正文')
    expect(block).toContain('【连接·github】')
  })
})
