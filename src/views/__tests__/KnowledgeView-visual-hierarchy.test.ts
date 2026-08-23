import { describe, expect, it } from 'vitest'
import knowledgeView from '../KnowledgeView.vue?raw'
import semanticIndexCard from '@/components/knowledge/SemanticIndexCard.vue?raw'

describe('KnowledgeView visual hierarchy', () => {
  it('keeps the document canvas aligned to the supplied prototype rather than imposing a centered wide layout', () => {
    expect(knowledgeView).not.toMatch(
      /\.knowledge-page__content\s*\{[^}]*width:\s*min\(100%,\s*1320px\)/s,
    )
    expect(knowledgeView).not.toMatch(
      /\.knowledge-page__document-list,[\s\S]*?\.knowledge-page__load-more\s*\{[^}]*max-width:\s*none/s,
    )
  })

  it('lets source filters wrap as in the supplied prototype instead of forcing a horizontal strip', () => {
    expect(knowledgeView).toMatch(
      /data-testid="knowledge-source-filters"[\s\S]{0,180}?class="[^"]*flex-wrap[^"]*"/s,
    )
    expect(knowledgeView).not.toMatch(
      /\.knowledge-page__source-filters\s*\{[^}]*overflow-x:\s*auto/s,
    )
    expect(knowledgeView).not.toMatch(
      /\.knowledge-page__source-filters\s*\{[^}]*flex-wrap:\s*nowrap/s,
    )
    expect(knowledgeView).toContain(':title="f.source"')
  })

  it('keeps each document card and its primary content in one stable desktop row', () => {
    expect(knowledgeView).toContain(
      'class="knowledge-page__resource-row knowledge-page__document-card flex items-center"',
    )
    expect(knowledgeView).toContain('class="knowledge-page__document-main flex-1 min-w-0"')
  })

  it('keeps semantic-index controls in the original vertically ordered card', () => {
    expect(semanticIndexCard).toMatch(
      /\.kb-index-card__body\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
    )
    expect(semanticIndexCard).not.toMatch(/\.kb-index-card__actual\s*\{[^}]*grid-column:/s)
  })
})
