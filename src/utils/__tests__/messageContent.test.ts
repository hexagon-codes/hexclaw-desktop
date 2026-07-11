import { describe, it, expect } from 'vitest'
import { sanitizeMessageContent } from '../messageContent'

describe('sanitizeMessageContent · 只截断真图像 base64，不误伤长英文/代码', () => {
  it('空内容 → 空串', () => {
    expect(sanitizeMessageContent('')).toBe('')
  })

  it('<=800 字符直接短路返回原文（哪怕像 base64）', () => {
    const s = 'A'.repeat(700)
    expect(sanitizeMessageContent(s)).toBe(s)
  })

  it('>800 字符的长英文/代码段落不被替换（含空格/标点，无长 base64 run）', () => {
    const prose =
      'The quick brown fox jumps over the lazy dog. '.repeat(40) // ~1800 chars，有空格
    expect(prose.length).toBeGreaterThan(800)
    expect(sanitizeMessageContent(prose)).toBe(prose)
  })

  it('data:image/...;base64,... 被替换为占位符，周围文字保留', () => {
    const b64 = 'AAAA'.repeat(80) // 320 chars
    const content = '这是我生成的图片：data:image/png;base64,' + b64 + ' 请查收。' + 'x'.repeat(600)
    const out = sanitizeMessageContent(content)
    expect(out).toContain('[图像数据 · 历史消息已截断]')
    expect(out).toContain('这是我生成的图片：')
    expect(out).toContain('请查收。')
    expect(out).not.toContain(b64)
  })

  it('600+ 连续裸 base64 run 被替换，周围文字保留', () => {
    const run = 'aB3dEfGhIjKl'.repeat(70) // 840 chars 连续无空白（总长 > 800 越过短路）
    const content = '前缀说明文字。' + run + '后缀说明文字。'
    const out = sanitizeMessageContent(content)
    expect(out).toContain('[图像数据 · 历史消息已截断]')
    expect(out).toContain('前缀说明文字。')
    expect(out).toContain('后缀说明文字。')
    expect(out).not.toContain(run)
  })
})
