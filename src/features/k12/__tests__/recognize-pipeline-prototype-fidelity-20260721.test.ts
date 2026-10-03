import { describe, expect, it } from 'vitest'
import source from '../views/RecognizeGuardPanel.vue?raw'

describe('批改准备流水线 · app.html 保真锁', () => {
  it('使用原型无底卡的单列活动流及 done/degraded/error 状态色', () => {
    expect(source).toMatch(
      /\.rec-pipeline\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border-radius:\s*0;/,
    )
    expect(source).toMatch(
      /\.rec-pipeline__branches\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?gap:\s*9px;/,
    )
    expect(source).toMatch(
      /\.rec-pipeline__branch\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border-radius:\s*0;/,
    )
    expect(source).toContain('.rec-pipeline__branch.is-done')
    expect(source).toContain('.rec-pipeline__branch.is-degraded')
    expect(source).toContain('ActivityTimeline')
    expect(source).toContain('taskStatusActivityItems')
  })
})
