/**
 * Bug-2026-05-01 RTL bidi 全局兜底回归测试
 *
 * 症状：维语界面下日志页（.hc-logs__row / .hc-logs__entry / .hc-logs__row-msg 等）
 * 中文/英文/数字/emoji 混排被 bidi 段重排，例如：
 *   原 `🦀 HexClaw v0.3.12 启动 — 自研引擎 · 多 Agent 协作`
 *   显示 `启动 — 自研引擎 · 多 Agent 协作 🦀 HexClaw v0.3.12`
 *
 * 根因：之前的修复只覆盖了消息气泡 / 会话列表 / titlebar 等具名 class，
 * 日志组件、其他生成自动 class 漏覆盖。
 *
 * 修法（W3C 标准做法）：在 [dir='rtl'] 下对常见内容容器（p / div / span / li
 * / h1-h6 / pre / code / blockquote / textarea / input / button 等）统一加
 * unicode-bidi: plaintext，等价于 HTML dir="auto"——按内容首字符自适应方向。
 *
 * 本测试断言 global.css 中存在该全局兜底规则。失败说明规则缺失或被改回。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS_PATH = resolve(__dirname, '../assets/styles/global.css')

describe('BUG-20260501: RTL bidi 全局兜底', () => {
  const css = readFileSync(CSS_PATH, 'utf8')

  it('global.css 必须存在 [dir=rtl] 全局内容容器 unicode-bidi: plaintext 兜底', () => {
    // 移除注释 + 空白后查找规则块
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')

    // 期望形如 `[dir='rtl'] :is(p, div, span, ...) { unicode-bidi: plaintext; }`
    // 容忍单/双引号、空白、属性顺序
    const blockPattern = /\[dir\s*=\s*['"]rtl['"]\]\s*:is\(([^)]+)\)\s*\{[^}]*unicode-bidi\s*:\s*plaintext/i
    const match = stripped.match(blockPattern)
    expect(match, '未找到 [dir=rtl] :is(...) { unicode-bidi: plaintext } 全局兜底规则').not.toBeNull()
  })

  it('全局兜底必须覆盖关键内容容器：p / div / span / li / h1-h6 / pre / textarea / button', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const blockPattern = /\[dir\s*=\s*['"]rtl['"]\]\s*:is\(([^)]+)\)\s*\{[^}]*unicode-bidi\s*:\s*plaintext/i
    const match = stripped.match(blockPattern)
    if (!match || !match[1]) {
      throw new Error('preceding test should have caught missing block')
    }
    const selectors = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const required = ['p', 'div', 'span', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'textarea', 'button']
    for (const tag of required) {
      expect(selectors, `[dir=rtl] :is(...) 必须包含 ${tag} 才能覆盖日志页等未具名 class 的容器`).toContain(tag)
    }
  })

  it('日志页关键 class 必须落在某条带 unicode-bidi: plaintext 的 RTL 规则中（直接命中或被全局兜底覆盖）', () => {
    // 防御式：若未来移除全局 :is 改成具名 class，至少这条断言守住日志页能 plaintext。
    // 全局 :is(div, ...) 兜底已经覆盖 .hc-logs__row 这类 div 容器，因此本测试与上面互补。
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const hasGlobalDiv = /\[dir\s*=\s*['"]rtl['"]\]\s*:is\([^)]*\bdiv\b[^)]*\)\s*\{[^}]*unicode-bidi\s*:\s*plaintext/i.test(
      stripped,
    )
    const hasNamedLogsRule = /\[dir\s*=\s*['"]rtl['"]\][^{]*\.hc-logs__(row|message|entry|row-msg)[^{]*\{[^}]*unicode-bidi\s*:\s*plaintext/i.test(
      stripped,
    )
    expect(hasGlobalDiv || hasNamedLogsRule, '日志页未被任何 unicode-bidi: plaintext 规则覆盖').toBe(true)
  })
})
