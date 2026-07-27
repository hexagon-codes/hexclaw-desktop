import { describe, expect, it } from 'vitest'

import panelSource from '../components/K12WeeklyPracticePanel.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'

describe('BUG-20260727-011 approved weekly surface authority', () => {
  it('uses one shared manual count field and no tier/minute option UI', () => {
    expect(panelSource).toContain("import K12ManualQuestionCountField from './K12ManualQuestionCountField.vue'")
    expect(panelSource.match(/<K12ManualQuestionCountField/g)).toHaveLength(2)
    expect(panelSource).not.toContain('selectedTextbookTier')
    expect(panelSource).not.toContain('selectedArithmeticMinutes')
    expect(panelSource).not.toContain('weekly-manual__options')
  })

  it('removes weekly custom paper and the weekly overflow menu from the parent view', () => {
    expect(recordsSource).not.toContain('k12GenerateCustomPaper')
    expect(recordsSource).not.toContain('customPaperOpen')
    expect(recordsSource).not.toContain('weekly-more-trigger')
    expect(recordsSource).not.toContain("runWeeklyOverflowAction('custom-paper')")
  })

  it('projects the exact weekly artifact action set through the shared component', () => {
    expect(recordsSource).toContain(':actions="[\'print\', \'send_im\']"')
    expect(panelSource).not.toContain("{ value: 'export_pdf', label: '导出 PDF' }")
  })
})
