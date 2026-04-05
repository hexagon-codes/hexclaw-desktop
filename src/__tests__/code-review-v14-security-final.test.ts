/**
 * code-review-v14-security-final — Static analysis security review
 *
 * Verifies previously-fixed security issues remain fixed and
 * validates security properties across the Rust and TypeScript layers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../..')
function readSrc(path: string): string {
  return readFileSync(resolve(ROOT, 'src', path), 'utf-8')
}
function readRust(path: string): string {
  return readFileSync(resolve(ROOT, 'src-tauri/src', path), 'utf-8')
}

// ═══════════════════════════════════════════════════════════
// 1. SSRF protection in stream_chat (FIXED)
// ═══════════════════════════════════════════════════════════
describe('SSRF protection in stream_chat', () => {
  const commands = readRust('commands.rs')

  it('checks is_loopback() for IPv4 addresses', () => {
    expect(commands).toContain('v4.is_loopback()')
  })

  it('checks is_private() for IPv4 addresses', () => {
    expect(commands).toContain('v4.is_private()')
  })

  it('checks is_loopback() for IPv6 addresses', () => {
    expect(commands).toContain('v6.is_loopback()')
  })

  it('blocks cloud metadata endpoint 169.254.169.254', () => {
    expect(commands).toContain('169.254.169.254')
  })

  it('blocks cloud metadata endpoint metadata.google.internal', () => {
    expect(commands).toContain('metadata.google.internal')
  })

  it('returns an error message for private/loopback addresses', () => {
    expect(commands).toMatch(/Blocked.*private.*loopback/)
  })

  it('validates URL scheme is http or https only', () => {
    expect(commands).toContain('scheme != "https" && scheme != "http"')
  })
})

// ═══════════════════════════════════════════════════════════
// 2. safe-html.ts — no wasteful double-sanitization (FIXED)
// ═══════════════════════════════════════════════════════════
describe('safe-html.ts single-pass sanitization', () => {
  const safeHtml = readSrc('utils/safe-html.ts')

  it('looksLikeHtmlDocument check comes BEFORE fragment sanitization', () => {
    const docCheckPos = safeHtml.indexOf('looksLikeHtmlDocument(content)')
    const fragmentSanitizePos = safeHtml.indexOf('WHOLE_DOCUMENT: false')
    expect(docCheckPos).toBeGreaterThan(-1)
    expect(fragmentSanitizePos).toBeGreaterThan(-1)
    expect(docCheckPos).toBeLessThan(fragmentSanitizePos)
  })

  it('only has one DOMPurify.sanitize call per code path (document vs fragment)', () => {
    // Count DOMPurify.sanitize calls excluding the title sanitization
    const lines = safeHtml.split('\n')
    const sanitizeCalls = lines.filter(
      (l) => l.includes('DOMPurify.sanitize(content') || l.includes('DOMPurify.sanitize(content,'),
    )
    // Exactly two calls: one for WHOLE_DOCUMENT:true, one for WHOLE_DOCUMENT:false
    expect(sanitizeCalls.length).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════
// 3. file-parser.ts file size limit (FIXED)
// ═══════════════════════════════════════════════════════════
describe('file-parser.ts file size limit', () => {
  const fileParser = readSrc('utils/file-parser.ts')

  it('defines MAX_FILE_SIZE constant', () => {
    expect(fileParser).toMatch(/const MAX_FILE_SIZE\s*=/)
  })

  it('parseDocument checks file.size > MAX_FILE_SIZE before processing', () => {
    expect(fileParser).toContain('file.size > MAX_FILE_SIZE')
  })

  it('throws an Error when file exceeds the size limit', () => {
    expect(fileParser).toMatch(/throw new Error.*too large/)
  })
})

// ═══════════════════════════════════════════════════════════
// 4. WebSocket reconnect loop prevention (FIXED)
// ═══════════════════════════════════════════════════════════
describe('WebSocket reconnect loop prevention', () => {
  const ws = readSrc('api/websocket.ts')

  it('does NOT immediately reset reconnectAttempts in onopen', () => {
    // The reconnectAttempts = 0 should NOT appear directly in the onopen handler
    // without a stability delay
    const onopenMatch = ws.match(/onopen\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}/)
    expect(onopenMatch).toBeTruthy()
    const onopenBody = onopenMatch![1]
    // The direct assignment should be inside a setTimeout, not as a bare statement
    expect(onopenBody).not.toMatch(/^\s*this\.reconnectAttempts\s*=\s*0/m)
  })

  it('uses a stability timer (setTimeout) before resetting reconnect counter', () => {
    expect(ws).toMatch(/setTimeout\s*\(\s*\(\)\s*=>\s*\{\s*this\.reconnectAttempts\s*=\s*0/)
  })

  it('has a stability delay of at least a few seconds', () => {
    // The timer uses 10_000 (10 seconds)
    const timerMatch = ws.match(/setTimeout\(\s*\(\)\s*=>\s*\{[^}]*reconnectAttempts[^}]*\}\s*,\s*(\d[\d_]*)/)
    expect(timerMatch).toBeTruthy()
    const delay = Number(timerMatch![1].replace(/_/g, ''))
    expect(delay).toBeGreaterThanOrEqual(5000)
  })

  it('clears the stability timer if connection closes early', () => {
    expect(ws).toContain('clearTimeout(stableTimer)')
  })
})

// ═══════════════════════════════════════════════════════════
// 5. Credential handling
// ═══════════════════════════════════════════════════════════
describe('Credential handling', () => {
  const commands = readRust('commands.rs')
  const secureStore = readSrc('utils/secure-store.ts')

  it('stream_chat forwards API key only via Authorization header', () => {
    // The API key should appear in an Authorization header, not in the URL or body
    expect(commands).toMatch(/\.header\("Authorization",\s*format!\("Bearer \{\}",\s*params\.api_key\)/)
  })

  it('save_secret uses keyring for OS-native storage', () => {
    expect(commands).toContain('keyring::Entry::new(KEYRING_SERVICE')
    expect(commands).toContain('entry.set_password(&value)')
  })

  it('load_secret uses keyring for OS-native storage', () => {
    expect(commands).toContain('entry.get_password()')
    expect(commands).toContain('keyring::Error::NoEntry')
  })

  it('secure-store.ts never logs the actual key value', () => {
    // logger calls should only reference the key name, not the value
    const loggerLines = secureStore.split('\n').filter((l) => l.includes('logger.'))
    for (const line of loggerLines) {
      // Should not log 'value' or the variable itself
      expect(line).not.toMatch(/logger\.\w+\(.*\bvalue\b/)
    }
  })

  it('secure-store.ts uses crypto.getRandomValues for device salt', () => {
    expect(secureStore).toContain('crypto.getRandomValues')
  })
})

// ═══════════════════════════════════════════════════════════
// 6. Process cleanup
// ═══════════════════════════════════════════════════════════
describe('Process cleanup', () => {
  const sidecar = readRust('sidecar.rs')
  const lib = readRust('lib.rs')

  it('sidecar.rs calls child.kill() for cleanup', () => {
    expect(sidecar).toContain('child.kill()')
  })

  it('sidecar.rs waits for the child process after killing', () => {
    expect(sidecar).toContain('child.wait()')
  })

  it('lib.rs registers a WindowEvent::Destroyed handler', () => {
    expect(lib).toContain('WindowEvent::Destroyed')
  })

  it('lib.rs calls stop_sidecar on main window destroy', () => {
    expect(lib).toContain('sidecar::stop_sidecar()')
  })

  it('lib.rs calls stop_ollama on main window destroy', () => {
    expect(lib).toContain('ollama::stop_ollama()')
  })
})

// ═══════════════════════════════════════════════════════════
// 7. proxy_api_request safety
// ═══════════════════════════════════════════════════════════
describe('proxy_api_request safety', () => {
  const commands = readRust('commands.rs')

  it('requires path to start with /', () => {
    expect(commands).toContain("!path.starts_with('/')")
  })

  it('rejects path containing ".."', () => {
    expect(commands).toContain('path.contains("..")')
  })

  it('target is always localhost via sidecar::base_url()', () => {
    // The proxy URL is constructed from sidecar::base_url() which is always localhost
    expect(commands).toMatch(/format!\("{}{}",\s*sidecar::base_url\(\),\s*path\)/)
  })

  it('returns an error for invalid API paths', () => {
    expect(commands).toContain('Invalid API path')
  })
})

// ═══════════════════════════════════════════════════════════
// 8. DOMPurify + markdown-it double defense
// ═══════════════════════════════════════════════════════════
describe('DOMPurify + markdown-it double defense in MarkdownRenderer', () => {
  const md = readSrc('components/chat/MarkdownRenderer.vue')

  it('configures markdown-it with html: false', () => {
    expect(md).toMatch(/new MarkdownIt\(\{[^}]*html:\s*false/)
  })

  it('runs DOMPurify.sanitize on the rendered markdown output', () => {
    expect(md).toContain('DOMPurify.sanitize(mdInstance.value.render(props.content))')
  })

  it('imports DOMPurify explicitly', () => {
    expect(md).toMatch(/import DOMPurify from ['"]dompurify['"]/)
  })
})

// ═══════════════════════════════════════════════════════════
// 9. iframe sandbox
// ═══════════════════════════════════════════════════════════
describe('iframe sandbox attributes', () => {
  const artifactRenderer = readSrc('components/chat/ArtifactRenderer.vue')
  const artifactPreview = readSrc('components/artifacts/ArtifactPreview.vue')

  it('ArtifactRenderer.vue uses sandbox attribute on iframe', () => {
    expect(artifactRenderer).toMatch(/sandbox="[^"]*"/)
  })

  it('ArtifactRenderer.vue does not allow-same-origin in sandbox', () => {
    const sandboxMatch = artifactRenderer.match(/sandbox="([^"]*)"/)
    expect(sandboxMatch).toBeTruthy()
    expect(sandboxMatch![1]).not.toContain('allow-same-origin')
  })

  it('ArtifactPreview.vue uses the strictest sandbox (empty string)', () => {
    expect(artifactPreview).toContain('sandbox=""')
  })

  it('ArtifactRenderer.vue injects Content-Security-Policy in iframe content', () => {
    expect(artifactRenderer).toContain('Content-Security-Policy')
  })
})
