import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import MarkdownRenderer from '../MarkdownRenderer.vue'

vi.mock('markdown-it', () => ({
  default: class MockMarkdownIt {
    renderer = { rules: {} as Record<string, unknown> }
    utils = { escapeHtml: (s: string) => s }

    render(content: string) {
      const match = content.match(/```(\w+)?\n([\s\S]*?)```/)
      if (!match) return `<p>${content}</p>`
      const lang = match[1] || 'text'
      const code = match[2] || ''
      return `<div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${lang}</span>
          <button class="copy-btn" data-code="${code}">复制</button>
        </div>
      </div>`
    }
  },
}))

vi.mock('dompurify', () => ({
  default: {
    sanitize: (value: string) => value,
  },
}))

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>const a = 1</code></pre>'),
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('copy button should fail gracefully when clipboard API is unavailable', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst a = 1\n```',
      },
      global: {
        plugins: [createTestI18n()],
        stubs: {
          ArtifactRenderer: { template: '<div />' },
        },
      },
      attachTo: document.body,
    })

    await flushPromises()

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    const copyButton = wrapper.get('.copy-btn')
    expect(() => copyButton.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow()
  })
})
