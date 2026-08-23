import { describe, expect, it } from 'vitest'

import weeklyPracticeSource from '../components/K12WeeklyPracticePanel.vue?raw'
import mistakeReviewMenuSource from '../components/K12MistakeReviewMenu.vue?raw'
import creativeWorksSource from '../views/K12CreativeWorksPanel.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'
import zhCNSource from '../i18n/zh-CN.ts?raw'
import schemaSource from '../schemas.ts?raw'
import recordListSource from '@/shell/records/RecordList.vue?raw'

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
    expect(recordsSource).toMatch(/\.k12rec__tabs\s*\{[^}]*padding:\s*2px\s+14px\s+3px/s)
  })

  it('keeps the approved compact weekly layout and lifecycle copy', () => {
    expect(weeklyPracticeSource.includes('<small>同步巩固与口算热身可按需准备</small>')).toBe(false)
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
    expect(weeklyPracticeSource).toMatch(
      /\.weekly-hero\.rc-week-hero \.weekly-lifecycle\.rc-week-hero__foot\s*\{[^}]*padding-bottom:\s*0/s,
    )
    expect(weeklyPracticeSource).not.toMatch(
      /<span>\{\{ verifiedItems\(track\)\.length \}\} 项<\/span>/,
    )
    expect(weeklyPracticeSource).toMatch(
      /class="weekly-resource-list"[\s\S]*v-for="item in verifiedItems\(track\)"/,
    )
    expect(weeklyPracticeSource).toMatch(
      /\.weekly-hero\.rc-week-hero \.weekly-hero__head\s*\{[^}]*margin:\s*0 0 14px/s,
    )
    expect(weeklyPracticeSource).toMatch(
      /\.weekly-resource-list\s*\{[^}]*display:\s*flex[^}]*gap:\s*8px/s,
    )
    expect(weeklyPracticeSource).toContain('weekly-manual__origin rc-practice-origin')
    expect(weeklyPracticeSource).toContain('projectMistakePracticeGeneration')
  })

  it('does not expand the approved compact creative-work collection cards', () => {
    expect(creativeWorksSource.includes('repeat(auto-fill, minmax(min(100%, 420px), 1fr))')).toBe(
      true,
    )
    expect(creativeWorksSource.includes('grid-template-columns: 104px minmax(0, 1fr)')).toBe(true)
    expect(creativeWorksSource.includes('min-height: 104px')).toBe(true)
    expect(creativeWorksSource.includes('height: 104px')).toBe(true)
  })

  it('keeps the creative-work shell on the prototype card surfaces', () => {
    expect(creativeWorksSource).toMatch(
      /\.k12cw__filter\s*\{[^}]*display:\s*grid;[^}]*gap:\s*9px;[^}]*background:\s*rgba\(255,\s*254,\s*249,\s*0\.9\)/s,
    )
    expect(creativeWorksSource).toMatch(
      /\.k12cw__rules\s*\{[^}]*background:\s*rgba\(255,\s*254,\s*249,\s*0\.96\)/s,
    )
    expect(creativeWorksSource).toMatch(
      /\.k12cw__card\s*\{[^}]*background:\s*rgba\(255,\s*254,\s*249,\s*0\.9\)/s,
    )
    expect(creativeWorksSource).toMatch(/\.k12cw__rules b\s*\{[^}]*margin-bottom:\s*0/s)
    expect(recordsSource).toMatch(
      /\.k12rec__body:has\(> section\[data-testid=['"]works-section['"]\]\)\s*\{[^}]*padding-top:\s*15px/s,
    )
    expect(recordsSource).toMatch(/\.k12rec__body\s*\{[^}]*padding:\s*15px 26px 48px/s)
    expect(weeklyPracticeSource).not.toMatch(
      /\.weekly-progress\.rc-week-progress\s*>\s*button\s*\{[^}]*\b(?:height|font-family|line-height):/s,
    )
  })

  it('uses the shared prototype ghost action for visible wrong-question suppression', () => {
    expect(mistakeReviewMenuSource).toMatch(
      /class="btn btn-ghost week-suppress-action mistake-suppress-visible"/,
    )
  })

  it('keeps the wrong-question archive on the compact prototype row track', () => {
    expect(recordsSource).toMatch(
      /\.k12mistakes\s*:deep\(\.rl-row\)\s*\{[^}]*flex-wrap:\s*nowrap[^}]*padding:\s*9px\s+10px[^}]*font-size:\s*12px[^}]*line-height:\s*18px/s,
    )
    expect(recordsSource).toMatch(
      /\.k12mistakes\s*:deep\(\.rl-title\)\s*\{[^}]*flex:\s*0\s+0\s+250px/s,
    )
    expect(recordsSource).toMatch(
      /\.k12mistakes\s*:deep\(\.rl-btn\)\s*\{[^}]*display:\s*inline-flex[^}]*font-family:\s*inherit[^}]*line-height:\s*18px/s,
    )
    expect(zhCNSource).toContain(
      '本周先不练只延后当周；不再复习可在本列表恢复。只有真实作答与系统判定形成已掌握。',
    )
    expect(zhCNSource).toContain(
      '题目档案只负责查找与管理；到期行动在“本周该练”，长期保存的题在“练习集”。',
    )
    expect(schemaSource).toMatch(/key:\s*'created_at'[\s\S]*role:\s*'date'/)
    expect(schemaSource).toMatch(/key:\s*'entry_source'[\s\S]*role:\s*'source'/)
    expect(recordListSource).toMatch(/fieldsByRole\('source'\)/)
    expect(recordListSource).toMatch(/class="rl-source"/)
  })
})
