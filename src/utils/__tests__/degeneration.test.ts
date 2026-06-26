import { describe, it, expect } from 'vitest'
import { isDegenerateTail, trimDegenerateTail, DEGENERATION_NOTICE } from '../degeneration'

describe('isDegenerateTail — 失控复读退化检测（BUG-20260625 模型塌缩熔断）', () => {
  it('★复现型：0000 长串 → 命中', () => {
    expect(isDegenerateTail('好的，'.padEnd(3) + '0'.repeat(200))).toBe(true)
  })

  it('★复现型：586158615861… 短周期(4)复读 → 命中', () => {
    expect(isDegenerateTail('8525715' + '5861'.repeat(60))).toBe(true)
  })

  it('★复现型：周期 2「ababab…」长串 → 命中', () => {
    expect(isDegenerateTail('ab'.repeat(100))).toBe(true)
  })

  it('★复现型：中文「哈哈哈…」极端长串 → 命中', () => {
    expect(isDegenerateTail('哈'.repeat(100))).toBe(true)
  })

  // ── 反面：正常输出绝不能误报 ──
  it('正常中文回复 → 不命中', () => {
    const s = '根据我的搜索结果，存在主义和荒诞哲学是两个不同的哲学流派。存在主义主要探讨人类存在的意义、自由和责任，而荒诞哲学关注存在的荒谬性。'
    expect(isDegenerateTail(s)).toBe(false)
  })

  it('正常英文回复 → 不命中', () => {
    const s = 'Existentialism and absurdism are two distinct philosophical schools that examine the meaning of human existence in different ways.'
    expect(isDegenerateTail(s)).toBe(false)
  })

  it('含正常重复词（"非常非常非常好"短重复）→ 不命中', () => {
    expect(isDegenerateTail('这个方案非常非常非常好，我很满意，建议尽快推进落地。')).toBe(false)
  })

  it('代码/数字混合（不构成长周期精确复读）→ 不命中', () => {
    expect(isDegenerateTail('const ids = [101, 202, 303, 404, 505]; return ids.map(x => x * 2)')).toBe(false)
  })

  it('短文本（< minRun）→ 不命中（避免开头误杀）', () => {
    expect(isDegenerateTail('00000')).toBe(false)
  })

  it('emoji/多字节不被切坏，正常 emoji 串不误报', () => {
    expect(isDegenerateTail('完成啦 🦀🎉✨ 谢谢你的耐心，祝你使用愉快！')).toBe(false)
  })

  // ── 不变量：阈值边界 ──
  it('不变量：恰好 minRun 边界附近的单字符复读判定稳定', () => {
    expect(isDegenerateTail('x'.repeat(48), { minRun: 48 })).toBe(false) // run=47 < 48
    expect(isDegenerateTail('x'.repeat(49), { minRun: 48 })).toBe(true) // run=48 ≥ 48
  })

  it('不变量：只看尾部 window，复读发生在尾部即命中（前缀正常不影响）', () => {
    const s = '这是一段完全正常的开头说明文字，'.repeat(3) + '0'.repeat(120)
    expect(isDegenerateTail(s)).toBe(true)
  })

  it('不变量：复读已停止、尾部回到正常文本 → 不再命中（不误伤已恢复的流）', () => {
    const s = '0'.repeat(200) + '——抱歉，让我重新组织一下回答：这是正常的后续内容补充说明。'
    expect(isDegenerateTail(s)).toBe(false)
  })
})

describe('trimDegenerateTail — 裁掉复读尾、保留干净正文', () => {
  it('保留复读前的正文 + 一小段样例，丢弃无限墙', () => {
    const clean = '关于这个问题我的回答是：'
    const wall = clean + '0'.repeat(500)
    const out = trimDegenerateTail(wall)
    expect(out.startsWith(clean), '应保留复读前的干净正文').toBe(true)
    expect(out.length, '应远短于原墙').toBeLessThan(wall.length / 2)
    // 拼上提示后给用户的最终内容
    const final = out + DEGENERATION_NOTICE
    expect(final).toContain('已自动中止')
    expect(final).toContain('glm-4-flash')
  })

  it('多字符周期复读（5861…）同样能定位并裁剪', () => {
    const out = trimDegenerateTail('结果：' + '5861'.repeat(80))
    expect(out.startsWith('结果：')).toBe(true)
    expect(out.length).toBeLessThan(80)
  })
})
