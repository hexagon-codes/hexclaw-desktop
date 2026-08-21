import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'
import MarkdownRenderer from '../MarkdownRenderer.vue'

vi.mock('markdown-it', () => ({
  default: class MockMarkdownIt {
    renderer = { rules: {} as Record<string, unknown> }
    utils = {
      escapeHtml: (value: string) =>
        value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;'),
    }

    // 真实组件用 .use(katex) 注册公式插件；mock 需支持链式 no-op
    use() {
      return this
    }

    render(content: string) {
      const match = content.match(/```(\w+)?\n([\s\S]*?)```/)
      if (!match) {
        const typographed = content.replace(/'([^'\n]*)'/g, '‘$1’')
        return `<p>${this.utils.escapeHtml(typographed)}</p>`
      }
      const lang = match[1] || 'text'
      const code = match[2] || ''
      return `<div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${lang}</span>
          <button class="copy-btn" data-code="${this.utils.escapeHtml(code)}">复制</button>
        </div>
        <pre class="code-block"><code class="language-${lang}">${this.utils.escapeHtml(code)}</code></pre>
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

function mountRenderer(content: string | MessageContent) {
  return mount(MarkdownRenderer, {
    props: { content },
    global: {
      plugins: [createTestI18n()],
      stubs: {
        ArtifactRenderer: { template: '<div />' },
      },
    },
    attachTo: document.body,
  })
}

function expectNoLegacyProtocolMarkers(wrapper: ReturnType<typeof mountRenderer>) {
  for (const marker of ['function=', 'parameter=', '/parameter', '/function', '/tool_call']) {
    expect(wrapper.html()).not.toContain(marker)
  }
}

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('copy button should fail gracefully when clipboard API is unavailable', async () => {
    const wrapper = mountRenderer('```ts\nconst a = 1\n```')

    await flushPromises()

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    const copyButton = wrapper.get('.copy-btn')
    expect(() =>
      copyButton.element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    ).not.toThrow()
  })

  it('projects one closed code_exec protocol to one Python code block without mutating canonical content', async () => {
    const protocol = `<function=code_exec>
<parameter=code>
print('hello from legacy code_exec')
</parameter>
</function>
</tool_call>`
    const digest = `sha256:${'d'.repeat(64)}`
    const canonical: MessageContent = {
      content_id: `content:${'d'.repeat(64)}`,
      content_version: '1.0',
      producer_kind: 'chat',
      markdown: protocol,
      source_digest: digest,
      locale: 'zh-CN',
    }
    const canonicalSnapshot = structuredClone(canonical)

    const wrapper = mountRenderer(canonical)
    await flushPromises()

    expect(wrapper.findAll('.code-block-wrapper')).toHaveLength(1)
    expect(wrapper.findAll('.copy-btn')).toHaveLength(1)
    expect(wrapper.get('.code-lang').text()).toBe('python')
    expect(wrapper.get('code.language-python').text()).toBe("print('hello from legacy code_exec')")
    expectNoLegacyProtocolMarkers(wrapper)
    expect(canonical).toEqual(canonicalSnapshot)
    expect(wrapper.attributes('data-source-digest')).toBe(digest)

    const manifest = wrapper.emitted<RenderManifest[]>('rendered')?.[0]?.[0]
    expect(manifest?.source_digest).toBe(digest)
    expect(manifest?.parts).toEqual([{ kind: 'markdown', text: protocol }])
  })

  it.each(['shell', 'bash'])(
    'projects one closed %s protocol to one Bash code block',
    async (toolName) => {
      const protocol = `<function=${toolName}>
<parameter=command>
printf 'hello from shell\\n'
</parameter>
</function>`

      const wrapper = mountRenderer(protocol)
      await flushPromises()

      expect(wrapper.findAll('.code-block-wrapper')).toHaveLength(1)
      expect(wrapper.findAll('.copy-btn')).toHaveLength(1)
      expect(wrapper.get('.code-lang').text()).toBe('bash')
      expect(wrapper.get('code.language-bash').text()).toBe("printf 'hello from shell\\n'")
      expectNoLegacyProtocolMarkers(wrapper)
    },
  )

  it('keeps an unclosed legacy protocol as raw streaming text', async () => {
    const streaming = `<function=code_exec><parameter=code>print('still streaming')`

    const wrapper = mountRenderer(streaming)
    await flushPromises()

    expect(wrapper.findAll('.code-block-wrapper')).toHaveLength(0)
    expect(wrapper.get('.markdown-body').text()).toBe(streaming)
  })

  it('keeps an outer-wrapped protocol raw until the tool_call closes', async () => {
    const streaming = `<tool_call>
<function=code_exec>
<parameter=code>
print('function closed, tool call still streaming')
</parameter>
</function>`

    const wrapper = mountRenderer(streaming)
    await flushPromises()

    expect(wrapper.findAll('.code-block-wrapper')).toHaveLength(0)
    expect(wrapper.get('.markdown-body').text()).toBe(streaming)
  })
})
