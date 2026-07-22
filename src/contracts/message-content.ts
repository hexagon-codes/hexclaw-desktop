/** Versioned canonical content shared by every message-producing surface. */
export const CONTENT_VERSION = '1.0' as const

export const PRODUCER_KINDS = [
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
] as const

export type ProducerKind = typeof PRODUCER_KINDS[number]

export interface ContentAttachmentRef {
  asset_id: string
  name?: string
  mime: string
  digest: string
  alt_text?: string
}

export interface MessageContent {
  content_id: string
  content_version: typeof CONTENT_VERSION
  producer_kind: ProducerKind
  markdown: string
  source_digest: string
  locale: string
  attachments?: ContentAttachmentRef[]
}

export type RenderSurface =
  | 'desktop'
  | 'quick_chat'
  | 'history'
  | 'k12'
  | 'channel'
  | 'export'

export interface RenderCapabilities {
  markdown: boolean
  tex_math: boolean
  mathml?: boolean
  unicode_math?: boolean
  attachments?: boolean
  max_runes?: number
}

export type RenderPart =
  | { kind: 'markdown' | 'text'; text: string }
  | { kind: 'artifact'; artifact_ref: string; artifact_digest: string; alt_text: string }

export interface RenderManifest {
  render_id: string
  content_id: string
  surface: RenderSurface
  capability_snapshot: RenderCapabilities
  renderer_version: string
  source_digest: string
  parts: RenderPart[]
  fallback_reason?: string
  receipt_ref?: string
}

const SHA256 = /^sha256:[0-9a-f]{64}$/
const CONTENT_ID = /^content:[0-9a-f]{64}$/
const RAW_TEX = /(\\(?:frac|sqrt|sum|int|begin|left|right|times|cdot|leq|geq|alpha|beta)\b|\\[,;:!]|\$[^$\n]+\$|\\\(|\\\[)/s

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateMessageContent(value: unknown): string[] {
  if (!isRecord(value)) return ['content must be an object']
  const errors: string[] = []
  if (value.content_version !== CONTENT_VERSION) errors.push('unsupported content_version')
  if (!PRODUCER_KINDS.includes(value.producer_kind as ProducerKind)) errors.push('invalid producer_kind')
  if (typeof value.markdown !== 'string') errors.push('markdown must be a string')
  if (typeof value.locale !== 'string' || !value.locale.trim()) errors.push('locale is required')
  if (typeof value.source_digest !== 'string' || !SHA256.test(value.source_digest)) errors.push('invalid source_digest')
  if (typeof value.content_id !== 'string' || !CONTENT_ID.test(value.content_id)) {
    errors.push('invalid content_id')
  } else if (typeof value.source_digest === 'string' && SHA256.test(value.source_digest)
    && value.content_id.slice('content:'.length) !== value.source_digest.slice('sha256:'.length)) {
    errors.push('content_id does not match source_digest')
  }
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) {
      errors.push('attachments must be an array')
    } else {
      value.attachments.forEach((attachment, index) => {
        if (!isRecord(attachment)
          || typeof attachment.asset_id !== 'string'
          || typeof attachment.mime !== 'string'
          || typeof attachment.digest !== 'string') {
          errors.push(`attachment ${index} is invalid`)
        }
      })
    }
  }
  return errors
}

export interface ResolvedMessageContent {
  markdown: string
  protocol: 'canonical' | 'legacy' | 'invalid'
  sourceDigest: string | undefined
  producerKind: ProducerKind | undefined
  error: string | undefined
}

export function resolveMessageContent(value: string | MessageContent | unknown): ResolvedMessageContent {
  if (typeof value === 'string') {
    return {
      markdown: value,
      protocol: 'legacy',
      sourceDigest: undefined,
      producerKind: undefined,
      error: undefined,
    }
  }
  const errors = validateMessageContent(value)
  if (errors.length > 0) {
    return {
      markdown: `⚠️ 内容协议校验失败，无法按成功结果展示。\n\n${errors.join('；')}`,
      protocol: 'invalid',
      sourceDigest: undefined,
      producerKind: undefined,
      error: errors.join('; '),
    }
  }
  const content = value as unknown as MessageContent
  return {
    markdown: content.markdown,
    protocol: 'canonical',
    sourceDigest: content.source_digest,
    producerKind: content.producer_kind,
    error: undefined,
  }
}

interface CreateRenderManifestOptions {
  renderId: string
  surface: RenderSurface
  rendererVersion: string
  capabilities: RenderCapabilities
  parts: RenderPart[]
  fallbackReason?: string
  receiptRef?: string
}

export function createRenderManifest(content: MessageContent, options: CreateRenderManifestOptions): RenderManifest {
  const errors = validateMessageContent(content)
  if (errors.length > 0) throw new Error(`invalid MessageContent: ${errors.join('; ')}`)
  if (!options.renderId || !options.rendererVersion || options.parts.length === 0) {
    throw new Error('render id, renderer version and non-empty parts are required')
  }
  const visible = options.parts.map((part) => part.kind === 'artifact' ? part.alt_text : part.text).join('\n')
  if (options.parts.some(part => part.kind === 'markdown') && !options.capabilities.markdown) {
    throw new Error('markdown part requires markdown capability')
  }
  if (RAW_TEX.test(content.markdown) && !options.capabilities.tex_math) {
    if (!options.fallbackReason) throw new Error('math fallback reason is required')
    if (RAW_TEX.test(visible)) throw new Error('raw LaTeX cannot be reported as a successful fallback')
  }
  return {
    render_id: options.renderId,
    content_id: content.content_id,
    surface: options.surface,
    capability_snapshot: { ...options.capabilities },
    renderer_version: options.rendererVersion,
    source_digest: content.source_digest,
    parts: options.parts.map(part => ({ ...part })),
    fallback_reason: options.fallbackReason,
    receipt_ref: options.receiptRef,
  }
}
