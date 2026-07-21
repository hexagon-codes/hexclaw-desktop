import { describe, expect, it } from 'vitest'
import source from '../views/PhotoGradeOverlay.vue?raw'

describe('整页批改结果 · app.html 保真锁', () => {
  it('锁定 18px 结果卡、四格摘要和 1.18/.82 双栏工作区', () => {
    expect(source).toMatch(
      /\.grade-result\s*\{[\s\S]*?border-radius:\s*18px;[\s\S]*?box-shadow:\s*var\(--hc-shadow-md\);/,
    )
    expect(source).toMatch(
      /\.grade-summary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*7px;/,
    )
    expect(source).toMatch(
      /\.grade-workspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\(300px,\s*1\.18fr\) minmax\(260px,\s*(?:0)?\.82fr\);/,
    )
    expect(source).toContain('.grade-analysis')
    expect(source).toContain('.grade-card--correct')
  })
})
