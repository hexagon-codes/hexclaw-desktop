import { describe, expect, it } from 'vitest'
import {
  PRODUCER_KINDS,
  createRenderManifest,
  resolveMessageContent,
  validateMessageContent,
  type MessageContent,
} from '@/contracts/message-content'
import { normalizeMathMarkdown } from '@/utils/math-content'

const digest = `sha256:${'a'.repeat(64)}`
const content: MessageContent = {
  content_id: `content:${'a'.repeat(64)}`,
  content_version: '1.0',
  producer_kind: 'chat',
  markdown: String.raw`## 解答

$\frac{3}{4} \times 8 = 6$`,
  source_digest: digest,
  locale: 'zh-CN',
}

describe('unified Markdown/LaTeX renderer contract', () => {
  it('keeps the release producer exact-set on one versioned MessageContent protocol', () => {
    expect(PRODUCER_KINDS).toEqual([
      'chat',
      'quick_chat',
      'k12',
      'skill',
      'tool',
      'rag',
      'report',
      'cron',
      'webhook',
      'workflow',
    ])
    for (const producer_kind of PRODUCER_KINDS) {
      expect(validateMessageContent({ ...content, producer_kind })).toEqual([])
    }
  })

  it('normalizes external delimiters without rewriting code or currency', () => {
    const source = [
      String.raw`正文 \(\frac{3}{4}\)`,
      String.raw`代码 \`\(\frac{1}{2}\)\``,
      '价格 $100，预算 $200。',
    ].join('\n')
    const normalized = normalizeMathMarkdown(source)
    expect(normalized).toContain(String.raw`正文 $\frac{3}{4}$`)
    expect(normalized).toContain(String.raw`\`\(\frac{1}{2}\)\``)
    expect(normalized).toContain('价格 $100，预算 $200。')
  })

  it('binds every projection to the canonical source digest', () => {
    const manifest = createRenderManifest(content, {
      renderId: 'render:test:desktop',
      surface: 'desktop',
      rendererVersion: 'desktop-markdown-v1',
      capabilities: { markdown: true, tex_math: true, mathml: true },
      parts: [{ kind: 'markdown', text: content.markdown }],
    })
    expect(manifest.content_id).toBe(content.content_id)
    expect(manifest.source_digest).toBe(content.source_digest)
    expect(manifest.parts).toEqual([{ kind: 'markdown', text: content.markdown }])
  })

  it('fails closed when a non-LaTeX surface claims raw TeX as a successful fallback', () => {
    expect(() => createRenderManifest(content, {
      renderId: 'render:test:channel',
      surface: 'channel',
      rendererVersion: 'plain-v1',
      capabilities: { markdown: true, tex_math: false, unicode_math: true },
      parts: [{ kind: 'text', text: content.markdown }],
      fallbackReason: 'channel has no native TeX renderer',
    })).toThrow(/raw LaTeX/i)
  })

  it('shows an explicit protocol failure instead of rendering untrusted success content', () => {
    const resolved = resolveMessageContent({ ...content, source_digest: 'sha256:bad' })
    expect(resolved.protocol).toBe('invalid')
    expect(resolved.markdown).toContain('内容协议校验失败')
    expect(resolved.error).toContain('invalid source_digest')
  })
})
