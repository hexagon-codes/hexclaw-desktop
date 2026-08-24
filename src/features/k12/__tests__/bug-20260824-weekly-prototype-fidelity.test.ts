import { describe, expect, it } from 'vitest'

import panelSource from '../components/K12WeeklyPracticePanel.vue?raw'

describe('K12 weekly prototype fidelity', () => {
  it('keeps the current-week hero and rows on the authoritative flex geometry', () => {
    expect(panelSource).toMatch(/\.weekly-hero\.rc-week-hero\s*\{[^}]*margin:\s*2px 0 14px/s)
    expect(panelSource).toMatch(
      /\.weekly-item\.resource-row,\s*\.weekly-manual\.resource-row\s*\{[^}]*display:\s*flex;[^}]*grid-template-columns:\s*none;/s,
    )
  })

  it('projects weekly history through the compact prototype resource row', () => {
    expect(panelSource).toContain('class="weekly-history__list resource-list"')
    expect(panelSource).toContain('class="weekly-history__card resource-row k12-week-history-card"')
    expect(panelSource).toContain('class="weekly-history__origin rc-practice-origin"')
    expect(panelSource).toContain('<span class="stpill got">已归档</span>')
    expect(panelSource).toMatch(/\.weekly-history\s*\{[^}]*display:\s*block;/s)
    expect(panelSource).toMatch(
      /\.weekly-history__card\s*\{[^}]*display:\s*flex;[^}]*gap:\s*8px;[^}]*padding:\s*9px 10px;[^}]*border-radius:\s*10px;[^}]*color:\s*var\(--hc-text-secondary\);[^}]*font-size:\s*12px;[^}]*line-height:\s*18px;/s,
    )
  })
})
