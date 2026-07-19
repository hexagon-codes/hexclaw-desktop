import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import MessageText from '../MessageText.vue'
import zhCN from '@/i18n/locales/zh-CN'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>x</code></pre>'),
}))

const digest = `sha256:${'b'.repeat(64)}`
const canonical: MessageContent = {
  content_id: `content:${'b'.repeat(64)}`,
  content_version: '1.0',
  producer_kind: 'k12',
  markdown: String.raw`题目：$\frac{3}{4} \times 8$

- 先约分
- 再计算`,
  source_digest: digest,
  locale: 'zh-CN',
}

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

describe('message Markdown/LaTeX projection', () => {
  it('renders a canonical K12 fraction and emits a source-bound RenderManifest', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: canonical, surface: 'k12' },
      global: {
        plugins: [i18n()],
        stubs: { ArtifactRenderer: { template: '<div />' } },
      },
    })

    expect(wrapper.attributes('data-content-protocol')).toBe('canonical')
    expect(wrapper.attributes('data-source-digest')).toBe(canonical.source_digest)
    expect(wrapper.attributes('data-producer-kind')).toBe('k12')
    expect(wrapper.find('.katex').exists()).toBe(true)
    expect(wrapper.html()).toContain('mfrac')
    const manifest = wrapper.emitted<RenderManifest[]>('rendered')?.[0]?.[0]
    expect(manifest).toMatchObject({
      content_id: canonical.content_id,
      source_digest: canonical.source_digest,
      surface: 'k12',
      renderer_version: 'desktop-markdown-v1',
    })
  })

  it('renders the same canonical fraction in a user message without exposing raw TeX', () => {
    const wrapper = mount(MessageText, {
      props: { content: String.raw`我的答案是 \(\frac{3}{4}\)` },
      global: { plugins: [i18n()] },
    })
    expect(wrapper.find('.katex').exists()).toBe(true)
    expect(wrapper.html()).toContain('mfrac')
    const visible = wrapper.get('[data-testid="msg-text"]').element.cloneNode(true) as HTMLElement
    visible.querySelectorAll('.katex').forEach(node => node.remove())
    expect(visible.textContent).not.toContain('\\frac')
  })

  it('invalid canonical metadata is a visible failure, not a successful legacy render', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: { ...canonical, content_id: `content:${'c'.repeat(64)}` } },
      global: {
        plugins: [i18n()],
        stubs: { ArtifactRenderer: { template: '<div />' } },
      },
    })
    expect(wrapper.attributes('data-content-protocol')).toBe('invalid')
    expect(wrapper.text()).toContain('内容协议校验失败')
    expect(wrapper.emitted('rendered')).toBeUndefined()
  })
})
