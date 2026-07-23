import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import { KATEX_RENDER_POLICY } from '@/utils/math-content'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import MessageText from '../MessageText.vue'

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>x</code></pre>'),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountMarkdown(content: string) {
  return mount(MarkdownRenderer, {
    props: { content },
    global: {
      plugins: [i18n()],
      stubs: { ArtifactRenderer: { template: '<div />' } },
    },
  })
}

describe('2026-07-23 · shared KaTeX safety and honest fallback policy', () => {
  it('keeps one finite, untrusted, accessible policy for both renderers', () => {
    expect(KATEX_RENDER_POLICY).toMatchObject({
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'warn',
      maxSize: 20,
      maxExpand: 1000,
    })
  })

  it.each([
    ['user plain-text boundary', () => mount(MessageText, {
      props: { content: String.raw`$\rule{1em}{100000em}$` },
      global: { plugins: [i18n()] },
    })],
    ['shared Markdown boundary', () => mountMarkdown(String.raw`$\rule{1em}{100000em}$`)],
  ])('caps attacker-controlled visual dimensions in the %s', (_label, render) => {
    const wrapper = render()
    const visualHtml = wrapper.get('.katex-html').html()

    expect(visualHtml).not.toContain('100000em')
    expect(visualHtml).toContain('20em')
  })

  it.each([
    ['user plain-text boundary', () => mount(MessageText, {
      props: { content: String.raw`坏公式：$\frac{1}$ 结束` },
      global: { plugins: [i18n()] },
    })],
    ['shared Markdown boundary', () => mountMarkdown(String.raw`坏公式：$\frac{1}$ 结束`)],
  ])('preserves the complete delimited source on parse failure in the %s', (_label, render) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const wrapper = render()

      expect(wrapper.text()).toContain(String.raw`坏公式：$\frac{1}$ 结束`)
      expect(wrapper.find('.katex-error').exists()).toBe(false)
      expect(consoleError, 'expected parse fallback must not print an exception stack').not.toHaveBeenCalled()
      expect(wrapper.find('[data-math-fallback="parse-error"]').exists()).toBe(
        _label === 'shared Markdown boundary',
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
