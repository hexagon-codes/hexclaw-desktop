import { describe, expect, it } from 'vitest'

import taskShellSource from '../views/RecognizeGuardPanel.vue?raw'
import worksSource from '../views/K12CreativeWorksPanel.vue?raw'

describe('BUG-20260726-007 creative feedback single-source renderer', () => {
  it('mounts the same identity-aware five-section renderer on both surfaces', () => {
    for (const source of [taskShellSource, worksSource]) {
      expect(source).toContain('CreativeWorkFeedbackRenderer')
      expect(source).toMatch(/:generation-id=/)
      expect(source).toMatch(/:feedback-id=/)
      expect(source).toMatch(/:projection-markdown=/)
    }

    expect(taskShellSource).not.toMatch(
      /<MarkdownRenderer[\s\S]{0,300}creativeResult\.payload\.feedback\.projection_markdown/,
    )
  })

  it('keeps the server projection as the only creative feedback Markdown source', () => {
    const body =
      worksSource.match(
        /function feedbackMarkdown\(work: CreativeWorkDTO\): string \{([\s\S]*?)\n\}/,
      )?.[1] ?? ''

    expect(body).toContain('projection_markdown')
    expect(body).not.toMatch(
      /feedbackEvidence|feedbackVisibleEvidence|feedbackAffirmation|feedbackParentGuidance|feedbackNextStep/,
    )
  })
})
