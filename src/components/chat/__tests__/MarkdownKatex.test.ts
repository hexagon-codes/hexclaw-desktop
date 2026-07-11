import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import MarkdownRenderer from '../MarkdownRenderer.vue'

// 只 mock shiki（异步高亮，与公式无关），markdown-it / dompurify / katex 全用真实实现，
// 以验证「渲染 → DOMPurify 净化」整条链路后 KaTeX 输出仍存活（真实风险：DOMPurify 剥离内联 style）。
vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>x</code></pre>'),
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function render(content: string) {
  return mount(MarkdownRenderer, {
    props: { content },
    global: {
      plugins: [createTestI18n()],
      stubs: { ArtifactRenderer: { template: '<div />' } },
    },
  })
}

describe('MarkdownRenderer · KaTeX (M1-1)', () => {
  it('行内公式 $..$ 渲染为 .katex 且 DOMPurify 保留内联 style', () => {
    const html = render('勾股：$a^2 + b^2 = c^2$ 成立').html()
    expect(html).toContain('katex')
    // 关键回归点：KaTeX 依赖内联 style 定位，DOMPurify 必须保留，否则公式会塌成一行乱码
    expect(html).toMatch(/style="[^"]*height/)
  })

  it('块级公式 $$..$$ 渲染为 .katex-display', () => {
    const html = render('$$\\frac{a}{b} = c$$').html()
    expect(html).toContain('katex-display')
  })

  it('mhchem 化学式 \\ce{} 正常渲染（不落 katex-error）', () => {
    const html = render('水的分子式：$\\ce{H2O}$').html()
    expect(html).toContain('katex')
    expect(html).not.toContain('katex-error')
  })

  it('非法公式失败降级：不抛异常，退回原文（不报红由 CSS 兜底）', () => {
    expect(() => render('坏公式：$\\frac{$ 结束').html()).not.toThrow()
  })

  it('无公式内容不受影响，正常渲染段落', () => {
    const html = render('普通一句话，无公式。').html()
    expect(html).toContain('普通一句话')
    expect(html).not.toContain('katex')
  })
})
