import type { MessageContent, RenderManifest } from './message-content'

export interface RenderEvidenceTarget {
  message_content?: MessageContent
  render_manifest?: RenderManifest
}

export interface NestedRenderEvidenceTarget {
  render_manifests?: RenderManifest[]
}

/** Bind the renderer's receipt to the exact canonical source it projected. */
export function recordRenderManifest(target: RenderEvidenceTarget, manifest: RenderManifest): void {
  const source = target.message_content
  if (source && (manifest.source_digest !== source.source_digest || manifest.content_id !== source.content_id)) {
    throw new Error('render manifest source digest/content id does not match projected MessageContent')
  }
  target.render_manifest = { ...manifest, parts: manifest.parts.map(part => ({ ...part })) }
}

/** Retain per-block receipts for ordered ReAct messages; rerenders are idempotent. */
export function recordNestedRenderManifest(target: NestedRenderEvidenceTarget, manifest: RenderManifest): void {
  if (!manifest.render_id || !manifest.content_id || !manifest.source_digest) {
    throw new Error('nested render manifest identity is required')
  }
  const current = target.render_manifests ?? []
  if (current.some(item => item.render_id === manifest.render_id)) return
  target.render_manifests = [...current, {
    ...manifest,
    parts: manifest.parts.map(part => ({ ...part })),
  }]
}
