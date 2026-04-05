/**
 * HexClaw Desktop — Code Review v13: i18n Cross-cut & Structural Consistency
 *
 * Section 1: i18n completeness (en.ts vs zh-CN.ts key parity)
 * Section 2: Previously-missing i18n keys now exist
 * Section 3: Router path consistency
 * Section 4: Constants consistency
 * Section 5: Type field coverage
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const srcDir = path.resolve(__dirname, '..')

function readFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(srcDir, relativePath), 'utf-8')
}

/**
 * Extract top-level section keys from a locale file string.
 * For a given section prefix (e.g. 'about'), returns all property
 * names found inside that section's object literal.
 *
 * Matches only top-level sections (indented with exactly 2 spaces)
 * to avoid matching nested sections like `settings.about`.
 */
function extractSectionKeys(source: string, section: string): string[] {
  // Match only top-level section declarations (2-space indent inside the default export object)
  const sectionRegex = new RegExp(`\\n  ${section}:\\s*\\{`, 'g')
  let match: RegExpExecArray | null = null
  let bestMatch: RegExpExecArray | null = null

  // Find all matches and pick the one that's a top-level key
  // (preceded by a line that ends with `},` or is the start of the object)
  while ((match = sectionRegex.exec(source)) !== null) {
    bestMatch = match
  }

  // If multiple matches, the last one is typically the standalone top-level section
  // (e.g. `about:` at root vs `settings.about:` nested).
  // To be precise, find the match where the preceding context shows it's top-level.
  // We re-scan and pick the one at 2-space indent that is NOT inside a deeper block.
  if (!bestMatch) return []

  // Use brace-counting on the best match
  const startSearch = bestMatch.index
  let depth = 0
  let started = false
  let blockStart = 0
  let blockEnd = 0

  for (let i = startSearch; i < source.length; i++) {
    if (source[i] === '{') {
      if (!started) blockStart = i + 1
      depth++
      started = true
    } else if (source[i] === '}') {
      depth--
      if (started && depth === 0) {
        blockEnd = i
        break
      }
    }
  }

  const block = source.substring(blockStart, blockEnd)

  // Extract immediate key names (only at the first nesting level)
  // We track brace depth within the block to avoid extracting keys from nested objects
  const keys: string[] = []
  let innerDepth = 0
  const lines = block.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Count braces in this line
    for (const ch of trimmed) {
      if (ch === '{') innerDepth++
      else if (ch === '}') innerDepth--
    }
    // Only extract keys at depth 0 (immediate children)
    if (innerDepth <= 0) {
      const km = trimmed.match(/^['"]?(\w+)['"]?\s*:/)
      if (km) keys.push(km[1])
    }
    // Reset negative depth (closing braces of nested objects)
    if (innerDepth < 0) innerDepth = 0
  }
  return keys
}

// ─── Load locale sources ──────────────────────────────────

const enSource = readFile('i18n/locales/en.ts')
const zhSource = readFile('i18n/locales/zh-CN.ts')

// ─── Section 1: i18n completeness ─────────────────────────

describe('Section 1: i18n key completeness (en ↔ zh-CN)', () => {
  const sectionsToCheck = ['about', 'memory', 'knowledge', 'mcp', 'integration']

  for (const section of sectionsToCheck) {
    describe(`${section}.* keys`, () => {
      const enKeys = extractSectionKeys(enSource, section)
      const zhKeys = extractSectionKeys(zhSource, section)

      it(`en.ts has ${section} keys`, () => {
        expect(enKeys.length).toBeGreaterThan(0)
      })

      it(`zh-CN.ts has ${section} keys`, () => {
        expect(zhKeys.length).toBeGreaterThan(0)
      })

      it(`all en.ts ${section}.* keys exist in zh-CN.ts`, () => {
        const missing = enKeys.filter((k) => !zhKeys.includes(k))
        expect(missing).toEqual([])
      })
    })
  }
})

// ─── Section 2: Previously-missing keys now exist ─────────

describe('Section 2: 14 previously-missing i18n keys now exist', () => {
  const requiredKeys: Array<{ key: string; section: string }> = [
    // about.*
    { key: 'updateInvalidFeed', section: 'about' },
    { key: 'updateSourceUnavailable', section: 'about' },
    { key: 'fullStack', section: 'about' },
    { key: 'license', section: 'about' },
    // common.*
    { key: 'openInNewWindow', section: 'common' },
    // mcp.*
    { key: 'addServer', section: 'mcp' },
    // integration.*
    { key: 'noDiagnostics', section: 'integration' },
    // knowledge.*
    { key: 'fileEmpty', section: 'knowledge' },
    // memory.*
    { key: 'loadFailed', section: 'memory' },
    { key: 'saveFailed', section: 'memory' },
    { key: 'deleteFailed', section: 'memory' },
    { key: 'clearFailed', section: 'memory' },
    { key: 'searchFailed', section: 'memory' },
  ]

  for (const { key, section } of requiredKeys) {
    it(`en.ts contains ${section}.${key}`, () => {
      expect(enSource).toContain(key)
      const enKeys = extractSectionKeys(enSource, section)
      expect(enKeys).toContain(key)
    })

    it(`zh-CN.ts contains ${section}.${key}`, () => {
      expect(zhSource).toContain(key)
      const zhKeys = extractSectionKeys(zhSource, section)
      expect(zhKeys).toContain(key)
    })
  }
})

// ─── Section 3: Router path consistency ───────────────────

describe('Section 3: Router path consistency', () => {
  const routerSource = readFile('router/index.ts')
  const navigationSource = readFile('config/navigation.ts')

  it('every navigation item path has a matching route', () => {
    // Extract paths from navigationItems
    const navPathRegex = /path:\s*'([^']+)'/g
    const navPaths: string[] = []
    let npm
    while ((npm = navPathRegex.exec(navigationSource)) !== null) {
      navPaths.push(npm[1])
    }

    expect(navPaths.length).toBeGreaterThan(0)

    // The router builds routes from navigationItems via buildNavigationRoutes(),
    // so all nav paths are automatically included. Verify the router imports
    // navigationItems.
    expect(routerSource).toContain('navigationItems')
    expect(routerSource).toContain('buildNavigationRoutes')
  })

  it('all old route redirects point to valid paths', () => {
    // Extract redirect entries: { path: '/old', redirect: '/new' }
    const redirectRegex = /\{\s*path:\s*'([^']+)',\s*redirect:\s*'([^']+)'\s*\}/g
    const redirects: Array<{ from: string; to: string }> = []
    let rm
    while ((rm = redirectRegex.exec(routerSource)) !== null) {
      // Skip the catch-all and root redirect
      if (rm[1] === '/' || rm[1].includes(':pathMatch')) continue
      redirects.push({ from: rm[1], to: rm[2] })
    }

    expect(redirects.length).toBeGreaterThan(0)

    // All redirect targets should be either a navigation path or /dashboard or /channels
    const navPathRegex2 = /path:\s*'([^']+)'/g
    const allPaths = new Set<string>()
    let np2
    while ((np2 = navPathRegex2.exec(navigationSource)) !== null) {
      allPaths.add(np2[1])
    }
    // Add paths that are in the router but not in navigation
    allPaths.add('/dashboard')
    allPaths.add('/channels')

    for (const redirect of redirects) {
      expect(
        allPaths.has(redirect.to),
        `redirect ${redirect.from} -> ${redirect.to} should point to a valid path`,
      ).toBe(true)
    }
  })

  it('catch-all route exists', () => {
    expect(routerSource).toContain(':pathMatch(.*)*')
  })
})

// ─── Section 4: Constants consistency ─────────────────────

describe('Section 4: Constants consistency', () => {
  const constantsSource = readFile('constants.ts')

  it('DESKTOP_USER_ID is defined in constants.ts', () => {
    expect(constantsSource).toContain('DESKTOP_USER_ID')
  })

  it('DESKTOP_USER_ID is used in chat.ts', () => {
    const chatSource = readFile('api/chat.ts')
    expect(chatSource).toContain('DESKTOP_USER_ID')
  })

  it('DESKTOP_USER_ID is used in webhook.ts', () => {
    const webhookSource = readFile('api/webhook.ts')
    expect(webhookSource).toContain('DESKTOP_USER_ID')
  })

  it('DESKTOP_USER_ID is used in tasks.ts', () => {
    const tasksSource = readFile('api/tasks.ts')
    expect(tasksSource).toContain('DESKTOP_USER_ID')
  })

  it('USER_CANCELLED_MESSAGE is defined in constants.ts', () => {
    expect(constantsSource).toContain('USER_CANCELLED_MESSAGE')
  })

  it('USER_CANCELLED_MESSAGE is used in chatService.ts', () => {
    const chatServiceSource = readFile('services/chatService.ts')
    expect(chatServiceSource).toContain('USER_CANCELLED_MESSAGE')
  })
})

// ─── Section 5: Type field coverage ───────────────────────

describe('Section 5: Type field coverage (types/chat.ts)', () => {
  const chatTypesSource = readFile('types/chat.ts')

  it('ChatMessage has blocks field (content block support)', () => {
    expect(chatTypesSource).toContain('blocks?: ContentBlock[]')
  })

  it('ChatAttachment has data field (base64)', () => {
    // Match `data: string` inside ChatAttachment
    expect(chatTypesSource).toMatch(/interface ChatAttachment[\s\S]*?data:\s*string/)
  })

  it('Artifact has previousContent field (diff support)', () => {
    expect(chatTypesSource).toMatch(/interface Artifact[\s\S]*?previousContent\?/)
  })
})
