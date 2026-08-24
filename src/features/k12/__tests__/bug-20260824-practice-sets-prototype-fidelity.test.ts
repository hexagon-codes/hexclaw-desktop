import { describe, expect, it } from 'vitest'
import practiceSource from '../views/K12PracticeSetsPanel.vue?raw'

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = practiceSource.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `缺少样式规则 ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('BUG-K12-PRACTICE-SETS-PROTOTYPE-FIDELITY-20260824', () => {
  it('待打印题目行沿用原型的题组、小字与移除操作尺寸', () => {
    expect(rule('.k12ps__group')).toMatch(/font-weight:\s*700;/)
    expect(rule('.k12ps__group')).toMatch(/color:\s*var\(--hc-text-muted\);/)
    expect(rule('.k12ps__group')).toMatch(/letter-spacing:\s*0?\.05em;/)
    expect(rule('.k12ps__group')).toMatch(/margin:\s*4px 0 -2px;/)

    expect(rule('.k12ps__qmeta')).toMatch(/font-size:\s*9\.583333px;/)

    const remove = rule('.k12ps__rm')
    expect(remove).toMatch(/font-weight:\s*500;/)
    expect(remove).toMatch(/line-height:\s*18px;/)
    expect(remove).toMatch(/border:\s*0\.5px solid transparent;/)
  })

  it('打印历史使用原型的 16px 分隔与无常驻阴影卡片', () => {
    expect(rule('.k12ps')).toMatch(/gap:\s*0;/)
    expect(rule('.k12ps__history')).toMatch(/margin-top:\s*16px;/)
    expect(rule('.k12ps__hlist')).toMatch(/gap:\s*9px;/)

    const card = rule('.k12ps__hcard')
    expect(card).toMatch(/display:\s*block;/)
    expect(card).toMatch(/box-shadow:\s*none;/)
  })
})
