/**
 * Area 3: CSP and security policy in tauri.conf.json
 *
 * Verifies the Content-Security-Policy is correctly configured for:
 * - API calls to localhost:16060
 * - WebSocket connections to ws://localhost:16060
 * - Image loading from the backend (QR codes, etc.)
 * - No unsafe-eval in script-src
 * - Vue requires unsafe-inline in style-src
 * - font-src restricted to self
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TAURI_CONF_PATH = path.resolve(__dirname, '../../src-tauri/tauri.conf.json')

function parseCSP(csp: string): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const directive of csp.split(';')) {
    const trimmed = directive.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    const name = parts[0]!
    result[name] = parts.slice(1)
  }
  return result
}

describe('CSP security policy', () => {
  const confRaw = fs.readFileSync(TAURI_CONF_PATH, 'utf-8')
  const conf = JSON.parse(confRaw)
  const cspString: string = conf.app?.security?.csp ?? ''
  const csp = parseCSP(cspString)

  it('CSP string is not empty', () => {
    expect(cspString.length).toBeGreaterThan(0)
  })

  // ─── connect-src ────────────────────────────────────

  describe('connect-src', () => {
    const connectSrc = csp['connect-src'] ?? []

    it('includes http://localhost:16060 for API calls', () => {
      const hasExact = connectSrc.includes('http://localhost:16060')
      const hasWildcard = connectSrc.includes('http://localhost:*')
      expect(
        hasExact || hasWildcard,
        `connect-src must include http://localhost:16060 or http://localhost:*. Got: ${connectSrc.join(' ')}`,
      ).toBe(true)
    })

    it('includes ws://localhost:16060 for WebSocket connections', () => {
      const hasExact = connectSrc.includes('ws://localhost:16060')
      const hasWildcard = connectSrc.includes('ws://localhost:*')
      expect(
        hasExact || hasWildcard,
        `connect-src must include ws://localhost:16060 or ws://localhost:*. Got: ${connectSrc.join(' ')}`,
      ).toBe(true)
    })

    it('includes self', () => {
      expect(connectSrc).toContain("'self'")
    })
  })

  // ─── img-src ─────────────────────────────────────────

  describe('img-src', () => {
    const imgSrc = csp['img-src'] ?? []

    it('includes http://localhost:16060 for backend-served images', () => {
      const hasExact = imgSrc.includes('http://localhost:16060')
      const hasWildcard = imgSrc.includes('http://localhost:*')
      expect(
        hasExact || hasWildcard,
        `img-src must include localhost:16060. Got: ${imgSrc.join(' ')}`,
      ).toBe(true)
    })

    it('includes data: for inline images', () => {
      expect(imgSrc).toContain('data:')
    })

    it('includes blob: for generated images', () => {
      expect(imgSrc).toContain('blob:')
    })

    it('includes self', () => {
      expect(imgSrc).toContain("'self'")
    })
  })

  // ─── script-src ──────────────────────────────────────

  describe('script-src', () => {
    const scriptSrc = csp['script-src'] ?? []

    it('does NOT include unsafe-eval (security risk)', () => {
      expect(
        scriptSrc.includes("'unsafe-eval'"),
        `script-src should NOT contain 'unsafe-eval'. Got: ${scriptSrc.join(' ')}`,
      ).toBe(false)
    })

    it('includes self', () => {
      expect(scriptSrc).toContain("'self'")
    })
  })

  // ─── style-src ───────────────────────────────────────

  describe('style-src', () => {
    const styleSrc = csp['style-src'] ?? []

    it('includes unsafe-inline (required by Vue)', () => {
      expect(
        styleSrc.includes("'unsafe-inline'"),
        `style-src must include 'unsafe-inline' for Vue. Got: ${styleSrc.join(' ')}`,
      ).toBe(true)
    })

    it('includes self', () => {
      expect(styleSrc).toContain("'self'")
    })
  })

  // ─── font-src ────────────────────────────────────────

  describe('font-src', () => {
    const fontSrc = csp['font-src'] ?? []

    it('is self only (no external font loading)', () => {
      expect(fontSrc).toEqual(["'self'"])
    })
  })

  // ─── other security directives ───────────────────────

  describe('other security directives', () => {
    it('object-src is none', () => {
      const objectSrc = csp['object-src'] ?? []
      expect(objectSrc).toContain("'none'")
    })

    it('base-uri is self', () => {
      const baseUri = csp['base-uri'] ?? []
      expect(baseUri).toContain("'self'")
    })

    it('form-action is self', () => {
      const formAction = csp['form-action'] ?? []
      expect(formAction).toContain("'self'")
    })

    it('default-src is present', () => {
      expect(csp['default-src']).toBeDefined()
    })
  })

  // ─── no overly permissive wildcards ──────────────────

  describe('no overly permissive wildcards', () => {
    const allDirectives = Object.entries(csp)

    it('no directive uses bare * wildcard', () => {
      for (const [directive, values] of allDirectives) {
        expect(
          values.includes('*'),
          `${directive} contains bare * wildcard which is too permissive`,
        ).toBe(false)
      }
    })

    it('no directive allows http:// or https:// broadly (except media-src for video playback)', () => {
      // media-src 需要 https: 加载外部视频（视频生成模型返回 CDN URL）
      const exempted = new Set(['media-src'])
      for (const [directive, values] of allDirectives) {
        if (exempted.has(directive)) continue
        expect(
          values.includes('http:') || values.includes('https:'),
          `${directive} contains overly broad http:/https: source`,
        ).toBe(false)
      }
    })
  })
})
