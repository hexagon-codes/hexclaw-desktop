/**
 * Bug-20260713（严重）：错因列逐字竖排（一字一行）根因锁。
 *
 * 真机现象：全部错题列表某行错因「混淆了体积公式，误以为体积是长+宽+高」被挤成一字一行竖排——
 * 错因列宽塌成 ~1 字宽。根因：RecordList 的 `.rl-meta`（错因/元信息格）flex-basis 为 0，
 * 当同行学科芯片 `.rl-chip`（white-space:nowrap）是长文本（如「数学·长方体的体积」）挤满整行时，
 * 本格被压到 ~0 宽；若本格允许换行，CJK 每字都是换行点 → 逐字竖排。
 *
 * 治本 = 对齐原型 `.resource-row .sp`（app.html:863）：flex:1 + min-width:0 +
 * overflow:hidden + text-overflow:ellipsis + white-space:nowrap —— 芯片长短都不逐字竖排，
 * 错因始终横排一行、超长省略号截断。
 *
 * jsdom 无排版引擎、无法量几何；本测试锁 SFC 里 `.rl-meta` 规则携带这几条护栏（结构断言 RED→GREEN）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(resolve(process.cwd(), 'src/shell/records/RecordList.vue'), 'utf8')

// 抽出 `.rl-meta { ... }` 规则体（首个匹配即错因格声明）
function ruleBody(selector: string): string {
  const re = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`)
  const m = src.match(re)
  expect(m, `未找到 CSS 规则 ${selector}`).toBeTruthy()
  return m![1]!.replace(/\s+/g, '')
}

describe('Bug-20260713：.rl-meta 错因格护栏——防逐字竖排', () => {
  const body = ruleBody('.rl-meta')

  it('自带 flex:1（不依赖 .rl-spacer 才有伸展）', () => {
    expect(body).toContain('flex:1')
  })
  it('min-width:0（允许在 flex 行内收缩，不被内容最小宽撑破）', () => {
    expect(body).toContain('min-width:0')
  })
  it('white-space:nowrap（错因单行，绝不 CJK 逐字换行竖排）', () => {
    expect(body).toContain('white-space:nowrap')
  })
  it('overflow:hidden + text-overflow:ellipsis（超长横向省略号截断，对齐原型 .resource-row .sp）', () => {
    expect(body).toContain('overflow:hidden')
    expect(body).toContain('text-overflow:ellipsis')
  })
})
