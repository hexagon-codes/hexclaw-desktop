import { describe, expect, it } from 'vitest'

import worksSource from '../views/K12CreativeWorksPanel.vue?raw'

const detailToggleRule = worksSource.match(
  /\.k12cw__detail-toggle\s*\{([\s\S]*?)\n\}/,
)?.[1] ?? ''

describe('BUG-20260726-022 works card action typography', () => {
  it('inherits the shared button font and line-height from the approved prototype', () => {
    expect(detailToggleRule).toMatch(/font-family:\s*inherit/)
    expect(detailToggleRule).toMatch(/line-height:\s*18px/)
    expect(detailToggleRule).not.toMatch(/font-family:\s*Arial/)
    expect(detailToggleRule).not.toMatch(/line-height:\s*normal/)
  })
})
