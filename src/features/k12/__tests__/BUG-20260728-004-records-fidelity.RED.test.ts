import { describe, expect, it } from 'vitest'

import weeklyPracticeSource from '../components/K12WeeklyPracticePanel.vue?raw'
import creativeWorksSource from '../views/K12CreativeWorksPanel.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'

describe('BUG-20260728-004 learning-record prototype fidelity', () => {
  it('keeps shared secondary tabs free from page-local visual overrides', () => {
    expect(/\n\.seg\s*\{/.test(recordsSource)).toBe(false)
    expect(/\n\.seg button\s*\{/.test(recordsSource)).toBe(false)
    expect(/\n\.seg button\.on\s*\{/.test(recordsSource)).toBe(false)
  })

  it('places weekly artifact actions in the weekly period toolbar', () => {
    expect(recordsSource.includes('<template #toolbar-actions>')).toBe(true)
    expect(/class="[^"]*\bweekly-toolbar\b/.test(weeklyPracticeSource)).toBe(true)
    expect(weeklyPracticeSource.includes('<slot name="toolbar-actions"')).toBe(true)
  })

  it('keeps the object toolbar at the prototype 42px track height', () => {
    expect(recordsSource).toMatch(
      /\.k12rec__tabs\s*\{[^}]*padding:\s*2px\s+14px\s+3px/s,
    )
  })

  it('keeps the approved compact weekly layout and lifecycle copy', () => {
    expect(
      weeklyPracticeSource.includes(
        '<small>同步巩固与口算热身可按需准备</small>',
      ),
    ).toBe(false)
    expect(
      weeklyPracticeSource.includes(
        '每周五 19:00 自动整理本周错题 · 同步巩固和口算热身按需准备 · 不自动加入练习集',
      ),
    ).toBe(true)
    expect(
      weeklyPracticeSource.includes(
        'grid-template-columns: minmax(180px, 1.2fr) minmax(150px, 0.9fr) auto',
      ),
    ).toBe(true)
    expect(weeklyPracticeSource).toMatch(
      /\.weekly-item\.resource-row \.weekly-item__prompt :deep\(\.markdown-body\)\s*\{[^}]*font-weight:\s*700/s,
    )
    expect(weeklyPracticeSource).toMatch(
      /\.weekly-item\.resource-row \.weekly-item__prompt\s*\{[^}]*flex:\s*0 0 250px/s,
    )
  })

  it('does not expand the approved compact creative-work collection cards', () => {
    expect(
      creativeWorksSource.includes(
        'repeat(2, minmax(0, 1fr))',
      ),
    ).toBe(true)
    expect(
      creativeWorksSource.includes(
        'grid-template-columns: 104px minmax(0, 1fr)',
      ),
    ).toBe(true)
    expect(creativeWorksSource.includes('min-height: 104px')).toBe(true)
    expect(creativeWorksSource.includes('height: 104px')).toBe(true)
  })
})
