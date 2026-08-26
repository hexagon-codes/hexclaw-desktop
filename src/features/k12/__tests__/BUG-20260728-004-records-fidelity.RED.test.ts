import { describe, expect, it } from 'vitest'

import weeklyPracticeSource from '../components/K12WeeklyPracticePanel.vue?raw'
import mistakeReviewMenuSource from '../components/K12MistakeReviewMenu.vue?raw'
import creativeWorksSource from '../views/K12CreativeWorksPanel.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'
import zhCNSource from '../i18n/zh-CN.ts?raw'
import schemaSource from '../schemas.ts?raw'
import recordListSource from '@/shell/records/RecordList.vue?raw'

function cssBlock(source: string, selector: string): string {
  const selectorStart = source.indexOf(selector)
  if (selectorStart < 0) return ''
  const blockStart = source.indexOf('{', selectorStart + selector.length)
  if (blockStart < 0) return ''

  let depth = 0
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] !== '}') continue
    depth -= 1
    if (depth === 0) return source.slice(blockStart + 1, index)
  }
  return ''
}

function ruleBlock(source: string, start: RegExp): string {
  const match = start.exec(source)
  if (!match || match.index === undefined) return ''
  const blockStart = source.indexOf('{', match.index + match[0].length)
  if (blockStart < 0) return ''

  let depth = 0
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] !== '}') continue
    depth -= 1
    if (depth === 0) return source.slice(blockStart + 1, index)
  }
  return ''
}

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
    const toolbar = cssBlock(recordsSource, '.k12rec__tabs')
    expect(toolbar).toMatch(/height:\s*42px/)
    expect(toolbar).toMatch(/padding:\s*0\s+14px/)
    expect(toolbar).toMatch(/background:\s*var\(--hc-bg-panel\)/)
    expect(toolbar).toMatch(/border-bottom:\s*1px\s+solid\s+var\(--hc-divider\)/)
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

  it('preserves the prototype secondary-toolbar wrap contract on the weekly surface', () => {
    const toolbar = cssBlock(weeklyPracticeSource, '.weekly-toolbar')
    expect(toolbar).toMatch(/flex-wrap:\s*wrap/)
  })

  it('scopes weekly and mistake row breakpoints to their leaf list containers', () => {
    expect(weeklyPracticeSource).toMatch(
      /\.weekly-resource-list\s*\{[^}]*container-type:\s*inline-size/s,
    )
    expect(recordsSource).toMatch(
      /\.k12mistakes\s+:deep\(\.rl-rows\)\s*\{[^}]*container-type:\s*inline-size/s,
    )

    const weeklyViewportRule = ruleBlock(
      weeklyPracticeSource,
      /@media\s*\(\s*max-width:\s*1040px\s*\)/,
    )
    const mistakeViewportRule = ruleBlock(recordsSource, /@media\s*\(\s*max-width:\s*1040px\s*\)/)

    expect(weeklyViewportRule).not.toMatch(/\.weekly-item\.resource-row/)
    expect(mistakeViewportRule).not.toMatch(/\.k12mistakes\s+:deep\(\.rl-row/)
  })

  it('uses the approved three-domain grid and keeps each action rail indivisible', () => {
    const weeklyRow = cssBlock(
      weeklyPracticeSource,
      '.weekly-item.resource-row.k12-compact-row--weekly',
    )
    const weeklyPrimary = cssBlock(weeklyPracticeSource, '.k12-compact-row__primary')
    const weeklyContext = cssBlock(
      weeklyPracticeSource,
      '.weekly-item.resource-row.k12-compact-row--weekly .k12-compact-row__meta',
    )
    const weeklyActions = cssBlock(
      weeklyPracticeSource,
      '.weekly-item.resource-row.k12-compact-row--weekly .k12-compact-row__actions',
    )
    const mistakeRow = cssBlock(recordsSource, '.k12mistakes :deep(.rl-row)')
    const mistakePrimary = cssBlock(recordsSource, '.k12mistakes :deep(.rl-primary)')
    const mistakeContext = cssBlock(recordsSource, '.k12mistakes :deep(.rl-context)')
    const mistakeActions = cssBlock(recordsSource, '.k12mistakes :deep(.rl-actions)')

    expect(weeklyPracticeSource).toMatch(
      /'k12-compact-row__primary':\s*track\.plan_section\s*===\s*'due_review'/,
    )
    for (const row of [weeklyRow, mistakeRow]) {
      expect.soft(row).toMatch(/display:\s*grid/)
      expect
        .soft(row)
        .toMatch(
          /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(92px,\s*auto\)\s+max-content/,
        )
      expect
        .soft(row)
        .toMatch(/grid-template-areas:\s*["']primary\s+(?:context|meta)\s+actions["']/)
      expect.soft(row).not.toMatch(/flex-wrap:\s*wrap/)
    }
    for (const primary of [weeklyPrimary, mistakePrimary]) {
      expect.soft(primary).toMatch(/grid-area:\s*primary/)
      expect.soft(primary).toMatch(/min-width:\s*0/)
    }
    for (const context of [weeklyContext, mistakeContext]) {
      expect.soft(context).toMatch(/grid-area:\s*(?:context|meta)/)
    }
    for (const actions of [weeklyActions, mistakeActions]) {
      expect.soft(actions).toMatch(/grid-area:\s*actions/)
      expect.soft(actions).toMatch(/display:\s*flex/)
      expect.soft(actions).toMatch(/white-space:\s*nowrap/)
    }
  })

  it('flattens only at 1000px and moves the complete action group below at 619px', () => {
    const weeklyWide = ruleBlock(weeklyPracticeSource, /@container\s*\(\s*min-width:\s*1000px\s*\)/)
    const mistakeWide = ruleBlock(recordsSource, /@container\s*\(\s*min-width:\s*1000px\s*\)/)
    const weeklyNarrow = ruleBlock(
      weeklyPracticeSource,
      /@container\s*\(\s*max-width:\s*619px\s*\)/,
    )
    const mistakeNarrow = ruleBlock(recordsSource, /@container\s*\(\s*max-width:\s*619px\s*\)/)

    for (const wide of [weeklyWide, mistakeWide]) {
      expect.soft(wide).toMatch(/display:\s*flex/)
      expect.soft(wide).toMatch(/display:\s*contents/)
    }
    for (const narrow of [weeklyNarrow, mistakeNarrow]) {
      expect
        .soft(narrow)
        .toMatch(
          /grid-template-areas:\s*["']primary\s+(?:context|meta)["']\s*["']actions\s+actions["']/,
        )
      expect.soft(narrow).toMatch(/justify-self:\s*end/)
    }
  })

  it('keeps the creative-work collection fixed to two equal tracks', () => {
    expect(creativeWorksSource.includes('repeat(2, minmax(0, 1fr))')).toBe(true)
    expect(creativeWorksSource).not.toContain('repeat(auto-fill')
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
      /\.k12rec__body:has\(> section\[data-testid=['"]works-section['"]\]\)\s*\{[^}]*padding-top:\s*16px/s,
    )
    expect(recordsSource).toMatch(/\.k12rec__body\s*\{[^}]*padding:\s*16px 26px 48px/s)
    expect(weeklyPracticeSource).not.toMatch(
      /\.weekly-progress\.rc-week-progress\s*>\s*button\s*\{[^}]*\b(?:height|font-family|line-height):/s,
    )
  })

  it('uses the shared prototype ghost action for visible wrong-question suppression', () => {
    expect(mistakeReviewMenuSource).toMatch(
      /class="btn btn-ghost week-suppress-action mistake-suppress-visible"/,
    )
    const weeklyReviewAction = weeklyPracticeSource.match(/<K12MistakeReviewMenu[\s\S]*?\/>/)?.[0]
    expect(weeklyReviewAction).toBeTruthy()
    expect(weeklyReviewAction).toMatch(/display="visible"/)
    expect(weeklyReviewAction).not.toMatch(/display="menu"/)
  })

  it('keeps the wrong-question archive typography on the compact prototype track', () => {
    expect(recordsSource).toMatch(
      /\.k12mistakes\s*:deep\(\.rl-row\)\s*\{[^}]*padding:\s*(?:8|9)px\s+10px[^}]*font-size:\s*12px[^}]*line-height:\s*18px/s,
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

  it('exposes neutral shared row domains without changing other RecordList consumers', () => {
    for (const className of [
      'rl-primary',
      'rl-primary__heading',
      'rl-primary__detail',
      'rl-context',
      'rl-actions',
    ]) {
      expect((recordListSource.match(new RegExp(`class="${className}"`, 'g')) || []).length).toBe(1)
      expect(cssBlock(recordListSource, `.${className}`)).toMatch(/display:\s*contents/)
    }

    expect(recordsSource).toMatch(/\.k12mistakes\s+:deep\(\.rl-primary\)/)
    expect(recordsSource).toMatch(/\.k12mistakes\s+:deep\(\.rl-primary__heading\)/)
    expect(recordsSource).toMatch(/\.k12mistakes\s+:deep\(\.rl-primary__detail\)/)
    expect(recordsSource).toMatch(/\.k12mistakes\s+:deep\(\.rl-context\)/)
    expect(recordsSource).toMatch(/\.k12mistakes\s+:deep\(\.rl-actions\)/)
  })
})
