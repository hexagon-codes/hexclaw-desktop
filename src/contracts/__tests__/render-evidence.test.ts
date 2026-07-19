import { describe, expect, it } from 'vitest'
import { recordNestedRenderManifest, recordRenderManifest } from '../render-evidence'
import type { MessageContent, RenderManifest } from '../message-content'

const digest = `sha256:${'c'.repeat(64)}`
const content: MessageContent = {
  content_id: `content:${'c'.repeat(64)}`,
  content_version: '1.0',
  producer_kind: 'chat',
  markdown: '答案是 $x^2$。',
  source_digest: digest,
  locale: 'zh-CN',
}
const manifest: RenderManifest = {
  render_id: 'render:desktop:1',
  content_id: content.content_id,
  surface: 'desktop',
  capability_snapshot: { markdown: true, tex_math: true },
  renderer_version: 'desktop-v1',
  source_digest: digest,
  parts: [{ kind: 'markdown', text: content.markdown }],
}

describe('recordRenderManifest', () => {
  it('records renderer evidence on the projected message', () => {
    const target: { message_content?: MessageContent; render_manifest?: RenderManifest } = {
      message_content: content,
    }
    recordRenderManifest(target, manifest)
    expect(target.render_manifest).toEqual(manifest)
  })

  it('fails closed when a renderer reports evidence for another source', () => {
    const target = { message_content: content }
    expect(() => recordRenderManifest(target, {
      ...manifest,
      source_digest: `sha256:${'d'.repeat(64)}`,
    })).toThrow(/source digest/i)
  })

  it('keeps distinct ordered-block render receipts without duplicating rerenders', () => {
    const target: { render_manifests?: RenderManifest[] } = {}
    recordNestedRenderManifest(target, manifest)
    recordNestedRenderManifest(target, manifest)
    recordNestedRenderManifest(target, { ...manifest, render_id: 'render:desktop:2' })
    expect(target.render_manifests?.map(item => item.render_id)).toEqual([
      'render:desktop:1',
      'render:desktop:2',
    ])
  })
})
