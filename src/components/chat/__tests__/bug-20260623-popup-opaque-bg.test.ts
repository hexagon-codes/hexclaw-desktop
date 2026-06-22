/**
 * Bug (2026-06-23): `@` 召唤弹层（MentionPopup）背景半透明，下方聊天内容透出来糊成一片。
 *
 * 根因：MentionPopup 根 `.hc-mention` 用了 `--hc-bg-card`（内联卡片令牌，translucent：
 * 浅色 rgba(255,255,255,0.8) / 深色 rgba(255,255,255,0.06)），而浮层应当用不透明的
 * 「悬浮面」令牌 `--hc-bg-elevated`（0.96）。兄弟浮层 TemplatePopup 用的就是 elevated。
 *
 * 这是源码契约级取证（CSS 变量在 jsdom 里 getComputedStyle 不解析 scoped + 外部 :root
 * 变量，运行时断言无意义），断言：两个 teleport 浮层的根背景都用不透明 elevated 令牌，
 * 不得用 translucent 的 card 令牌。修复前 MentionPopup RED，修复后 GREEN。永久 regression。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function rootRuleBackground(file: string, selector: string): string {
  const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
  const block = src.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))
  if (!block) throw new Error(`未找到根规则 ${selector} in ${file}`)
  const bg = block[0].match(/background:\s*([^;]+);/)
  if (!bg) throw new Error(`${selector} 无 background 声明`)
  return bg[1]!.trim()
}

describe('bug-20260623: 浮层背景必须不透明（不得透出下方内容）', () => {
  it('MentionPopup(.hc-mention) 根背景用不透明 elevated 令牌，非 translucent card', () => {
    const bg = rootRuleBackground('../MentionPopup.vue', '.hc-mention')
    expect(bg).toBe('var(--hc-bg-elevated)')
    expect(bg).not.toContain('--hc-bg-card')
  })

  it('TemplatePopup(.tpl-popup) 根背景同样用 elevated（兄弟浮层基准，防回退）', () => {
    const bg = rootRuleBackground('../TemplatePopup.vue', '.tpl-popup')
    expect(bg).toBe('var(--hc-bg-elevated)')
    expect(bg).not.toContain('--hc-bg-card')
  })
})
