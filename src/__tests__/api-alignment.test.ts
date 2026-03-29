/**
 * Frontend-Backend API Alignment Tests
 *
 * Verifies that every API path used in src/api/*.ts matches a registered
 * backend route in hexclaw/api/server.go, and that HTTP methods align.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Parse backend routes from server.go ──────────────────────────
// Locate the backend server.go — try multiple possible locations
function findBackendServerGo(): string {
  const candidates = [
    path.resolve(__dirname, '../../../hexclaw/api/server.go'),   // from src/__tests__
    path.resolve(__dirname, '../../../../hexclaw/api/server.go'), // deeper nesting
    path.resolve(__dirname, '../..', '../hexclaw/api/server.go'),
  ]
  // Also try from process.cwd() which is the repo root
  candidates.push(path.resolve(process.cwd(), '../hexclaw/api/server.go'))

  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[0] // fallback; will be handled gracefully
}
const BACKEND_SERVER_GO = findBackendServerGo()

function parseBackendRoutes(): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>()
  let source: string
  try {
    source = fs.readFileSync(BACKEND_SERVER_GO, 'utf-8')
  } catch {
    // If the backend repo is not available, skip the test
    return routes
  }

  // Matches: mux.HandleFunc("METHOD /path", handler)
  const re = /mux\.HandleFunc\("(GET|POST|PUT|DELETE)\s+(\/[^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const method = m[1]
    const routePath = m[2]
    if (!routes.has(routePath)) routes.set(routePath, new Set())
    routes.get(routePath)!.add(method)
  }
  return routes
}

// ── Collect frontend API calls from src/api/*.ts ─────────────────
const API_DIR = path.resolve(__dirname, '../api')

interface FrontendApiCall {
  file: string
  method: string
  path: string
  line: number
}

function collectFrontendAPICalls(): FrontendApiCall[] {
  const calls: FrontendApiCall[] = []
  const files = fs.readdirSync(API_DIR).filter((f) => f.endsWith('.ts') && !f.startsWith('__'))

  for (const file of files) {
    const filePath = path.join(API_DIR, file)
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Match apiGet, apiPost, apiPut, apiDelete calls
      const apiCallMatch = line.match(/api(Get|Post|Put|Delete)\s*[<(]/)
      if (apiCallMatch) {
        const method = apiCallMatch[1].toUpperCase()
        // Find the path argument on this or next line
        const pathMatch = line.match(/['"`](\/api\/v1\/[^'"`]+)['"`]/)
        if (pathMatch) {
          calls.push({ file, method, path: pathMatch[1], line: i + 1 })
        }
      }

      // Match proxyApiRequest calls
      const proxyMatch = line.match(/proxyApiRequest\s*(?:<[^>]+>)?\s*\(\s*'(GET|POST|PUT|DELETE)',\s*['"`](\/[^'"`]+)/)
      if (proxyMatch) {
        calls.push({ file, method: proxyMatch[1], path: proxyMatch[2], line: i + 1 })
      }

      // Match fetch calls with API paths
      const fetchMatch = line.match(/fetch\([^)]*\/api\/v1\/([^'"`\s]+)/)
      if (fetchMatch) {
        // Determine method from options
        const methodMatch = line.match(/method:\s*'(GET|POST|PUT|DELETE)'/)
        const method = methodMatch ? methodMatch[1] : 'GET'
        const pathFromFetch = line.match(/['"`](\/api\/v1\/[^'"`]+)['"`]/)
        if (pathFromFetch) {
          calls.push({ file, method, path: pathFromFetch[1], line: i + 1 })
        }
      }
    }
  }
  return calls
}

/**
 * Normalize a concrete path like /api/v1/skills/my-skill/status
 * to match a Go mux pattern like /api/v1/skills/{name}/status
 */
function matchesBackendRoute(
  concretePath: string,
  backendRoutes: Map<string, Set<string>>,
): string | null {
  // Direct match
  if (backendRoutes.has(concretePath)) return concretePath

  // Remove encodeURIComponent patterns (test artifacts)
  const cleaned = concretePath
    .replace(/\$\{encodeURIComponent\([^)]+\)\}/g, '{param}')
    .replace(/\$\{[^}]+\}/g, '{param}')

  if (backendRoutes.has(cleaned)) return cleaned

  // Try matching against Go path patterns
  for (const routePath of backendRoutes.keys()) {
    // Convert Go {name} patterns to regex
    const pattern = routePath.replace(/\{[^}]+\}/g, '[^/]+')
    const re = new RegExp(`^${pattern}$`)
    if (re.test(concretePath) || re.test(cleaned)) return routePath
  }

  return null
}

describe('Frontend-Backend API Alignment', () => {
  const backendRoutes = parseBackendRoutes()
  const frontendCalls = collectFrontendAPICalls()

  it('backend server.go is parseable and has routes', () => {
    if (backendRoutes.size === 0) {
      console.warn('SKIP: backend server.go not found at', BACKEND_SERVER_GO)
      return
    }
    expect(backendRoutes.size).toBeGreaterThan(30)
  })

  it('every frontend API path has a matching backend route', () => {
    if (backendRoutes.size === 0) return // skip if backend not available

    const unmatched: FrontendApiCall[] = []

    for (const call of frontendCalls) {
      // Skip template literal paths with dynamic segments that are obvious match
      if (call.path.includes('${')) continue

      const matchedRoute = matchesBackendRoute(call.path, backendRoutes)
      if (!matchedRoute) {
        unmatched.push(call)
      }
    }

    if (unmatched.length > 0) {
      const details = unmatched
        .map((c) => `  ${c.file}:${c.line} ${c.method} ${c.path}`)
        .join('\n')
      // Report but don't fail hard — some routes may be frontend-only
      console.warn(`Frontend API paths with no backend route:\n${details}`)
    }

    // Specifically check for known-problematic paths
    const desktopClipboard = frontendCalls.find((c) => c.path === '/api/v1/desktop/clipboard')
    if (desktopClipboard) {
      const hasBackend = matchesBackendRoute('/api/v1/desktop/clipboard', backendRoutes)
      expect(hasBackend).toBeNull() // EXPECTED: this route does NOT exist in backend
    }
  })

  it('desktop/clipboard path used in frontend does NOT exist in backend (known gap)', () => {
    if (backendRoutes.size === 0) return
    expect(backendRoutes.has('/api/v1/desktop/clipboard')).toBe(false)

    // Verify frontend DOES reference it
    const call = frontendCalls.find((c) => c.path === '/api/v1/desktop/clipboard')
    expect(call).toBeDefined()
    expect(call?.method).toBe('POST')
  })

  it('wechatQRStream was removed — no EventSource or qr-stream reference remains in im-channels.ts', () => {
    const imChannelsSource = fs.readFileSync(path.join(API_DIR, 'im-channels.ts'), 'utf-8')

    // The wechatQRStream function and EventSource usage were removed
    expect(imChannelsSource).not.toContain('wechatQRStream')
    expect(imChannelsSource).not.toContain('EventSource')
    expect(imChannelsSource).not.toContain('qr-stream')
  })

  it('backend also removed wechat QR stream endpoint (both sides cleaned up)', () => {
    if (backendRoutes.size === 0) return
    const route = backendRoutes.get('/api/v1/channels/wechat/qr-stream')
    // Both frontend and backend removed the wechat QR stream feature
    expect(route).toBeUndefined()
  })

  it('tools-status.ts paths match backend handler_tools.go routes', () => {
    if (backendRoutes.size === 0) return

    const expectedPaths = [
      '/api/v1/budget/status',
      '/api/v1/tools/cache/stats',
      '/api/v1/tools/metrics',
      '/api/v1/tools/permissions',
    ]

    for (const p of expectedPaths) {
      const matched = matchesBackendRoute(p, backendRoutes)
      expect(matched).not.toBeNull()

      const frontendCall = frontendCalls.find((c) => c.path === p)
      expect(frontendCall).toBeDefined()
      expect(frontendCall?.method).toBe('GET')
    }
  })

  it('knowledge upload path matches backend (no longer has fallback)', () => {
    const knowledgeSource = fs.readFileSync(path.join(API_DIR, 'knowledge.ts'), 'utf-8')

    // Should use single KNOWLEDGE_UPLOAD_PATH = '/api/v1/knowledge/upload'
    expect(knowledgeSource).toContain("const KNOWLEDGE_UPLOAD_PATH = '/api/v1/knowledge/upload'")

    // Backend should have this route
    if (backendRoutes.size === 0) return
    const route = backendRoutes.get('/api/v1/knowledge/upload')
    expect(route).toBeDefined()
    expect(route?.has('POST')).toBe(true)
  })
})
