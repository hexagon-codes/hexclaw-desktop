import { describe, expect, it } from 'vitest'
import source from '../views/RecognizeGuardPanel.vue?raw'

describe('批改准备流水线 · app.html 保真锁', () => {
  it('使用原型 12px 卡、双列 7px 分支及 done/degraded/error 状态色', () => {
    expect(source).toMatch(
      /\.rec-pipeline\s*\{[\s\S]*?padding:\s*10px;[\s\S]*?border-radius:\s*12px;/,
    )
    expect(source).toMatch(
      /\.rec-pipeline__branches\s*\{[\s\S]*?grid-template-columns:\s*1fr 1fr;[\s\S]*?gap:\s*7px;/,
    )
    expect(source).toMatch(
      /\.rec-pipeline__branch\s*\{[\s\S]*?padding:\s*8px 9px;[\s\S]*?border-radius:\s*9px;/,
    )
    expect(source).toContain('.rec-pipeline__branch.is-done')
    expect(source).toContain('.rec-pipeline__branch.is-degraded')
    expect(source).toContain('.rec-pipeline__error')
  })
})
