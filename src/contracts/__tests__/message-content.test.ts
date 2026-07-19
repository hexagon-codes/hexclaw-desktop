import { describe, expect, it } from 'vitest'
import {
  CONTENT_VERSION,
  PRODUCER_KINDS,
  createRenderManifest,
  resolveMessageContent,
  validateMessageContent,
  type MessageContent,
} from '../message-content'

const canonical: MessageContent = {
  content_id: `content:${'a'.repeat(64)}`,
  content_version: CONTENT_VERSION,
  producer_kind: 'k12',
  markdown: '答案是 $\\frac{3}{4}$。',
  source_digest: `sha256:${'a'.repeat(64)}`,
  locale: 'zh-CN',
  attachments: [],
}

describe('MessageContent + RenderManifest protocol', () => {
  it('pins the producer exact set for every full-platform source', () => {
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
  })

  it('accepts a valid canonical envelope and preserves its trace identity', () => {
    expect(validateMessageContent(canonical)).toEqual([])
    expect(resolveMessageContent(canonical)).toMatchObject({
      markdown: canonical.markdown,
      protocol: 'canonical',
      sourceDigest: canonical.source_digest,
      producerKind: 'k12',
    })
  })

  it('keeps old string messages readable but marks them as legacy', () => {
    expect(resolveMessageContent('旧消息')).toEqual({
      markdown: '旧消息',
      protocol: 'legacy',
      sourceDigest: undefined,
      producerKind: undefined,
      error: undefined,
    })
  })

  it('fails visibly instead of rendering an invalid envelope as success', () => {
    const invalid = { ...canonical, source_digest: 'wrong' }
    const resolved = resolveMessageContent(invalid)
    expect(resolved.protocol).toBe('invalid')
    expect(resolved.markdown).toContain('内容协议校验失败')
    expect(resolved.error).toContain('source_digest')
  })

  it('binds each render manifest to source digest and real capabilities', () => {
    const manifest = createRenderManifest(canonical, {
      renderId: 'render-1',
      surface: 'desktop',
      rendererVersion: 'desktop-v1',
      capabilities: { markdown: true, tex_math: true, mathml: true },
      parts: [{ kind: 'markdown', text: canonical.markdown }],
    })
    expect(manifest.content_id).toBe(canonical.content_id)
    expect(manifest.source_digest).toBe(canonical.source_digest)
    expect(manifest.fallback_reason).toBeUndefined()
  })

  it('rejects raw LaTeX on a surface that did not declare math support', () => {
    expect(() => createRenderManifest(canonical, {
      renderId: 'render-2',
      surface: 'channel',
      rendererVersion: 'plain-v1',
      capabilities: { markdown: false, tex_math: false },
      parts: [{ kind: 'text', text: canonical.markdown }],
    })).toThrow(/raw LaTeX|fallback/)
  })
})
