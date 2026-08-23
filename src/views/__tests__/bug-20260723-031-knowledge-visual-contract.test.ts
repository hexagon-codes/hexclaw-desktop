import { describe, expect, it } from 'vitest'
import knowledgeView from '../KnowledgeView.vue?raw'

describe('Knowledge source filter visual contract', () => {
  it('uses the prototype chip height and horizontal padding', () => {
    expect(knowledgeView).toMatch(
      /\.knowledge-page__source-chip\s*\{[\s\S]*?min-height:\s*30px;[\s\S]*?padding:\s*5px 11px;/,
    )
  })

  it('uses an explicit eight-pixel document card rhythm', () => {
    expect(knowledgeView).toMatch(
      /\.knowledge-page__document-list\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?gap:\s*8px;/,
    )
    expect(knowledgeView).toMatch(
      /\.knowledge-page__document-list\.space-y-2\s*>\s*:not\(\[hidden\]\)\s*\{[\s\S]*?margin-bottom:\s*0;/,
    )
  })
})
