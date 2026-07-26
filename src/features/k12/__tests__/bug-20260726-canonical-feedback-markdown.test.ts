import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import CreativeWorkFeedbackRenderer from '../components/CreativeWorkFeedbackRenderer.vue'

describe('2026-07-26 canonical creative-work feedback projection', () => {
  it('renders headings, paragraphs and lists from projectionMarkdown instead of structured decoys', () => {
    const wrapper = mount(CreativeWorkFeedbackRenderer, {
      props: {
        generationId: 'generation-canonical',
        feedbackId: 'feedback-canonical',
        visibleEvidence: ['结构化假证据'],
        affirmation: '结构化假肯定',
        parentGuidance: '结构化假家长建议',
        nextStep: '结构化假下一步',
        limitations: '结构化假说明',
        projectionMarkdown: [
          '## 可见证据',
          '',
          '这是独立段落。',
          '',
          '- 第一点',
          '- 第二点',
        ].join('\n'),
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

    expect(wrapper.find('h2').text()).toBe('可见证据')
    expect(wrapper.find('p').text()).toBe('这是独立段落。')
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual([
      '第一点',
      '第二点',
    ])
    expect(wrapper.text()).not.toContain('结构化假')
  })
})
