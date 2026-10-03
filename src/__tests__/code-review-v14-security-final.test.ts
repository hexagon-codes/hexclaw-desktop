/**
 * Current static security boundaries. Historical Rust provider/proxy assertions
 * were retired with the single-Sidecar transport and native credential vault.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../..')
const readSrc = (path: string) => readFileSync(resolve(ROOT, 'src', path), 'utf-8')
const readRust = (path: string) =>
  readFileSync(resolve(ROOT, 'src-tauri/src', path), 'utf-8')

describe('single Sidecar transport authority', () => {
  const commands = readRust('commands.rs')
  const compat = readSrc('services/chat-service-compat.ts')

  it('keeps direct provider chat and arbitrary proxy commands retired', () => {
    expect(commands).not.toMatch(/async fn (?:stream_chat|backend_chat)\b/)
    expect(commands).toMatch(/pub async fn proxy_api_request\b/)
    expect(commands).toContain('execute_sidecar_fetch(method, path, headers, bytes')
  })

  it('keeps the compatibility adapter WebSocket-only', () => {
    expect(compat).toContain('openWebSocketStream')
    expect(compat).not.toContain('fetch(')
    expect(compat).not.toContain('invoke(')
    expect(compat).not.toContain('api_key')
  })
})

describe('safe HTML boundaries', () => {
  const safeHtml = readSrc('utils/safe-html.ts')
  const markdown = readSrc('components/chat/MarkdownRenderer.vue')

  it('chooses document mode before fragment sanitization', () => {
    const documentCheck = safeHtml.indexOf('looksLikeHtmlDocument(content)')
    const fragmentSanitize = safeHtml.indexOf('WHOLE_DOCUMENT: false')
    expect(documentCheck).toBeGreaterThan(-1)
    expect(documentCheck).toBeLessThan(fragmentSanitize)
  })

  it('disables raw Markdown HTML and sanitizes rendered output', () => {
    expect(markdown).toMatch(/new MarkdownIt\(\{[^}]*html:\s*false/)
    expect(markdown).toContain('DOMPurify.sanitize(')
    expect(markdown).toContain('KATEX_DOMPURIFY_CONFIG')
  })
})

describe('file parsing budget', () => {
  const parser = readSrc('utils/file-parser.ts')
  const boundary = readSrc('contracts/chat-file-boundary.ts')

  it('checks the shared file-size limit before parsing', () => {
    expect(boundary).toMatch(/CHAT_FILE_MAX_BYTES\s*=\s*200\s*\*\s*1024\s*\*\s*1024/)
    expect(parser).toContain('effectiveChatFileSize(file)')
    expect(parser).toContain('fileSize > CHAT_FILE_MAX_BYTES')
    expect(parser).toMatch(/throw new Error\([\s\S]*?too large/)
  })
})


describe('write-only renderer credential boundary', () => {
  const secureStore = readSrc('utils/secure-store.ts')

  it('exposes typed mutation and presence without plaintext reads', () => {
    expect(secureStore).toContain('putCredential')
    expect(secureStore).toContain('deleteCredential')
    expect(secureStore).toContain('credentialPresent')
    expect(secureStore).not.toContain('get_credential')
    expect(secureStore).not.toContain('read_credential')
  })

  it('rejects standalone browser mutations in favor of the Sidecar coordinator', () => {
    expect(secureStore).toContain('Sidecar secret coordinator')
    expect(secureStore).not.toContain('localStorage')
  })

  it('never logs secret values', () => {
    for (const line of secureStore.split('\n').filter((value) => value.includes('logger.'))) {
      expect(line).not.toMatch(/logger\.\w+\(.*\bvalue\b/)
    }
  })
})

describe('native Sidecar transfer boundary', () => {
  const commands = readRust('commands.rs')

  it('keeps the arbitrary proxy command retired', () => {
    expect(commands).toContain('execute_sidecar_fetch(method, path, headers, bytes')
  })

})


describe('iframe sandbox boundaries', () => {
  const renderer = readSrc('components/chat/ArtifactRenderer.vue')
  const preview = readSrc('components/artifacts/ArtifactPreview.vue')

  it('uses sandboxing without same-origin authority', () => {
    const sandbox = renderer.match(/sandbox="([^"]*)"/)
    expect(sandbox).toBeTruthy()
    expect(sandbox![1]).not.toContain('allow-same-origin')
    expect(preview).toContain('sandbox=""')
    expect(renderer).toContain('Content-Security-Policy')
  })
})
