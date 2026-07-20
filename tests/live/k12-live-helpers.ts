import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'

export const DESKTOP_USER_ID = 'desktop-user'

const CONTENT_VERSION = '1.0'
const PRODUCER_KINDS = new Set([
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
const SHA256 = /^sha256:[0-9a-f]{64}$/
const CONTENT_ID = /^content:[0-9a-f]{64}$/

export interface MessageContentEvidence {
  content_id: string
  content_version: string
  producer_kind: string
  markdown: string
  source_digest: string
  locale: string
  attachments?: Array<{
    asset_id: string
    name?: string
    mime: string
    digest: string
    alt_text?: string
  }>
}

export interface RenderManifestEvidence {
  render_id: string
  content_id: string
  surface: string
  capability_snapshot: {
    markdown: boolean
    tex_math: boolean
    mathml?: boolean
    unicode_math?: boolean
    attachments?: boolean
    max_runes?: number
  }
  renderer_version: string
  source_digest: string
  parts: Array<
    | { kind: 'markdown' | 'text'; text: string }
    | { kind: 'artifact'; artifact_ref: string; artifact_digest: string; alt_text: string }
  >
  fallback_reason?: string
  receipt_ref?: string
}

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: string | Record<string, unknown> | null
  meta?: string | Record<string, unknown> | null
  message_content?: MessageContentEvidence
  render_manifest?: RenderManifestEvidence
}

export function envValue(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function invalidURLGate(name: string): boolean {
  const raw = envValue(name)
  if (!raw) return true
  try {
    const value = new URL(raw)
    return (
      !['http:', 'https:'].includes(value.protocol) || Boolean(value.username || value.password)
    )
  } catch {
    return true
  }
}

function invalidDigestGate(name: string): boolean {
  return !/^(?:sha256:)?[0-9a-f]{64}$/i.test(envValue(name))
}

export function liveGateBlockers(options?: {
  isolatedProfile?: boolean
  model?: boolean
  dingTalk?: boolean
}): string[] {
  const blockers: string[] = []
  const requireValue = (name: string, expected?: string) => {
    const value = envValue(name)
    if (!value || (expected !== undefined && value !== expected)) blockers.push(name)
  }

  requireValue('HEX_K12_LIVE_RUN', '1')
  requireValue('HEX_K12_LIVE_APP_URL')
  requireValue('HEX_K12_LIVE_SIDECAR_URL')
  requireValue('HEX_K12_LIVE_APP_BINARY')
  requireValue('HEX_K12_LIVE_APP_SHA256')
  requireValue('HEX_K12_LIVE_EXPECTED_VERSION')
  if (invalidURLGate('HEX_K12_LIVE_APP_URL')) blockers.push('HEX_K12_LIVE_APP_URL(valid-http-url)')
  if (invalidURLGate('HEX_K12_LIVE_SIDECAR_URL'))
    blockers.push('HEX_K12_LIVE_SIDECAR_URL(valid-http-url)')
  if (invalidDigestGate('HEX_K12_LIVE_APP_SHA256'))
    blockers.push('HEX_K12_LIVE_APP_SHA256(valid-sha256)')

  if (options?.isolatedProfile) requireValue('HEX_K12_LIVE_PROFILE_ISOLATED', '1')
  if (options?.model) {
    requireValue('HEX_K12_LIVE_MODEL_AUTHORIZED', '1')
    requireValue('HEX_K12_LIVE_AGENT')
    requireValue('HEX_K12_LIVE_PROVIDER')
    requireValue('HEX_K12_LIVE_MODEL')
  }
  if (options?.dingTalk) {
    requireValue('DINGTALK_LIVE_SEND', '1')
    requireValue('DINGTALK_LIVE_CONFIRM', 'SEND_TO_EXPLICIT_DINGTALK_USER')
    requireValue('DINGTALK_LIVE_INSTANCE')
    requireValue('DINGTALK_LIVE_INSTANCE_ID')
    requireValue('DINGTALK_LIVE_USERID')
    requireValue('HEX_K12_LIVE_AGENT')
    requireValue('HEX_K12_LIVE_RUN_ID')
  }
  return [...new Set(blockers)]
}

export function liveSkipReason(blockers: string[], scope: string): string {
  return `NOT RUN (${scope}): missing or invalid explicit live gate(s): ${blockers.join(', ')}. A skipped case is not a PASS.`
}

function requiredEnv(name: string): string {
  const value = envValue(name)
  if (!value) throw new Error(`required live environment gate is absent: ${name}`)
  return value
}

function absoluteURL(baseName: string, path: string): string {
  const base = new URL(requiredEnv(baseName))
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`
  base.search = ''
  base.hash = ''
  return new URL(path.replace(/^\/+/, ''), base).toString()
}

export function liveAppURL(path = '/'): string {
  return absoluteURL('HEX_K12_LIVE_APP_URL', path)
}

export function liveSidecarURL(path = '/'): string {
  return absoluteURL('HEX_K12_LIVE_SIDECAR_URL', path)
}

export async function liveJSON<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<T> {
  const url = liveSidecarURL(path)
  const response = await request.fetch(url, {
    method,
    data,
    timeout: 240_000,
  })
  if (!response.ok()) {
    // Deliberately do not interpolate the response body: provider errors can
    // include credentials or target identifiers.
    throw new Error(
      `${method} ${new URL(url).pathname} returned HTTP ${response.status()} (body redacted)`,
    )
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new Error(`${method} ${new URL(url).pathname} returned non-JSON evidence (body redacted)`)
  }
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeExpectedDigest(value: string): string {
  return value.replace(/^sha256:/i, '').toLowerCase()
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', () =>
      reject(new Error('installed binary could not be hashed (path redacted)')),
    )
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function attachJSON(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: 'application/json',
  })
}

/**
 * Proves that this run is pinned to a frozen installed artifact and a real,
 * version-matched sidecar. The browser URL must serve built assets; a Vite
 * source/dev page is rejected. This does not pretend Chromium/WebKit is the
 * native Tauri WKWebView; DEVICE evidence remains a separate release gate.
 */
export async function assertLiveRuntime(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
): Promise<void> {
  const binaryPath = requiredEnv('HEX_K12_LIVE_APP_BINARY')
  let fileInfo
  try {
    fileInfo = await stat(binaryPath)
  } catch {
    throw new Error('installed binary is unavailable at the gated path (path redacted)')
  }
  expect(
    fileInfo.isFile(),
    'HEX_K12_LIVE_APP_BINARY must name the executable file inside the installed app',
  ).toBe(true)

  const binaryDigest = await sha256File(binaryPath)
  expect(binaryDigest, 'installed app executable must match the frozen RC SHA-256').toBe(
    normalizeExpectedDigest(requiredEnv('HEX_K12_LIVE_APP_SHA256')),
  )

  const health = await liveJSON<{ status?: string }>(request, 'GET', '/health')
  expect(health.status, 'real sidecar health must be healthy').toBe('healthy')
  const version = await liveJSON<{ version?: string; engine?: string; engine_version?: string }>(
    request,
    'GET',
    '/api/v1/version',
  )
  expect(version.version, 'sidecar version must match the frozen RC version').toBe(
    requiredEnv('HEX_K12_LIVE_EXPECTED_VERSION'),
  )

  const appResponse = await request.get(liveAppURL('/'), { timeout: 30_000 })
  expect(appResponse.ok(), 'release UI URL must be reachable').toBe(true)
  const html = await appResponse.text()
  expect(html.includes('/@vite/client'), 'LIVE lane must not use the Vite development client').toBe(
    false,
  )
  expect(
    /(?:src|href)=["'][^"']*\/src\//i.test(html),
    'LIVE lane must not load source modules',
  ).toBe(false)
  expect(
    /(?:src|href)=["'][^"']*\/assets\//i.test(html),
    'release UI must reference built assets',
  ).toBe(true)

  await page.goto(liveAppURL('/'), { waitUntil: 'domcontentloaded' })
  await expect(page.locator('body')).toBeVisible()
  await attachJSON(testInfo, 'live-runtime-evidence', {
    binary_name: basename(binaryPath),
    binary_sha256: binaryDigest,
    release_html_sha256: sha256Text(html),
    sidecar_version: version.version,
    engine: version.engine,
    engine_version: version.engine_version,
    health: health.status,
    browser_project: testInfo.project.name,
  })
}

function goJSON(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function canonicalDigestInput(content: MessageContentEvidence): Record<string, unknown> {
  const input: Record<string, unknown> = {
    content_version: content.content_version,
    producer_kind: content.producer_kind,
    markdown: content.markdown,
    locale: content.locale,
  }
  if (content.attachments?.length) {
    input.attachments = content.attachments.map((attachment) => ({
      asset_id: attachment.asset_id,
      ...(attachment.name ? { name: attachment.name } : {}),
      mime: attachment.mime,
      digest: attachment.digest,
      ...(attachment.alt_text ? { alt_text: attachment.alt_text } : {}),
    }))
  }
  return input
}

export function assertCanonicalContent(
  value: MessageContentEvidence | undefined,
  expectedProducer?: string,
): MessageContentEvidence {
  expect(Boolean(value), 'producer must return MessageContent').toBe(true)
  const content = value!
  expect(content.content_version).toBe(CONTENT_VERSION)
  expect(
    PRODUCER_KINDS.has(content.producer_kind),
    'producer_kind must come from the frozen registry',
  ).toBe(true)
  if (expectedProducer) expect(content.producer_kind).toBe(expectedProducer)
  expect(content.markdown.trim().length, 'canonical Markdown must not be empty').toBeGreaterThan(0)
  expect(content.locale.trim().length, 'canonical locale must not be empty').toBeGreaterThan(0)
  expect(content.source_digest).toMatch(SHA256)
  expect(content.content_id).toMatch(CONTENT_ID)
  const digest = `sha256:${sha256Text(goJSON(canonicalDigestInput(content)))}`
  expect(content.source_digest, 'source_digest must cover the exact canonical envelope').toBe(
    digest,
  )
  expect(content.content_id, 'content_id must carry the source digest identity').toBe(
    `content:${digest.slice('sha256:'.length)}`,
  )
  return content
}

export function assertRenderManifest(
  value: RenderManifestEvidence | undefined,
  content: MessageContentEvidence,
  expectedSurface: string,
): RenderManifestEvidence {
  expect(Boolean(value), `${expectedSurface} projection must return RenderManifest`).toBe(true)
  const manifest = value!
  expect(manifest.render_id.trim().length).toBeGreaterThan(0)
  expect(manifest.content_id).toBe(content.content_id)
  expect(manifest.source_digest).toBe(content.source_digest)
  expect(manifest.surface).toBe(expectedSurface)
  expect(manifest.renderer_version.trim().length).toBeGreaterThan(0)
  expect(
    manifest.parts.length,
    'successful projection must have at least one auditable part',
  ).toBeGreaterThan(0)
  return manifest
}

export function metadataOf(message: HistoryMessage): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const raw of [message.metadata, message.meta]) {
    if (!raw) continue
    if (typeof raw === 'string') {
      try {
        Object.assign(merged, JSON.parse(raw) as Record<string, unknown>)
      } catch {
        // Malformed optional metadata is not allowed to hide canonical fields;
        // producer/model assertions below will fail with a redacted message.
      }
    } else {
      Object.assign(merged, raw)
    }
  }
  return merged
}

export async function listHistory(
  request: APIRequestContext,
  sessionID: string,
): Promise<HistoryMessage[]> {
  const payload = await liveJSON<{ messages?: HistoryMessage[] }>(
    request,
    'GET',
    `/api/v1/sessions/${encodeURIComponent(sessionID)}/messages?user_id=${encodeURIComponent(DESKTOP_USER_ID)}&limit=200`,
  )
  return payload.messages ?? []
}

export function lastAssistantWithMarker(
  messages: HistoryMessage[],
  marker: string,
): HistoryMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.content.includes(marker)) return message
  }
  return undefined
}

export async function cleanupLiveSession(
  request: APIRequestContext,
  sessionID: string,
): Promise<void> {
  if (!sessionID) return
  await liveJSON<Record<string, unknown>>(
    request,
    'DELETE',
    `/api/v1/sessions/${encodeURIComponent(sessionID)}?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`,
  )
}

export async function cleanupLiveChild(
  request: APIRequestContext,
  childName: string,
): Promise<void> {
  if (!childName) return
  const payload = await liveJSON<{
    agents?: Array<{ name?: string; metadata?: Record<string, string> }>
  }>(request, 'GET', '/api/v1/agents')
  for (const agent of payload.agents ?? []) {
    if (agent.name && agent.metadata?.['k12.child_name'] === childName) {
      await liveJSON<Record<string, unknown>>(
        request,
        'DELETE',
        `/api/v1/agents/${encodeURIComponent(agent.name)}`,
      )
    }
  }
}
