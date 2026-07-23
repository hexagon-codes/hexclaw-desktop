import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import { normalizeMathMarkdown, plainMathSegments } from '@/utils/math-content'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import MessageText from '../MessageText.vue'

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>x</code></pre>'),
}))

const FULL_SOURCE = String.raw`$1\frac{1}{2} \times \frac{2}{3} =$$2\frac{1}{4} \div \frac{9}{8} =$`
const FORMULAS = [
  String.raw`1\frac{1}{2} \times \frac{2}{3} =`,
  String.raw`2\frac{1}{4} \div \frac{9}{8} =`,
] as const

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

describe('BUG-20260723 · inline mixed-number formulas stay atomic', () => {
  it('keeps the complete approved source as two adjacent inline math segments', () => {
    expect(normalizeMathMarkdown(FULL_SOURCE)).toBe(FULL_SOURCE)
    expect(plainMathSegments(FULL_SOURCE)).toEqual([
      {
        type: 'math',
        content: FORMULAS[0],
        source: `$${FORMULAS[0]}$`,
        display: false,
      },
      {
        type: 'math',
        content: FORMULAS[1],
        source: `$${FORMULAS[1]}$`,
        display: false,
      },
    ])
  })

  it('renders both adjacent formulas atomically in a user message without visible raw TeX', () => {
    const wrapper = mount(MessageText, {
      props: { content: FULL_SOURCE },
      global: { plugins: [i18n()] },
    })

    const inlineMath = wrapper.findAll('.hc-math-inline')
    expect(inlineMath).toHaveLength(2)
    expect(inlineMath.every((node) => node.classes().includes('hc-msg__math'))).toBe(true)
    expect(wrapper.findAll('.katex')).toHaveLength(2)
    expect(wrapper.find('.katex-error').exists()).toBe(false)
    expect(
      wrapper
        .findAll('annotation[encoding="application/x-tex"]')
        .map((annotation) => annotation.text()),
    ).toEqual(FORMULAS)

    const visible = wrapper.get('[data-testid="msg-text"]').element.cloneNode(true) as HTMLElement
    visible.querySelectorAll('.katex').forEach((node) => node.remove())
    expect(visible.textContent).not.toContain('\\frac')
  })

  it.each(['desktop', 'k12'] as const)(
    'renders both formulas through the shared Markdown contract on the %s surface',
    (surface) => {
      const wrapper = mount(MarkdownRenderer, {
        props: { content: FULL_SOURCE, surface },
        global: {
          plugins: [i18n()],
          stubs: { ArtifactRenderer: { template: '<div />' } },
        },
      })

      expect(wrapper.findAll('.hc-math-inline')).toHaveLength(2)
      expect(wrapper.findAll('.katex')).toHaveLength(2)
      expect(wrapper.find('.katex-error').exists()).toBe(false)
      expect(
        wrapper
          .findAll('annotation[encoding="application/x-tex"]')
          .map((annotation) => annotation.text()),
      ).toEqual(FORMULAS)

      const visible = wrapper.get('.markdown-body').element.cloneNode(true) as HTMLElement
      visible.querySelectorAll('.katex').forEach((node) => node.remove())
      expect(visible.textContent).not.toContain('\\frac')
    },
  )
})
