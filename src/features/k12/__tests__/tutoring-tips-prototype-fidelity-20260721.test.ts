import { describe, expect, it } from 'vitest'
import source from '../views/TutoringTipsPanel.vue?raw'

describe('辅导要点卡 · app.html 保真锁', () => {
  it('沿用 guide 的 14px 卡片、11x15 头、13x15 分组正文和独立 legend footer', () => {
    expect(source).toMatch(
      /\.tutoring-tips\s*\{[\s\S]*?border-radius:\s*14px;[\s\S]*?box-shadow:\s*var\(--hc-shadow-sm\);/,
    )
    expect(source).toMatch(/\.tutoring-tips__head\s*\{[\s\S]*?padding:\s*11px 15px;/)
    expect(source).toMatch(
      /\.tutoring-tips__body\s*\{[\s\S]*?padding:\s*13px 15px;[\s\S]*?gap:\s*13px;/,
    )
    expect(source).toMatch(
      /\.tutoring-tips__legend\s*\{[\s\S]*?padding:\s*9px 15px 12px;[\s\S]*?border-top:\s*0\.5px solid var\(--hc-divider\);/,
    )
  })
})
