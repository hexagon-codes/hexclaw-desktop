import { describe, expect, it } from 'vitest'
import worksSource from '../views/K12CreativeWorksPanel.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'

describe('K12 works prototype layout', () => {
  it('keeps overview/KPIs, filters and rules in the prototype visual order', () => {
    const overview = worksSource.indexOf('class="k12cw__overview"')
    const filters = worksSource.indexOf('class="k12cw__filter"')
    const rules = worksSource.indexOf('data-testid="cw-rules"')
    expect(overview).toBeGreaterThan(-1)
    expect(filters).toBeGreaterThan(overview)
    expect(rules).toBeGreaterThan(filters)
  })

  it('uses compact two-column preview cards and hides detailed workflows until requested', () => {
    expect(worksSource).toContain('class="k12cw__preview"')
    expect(worksSource).toContain('data-testid="cw-detail-toggle"')
    expect(worksSource).toMatch(/\.k12cw__list\s*\{[^}]*grid-template-columns:\s*repeat\(2,/)
    expect(worksSource).toMatch(/\.k12cw__details\s*\{[^}]*display:\s*none/)
  })

  it('puts the add-work action in the archive toolbar instead of duplicating it inside content', () => {
    expect(recordsSource).toContain("v-else-if=\"sub === 'works'\"")
    expect(recordsSource).toContain('creativeWorksRef?.openAdd()')
    expect(worksSource).toContain('showAddButton')
  })

  it('keeps native printing and Save PDF as two independent practice-card actions (DD-023A)', () => {
    expect(worksSource).not.toContain("isTauri() ? t('k12.works.practiceCardSavePdf')")
    expect(worksSource).toContain('data-testid="cw-card-print"')
    expect(worksSource).toContain('data-testid="cw-card-save-pdf"')
    expect(worksSource).toContain('savePracticePaperPdf')
  })
})
