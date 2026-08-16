import { describe, expect, it } from 'vitest'
import worksSource from '../views/K12CreativeWorksPanel.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'
import zhCN from '../i18n/zh-CN'
import en from '../i18n/en'
import ugCN from '../i18n/ug-CN'

describe('K12 works prototype layout', () => {
  it('keeps overview/KPIs, filters and rules in the prototype visual order', () => {
    const overview = worksSource.indexOf('class="k12cw__overview"')
    const filters = worksSource.indexOf('class="k12cw__filter"')
    const rules = worksSource.indexOf('data-testid="cw-rules"')
    expect(overview).toBeGreaterThan(-1)
    expect(filters).toBeGreaterThan(overview)
    expect(rules).toBeGreaterThan(filters)
  })

  it('uses the approved two-column collection (user 2026-08-16), 104px media and 720px detail modal', () => {
    expect(worksSource).toContain('class="k12cw__preview"')
    expect(worksSource).toContain('data-testid="cw-detail-toggle"')
    expect(worksSource).toMatch(
      /\.k12cw__list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    )
    expect(worksSource).not.toContain('k12cw__card--expanded')
    expect(worksSource).toContain('data-testid="cw-detail-modal"')
    expect(worksSource).toMatch(
      /\.k12cw-detail-modal\s*\{[^}]*width:\s*min\(720px,\s*calc\(100vw - 48px\)\)/,
    )
    expect(worksSource).toMatch(/\.k12cw__preview\s*\{[^}]*min-height:\s*104px[^}]*height:\s*104px/)
  })

  it('matches the prototype card and filter geometry instead of using a custom treatment', () => {
    expect(worksSource).toMatch(
      /\.k12cw__card\s*\{[^}]*grid-template-columns:\s*104px minmax\(0,\s*1fr\)[^}]*min-height:\s*138px[^}]*padding:\s*16px[^}]*gap:\s*14px/,
    )
    expect(worksSource).toMatch(
      /\.k12cw__filter\s*\{[^}]*gap:\s*7px[^}]*padding:\s*12px 14px[^}]*border-radius:\s*14px/,
    )
    expect(worksSource).toMatch(
      /\.k12cw__filter button\s*\{[^}]*border:\s*0\.5px solid var\(--hc-border\)[^}]*background:\s*var\(--hc-bg-input\)[^}]*border-radius:\s*9px/,
    )
  })

  it('uses the prototype subject and status pill colors', () => {
    expect(worksSource).toContain('k12cw__kind--writing')
    expect(worksSource).toContain('k12cw__kind--art')
    expect(worksSource).toMatch(/\.k12cw__kind--writing\s*\{[^}]*#e8590c[^}]*color:\s*#e8590c/)
    expect(worksSource).toMatch(/\.k12cw__kind--art\s*\{[^}]*#c2255c[^}]*color:\s*#c2255c/)
    expect(worksSource).toMatch(/\.k12cw__pill--reviewed\s*\{[^}]*color:\s*var\(--hc-success\)/)
  })

  it('puts the add-work action in the archive toolbar instead of duplicating it inside content', () => {
    expect(recordsSource).toContain('v-else-if="sub === \'works\'"')
    expect(recordsSource).toContain('creativeWorksRef?.openAdd()')
    expect(worksSource).toContain('showAddButton')
    expect([zhCN.works.addWork, en.works.addWork, ugCN.works.addWork]).toEqual([
      '添加作品',
      'Add work',
      'ئەسەر قوشۇش',
    ])
  })

  it('teleports the add-work modal to the app body so ancestor layout cannot stretch or clip it', () => {
    const addModal = worksSource.indexOf('data-testid="cw-add-modal"')
    const teleport = worksSource.lastIndexOf('<Teleport to="body">', addModal)
    const teleportClose = worksSource.lastIndexOf('</Teleport>', addModal)
    expect(addModal).toBeGreaterThan(-1)
    expect(teleport).toBeGreaterThan(-1)
    expect(teleportClose).toBeLessThan(teleport)
  })

  it('uses a bounded desktop modal with a scrolling body and fixed action bar', () => {
    expect(worksSource).toMatch(
      /\.k12cw-modal\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/s,
    )
    expect(worksSource).toMatch(
      /\.k12cw-modal\s*\{[^}]*max-height:\s*min\(720px,\s*calc\(100vh - 24px\)\)/s,
    )
    expect(worksSource).toMatch(
      /\.k12cw-modal__body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s,
    )
  })

  it('keeps only the approved minimum writing/art fields', () => {
    expect(worksSource.match(/t\('k12\.works\.nameLabel'\)/g)).toHaveLength(1)
    expect(worksSource).toContain('v-if="addType === \'art\'"')
    expect(worksSource).toContain("t('k12.works.namePlaceholder')")
    expect(worksSource).toContain('data-testid="cw-add-draft"')
    expect(worksSource).not.toContain('data-testid="cw-add-task"')
    expect(worksSource).not.toContain('data-testid="cw-add-intent"')
    expect(worksSource).toMatch(
      /\.k12cw__input\s*\{[^}]*display:\s*block[^}]*box-sizing:\s*border-box[^}]*width:\s*100%[^}]*min-width:\s*0/s,
    )
  })

  it('detail keeps the approved success actions and retires versions, revisions and footer close', () => {
    for (const retained of [
      'data-testid="cw-work-content"',
      'data-testid="cw-latest-feedback"',
      'data-testid="cw-copy"',
      'data-testid="cw-send"',
      'data-testid="cw-export-pdf"',
      'data-testid="cw-feedback-regenerate"',
      'data-testid="cw-delete"',
      'data-testid="cw-detail-close"',
    ]) {
      expect(worksSource).toContain(retained)
    }
    for (const retired of [
      'data-testid="cw-version-content"',
      'data-testid="cw-version-feedback"',
      'data-testid="cw-revision-input"',
      'data-testid="cw-revision-submit"',
      'data-testid="cw-feedback-input"',
      'data-testid="cw-feedback-submit"',
      'data-testid="cw-feedback-generate"',
      'data-testid="cw-practice-card"',
      'data-testid="cw-accum-open"',
      'data-testid="cw-mistake-open"',
      'data-testid="cw-archive"',
      'k12SubmitWorkRevision',
      'k12AttachWorkFeedback',
      'k12ArchiveCreativeWork',
      'k12SendWorkFeedback',
      'k12MarkPracticeCardDone',
      'savePracticePaperPdf',
      'class="k12cw-detail-modal__foot"',
    ]) {
      expect(worksSource).not.toContain(retired)
    }
  })

  it('holds five desktop actions in one row and switches below 680px to two columns', () => {
    expect(worksSource).toMatch(
      /\.k12cw__action-bar\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/s,
    )
    expect(worksSource).toMatch(
      /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.k12cw__action-bar\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    )
  })

  it('all locales remove copy for retired manual-feedback, delivery and practice-card actions', () => {
    const retiredKeys = [
      'addFeedback',
      'archive',
      'sendFeedback',
      'practiceCardTitle',
      'practiceCardPrint',
      'practiceCardSavePdf',
      'practiceCardSend',
      'practiceCardMarkDone',
      'toAccum',
      'toMistake',
    ]
    for (const locale of [zhCN, en, ugCN]) {
      for (const key of retiredKeys) {
        expect(locale.works).not.toHaveProperty(key)
      }
    }
  })

  it('keeps the full information-technology subject label on one line', () => {
    expect(recordsSource).toMatch(
      /\.k12rec__filter-row--subject \.k12rec__filter\s*\{[^}]*width:\s*68px[^}]*white-space:\s*nowrap/,
    )
  })
})
