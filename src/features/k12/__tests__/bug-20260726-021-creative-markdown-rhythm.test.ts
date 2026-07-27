import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'
import CreativeWorkFeedbackRenderer from '../components/CreativeWorkFeedbackRenderer.vue'
import taskShellSource from '../views/RecognizeGuardPanel.vue?raw'
import worksSource from '../views/K12CreativeWorksPanel.vue?raw'

const canonicalMarkdown = [
  '## 可见证据',
  '',
  '第一个独立自然段。',
  '',
  '第二个独立自然段。',
  '',
  '- 无序条目',
  '  - 嵌套条目',
  '',
  '1. 有序条目',
].join('\n')

function mountFeedback() {
  return mount(CreativeWorkFeedbackRenderer, {
    props: {
      generationId: 'generation-markdown-rhythm',
      feedbackId: 'feedback-markdown-rhythm',
      projectionMarkdown: canonicalMarkdown,
      visibleEvidence: [],
      affirmation: '',
      parentGuidance: '',
      nextStep: '',
    },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: 'zh-CN',
          messages: { 'zh-CN': {} },
        }),
      ],
    },
  })
}

describe('BUG-20260726-021 CreativeWork keeps canonical Markdown block rhythm', () => {
  it('preserves headings, independent paragraphs and nested list semantics', () => {
    const wrapper = mountFeedback()
    expect(wrapper.findAll('h2')).toHaveLength(1)
    expect(wrapper.findAll('p').map((node) => node.text())).toEqual([
      '第一个独立自然段。',
      '第二个独立自然段。',
    ])
    expect(wrapper.findAll('ul')).toHaveLength(2)
    expect(wrapper.findAll('ol')).toHaveLength(1)
    expect(wrapper.findAll('li').map((node) => node.text().replace(/\s+/g, ''))).toEqual([
      '无序条目嵌套条目',
      '嵌套条目',
      '有序条目',
    ])
  })

  it('uses the same identity-aware renderer on conversation and work-detail surfaces', () => {
    for (const surface of [taskShellSource, worksSource]) {
      expect(surface).toContain('CreativeWorkFeedbackRenderer')
      expect(surface).toMatch(/:generation-id=/)
      expect(surface).toMatch(/:feedback-id=/)
      expect(surface).toMatch(/:projection-markdown=/)
    }
  })

  it('forbids a K12 work-detail rule that clears all feedback paragraph margins', () => {
    expect(worksSource).not.toMatch(
      /\.k12cw__feedback[\w-]*\s*:deep\(p\)[^{]*\{[^}]*margin\s*:\s*0\b/,
    )
  })
})
