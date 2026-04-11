/**
 * Audit: Performance, Security, Dead/Redundant Code
 *
 * Static analysis tests to catch real issues:
 *   - Orphaned components never imported in production code
 *   - Duplicate API exports
 *   - Dead outbox functions still referenced
 *   - Debug console.log left in production components
 *   - Unused API functions exported but never imported
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, extname } from 'node:path'

const SRC = resolve(__dirname, '..')

function readSrc(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf-8')
}

/** Recursively list files matching extensions, excluding test dirs */
function walkDir(dir: string, exts: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (entry === '__tests__' || entry === 'node_modules' || entry === '__benchmarks__') continue
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...walkDir(full, exts))
    } else if (exts.includes(extname(full))) {
      results.push(full)
    }
  }
  return results
}

function prodFiles(): string[] {
  return walkDir(SRC, ['.ts', '.vue'])
}

// ─── Orphaned Components (cleaned up) ──────────────────────────

describe('Dead code: orphaned components have been removed', () => {
  const removedComponents = [
    'components/agent/AgentCard.vue',
    'components/agent/AgentForm.vue',
    'components/agent/AgentStatus.vue',
    'components/common/ErrorState.vue',
    'components/common/StatusBadge.vue',
    'components/layout/ContextBar.vue',
    'components/logs/LogFilter.vue',
    'components/chat/ToolCallBubble.vue',
  ]

  for (const compPath of removedComponents) {
    it(`${compPath} has been deleted`, () => {
      const compFull = resolve(SRC, compPath)
      expect(() => statSync(compFull)).toThrow()
    })
  }
})

// ─── Duplicate API exports ────────────────────────────────

describe('Dead code: duplicate updateMessageFeedback resolved', () => {
  it('api/messages.ts has been deleted, updateMessageFeedback lives only in chat.ts', () => {
    const chatApi = readSrc('api/chat.ts')
    expect(chatApi).toContain('export function updateMessageFeedback')

    // api/messages.ts no longer exists
    expect(() => readSrc('api/messages.ts')).toThrow()
  })
})

// ─── Dead outbox functions ────────────────────────────────

describe('Dead code: outbox no-op functions removed', () => {
  it('chatService.ts no longer contains outbox functions', () => {
    const svc = readSrc('services/chatService.ts')

    const outboxFns = [
      'outboxInsert',
      'outboxMarkSending',
      'outboxMarkSent',
      'outboxMarkFailed',
      'retryPendingOutbox',
      'cleanupOutbox',
    ]

    for (const fn of outboxFns) {
      expect(svc).not.toContain(fn)
    }
  })
})

// ─── Unused API exports ──────────────────────────────────

describe('Dead code: unused API exports', () => {
  const unusedApis: Array<{ file: string; fn: string }> = [
    { file: 'api/models.ts', fn: 'listModels' },
    { file: 'api/webhook.ts', fn: 'registerWebhook' },
  ]

  const files = prodFiles()

  for (const { file, fn } of unusedApis) {
    it(`${fn} in ${file} is exported but never imported in production code`, () => {
      const targetFull = resolve(SRC, file)
      const importers = files.filter((f) => {
        if (f === targetFull) return false
        const content = readFileSync(f, 'utf-8')
        // Must contain an actual import of the function, not just re-export
        return (
          content.includes(fn) &&
          content.includes('import') &&
          !content.includes(`export * from`)
        )
      })

      expect(importers).toEqual([])
    })
  }
})

// ─── Debug console.log in production components ───────────

describe('Code quality: debug console.log in components', () => {
  it('OllamaCard.vue console.log statements are Ollama warmup debug logs only', () => {
    const code = readSrc('components/settings/OllamaCard.vue')
    const logLines = code.split('\n').filter(l => /console\.log\s*\(/.test(l) && !l.trim().startsWith('//'))
    // All remaining console.log should be Ollama warmup related
    for (const line of logLines) {
      expect(line).toContain('[OllamaCard]')
    }
  })
})

// ─── MarkdownRenderer module-level shared state ───────────

describe('Performance: MarkdownRenderer module-level cache', () => {
  it('highlightCache is module-level (shared across all instances) with LRU eviction', () => {
    const code = readSrc('components/chat/MarkdownRenderer.vue')

    expect(code).toContain('const HIGHLIGHT_CACHE_MAX = 200')
    expect(code).toContain('const highlightCache = new Map')
    expect(code).toContain('highlightCacheSet')
  })

  it('activeInstanceCount reference counting manages the click listener', () => {
    const code = readSrc('components/chat/MarkdownRenderer.vue')

    expect(code).toContain('let activeInstanceCount = 0')
    expect(code).toContain('activeInstanceCount++')
    expect(code).toContain('activeInstanceCount--')
  })
})

// ─── Security: v-html sanitization ───────────────────────

describe('Security: v-html is sanitized', () => {
  it('MarkdownRenderer sanitizes with DOMPurify before v-html', () => {
    const code = readSrc('components/chat/MarkdownRenderer.vue')
    expect(code).toContain('DOMPurify.sanitize')
    expect(code).toContain('v-html="rendered"')
  })

  it('ArtifactCodeView sanitizes with DOMPurify before v-html', () => {
    const code = readSrc('components/artifacts/ArtifactCodeView.vue')
    expect(code).toContain('DOMPurify.sanitize')
    expect(code).toContain('v-html="codeHtml"')
  })

  it('MarkdownIt has html: false to prevent raw HTML injection', () => {
    const code = readSrc('components/chat/MarkdownRenderer.vue')
    expect(code).toContain('html: false')
  })
})

// ─── Security: secure-store hardcoded passphrase ──────────

describe('Security: secure-store browser fallback', () => {
  it('fails closed in browser mode instead of persisting secrets to localStorage', () => {
    const code = readSrc('utils/secure-store.ts')
    expect(code).toContain('volatileBrowserStore')
    expect(code).not.toContain("enc.encode('hexclaw-desktop')")
    expect(code).not.toContain('DEVICE_SALT_KEY')
  })
})

// ─── Performance: event listener cleanup ──────────────────

describe('Performance: event listener cleanup', () => {
  const viewsWithListeners: Array<{ file: string; addPattern: string; removePattern: string }> = [
    {
      file: 'views/ChatView.vue',
      addPattern: "document.addEventListener('keydown', handleSearchShortcut)",
      removePattern: "document.removeEventListener('keydown', handleSearchShortcut)",
    },
    {
      file: 'views/KnowledgeView.vue',
      addPattern: "document.addEventListener('dragover', preventDefaultDrag)",
      removePattern: "document.removeEventListener('dragover', preventDefaultDrag)",
    },
    {
      file: 'composables/useShortcuts.ts',
      addPattern: "window.addEventListener('keydown', handleKeydown)",
      removePattern: "window.removeEventListener('keydown', handleKeydown)",
    },
  ]

  for (const { file, addPattern, removePattern } of viewsWithListeners) {
    it(`${file} cleans up event listeners`, () => {
      const code = readSrc(file)
      expect(code).toContain(addPattern)
      expect(code).toContain(removePattern)
    })
  }
})

// ─── Performance: timer cleanup ───────────────────────────

describe('Performance: timer cleanup on unmount', () => {
  it('DashboardView clears both intervals on unmount', () => {
    const code = readSrc('views/DashboardView.vue')
    expect(code).toContain('onUnmounted(() => stopAutoRefresh())')
    expect(code).toContain('clearInterval(refreshTimer)')
    expect(code).toContain('clearInterval(countdownTimer)')
  })

  it('OllamaCard clears poll timer and aborts pull on unmount', () => {
    const code = readSrc('components/settings/OllamaCard.vue')
    expect(code).toContain('onBeforeUnmount')
    expect(code).toContain('clearPollTimer()')
    expect(code).toContain('pullAbort.abort()')
  })

  it('useHexclaw clears interval on unmount', () => {
    const code = readSrc('composables/useHexclaw.ts')
    expect(code).toContain('onUnmounted(() => stopMonitor())')
    expect(code).toContain('clearInterval(timer)')
  })

  it('useWebSocket disconnects on unmount', () => {
    const code = readSrc('composables/useWebSocket.ts')
    expect(code).toContain('onUnmounted(() => disconnect())')
    expect(code).toContain('clearTimeout(reconnectTimer)')
  })
})

// ─── Redundant hexclaw.db reference ───────────────────────

describe('Potential dead references', () => {
  it('SettingsView still references data.db filename (display only, not a real DB call)', () => {
    const code = readSrc('views/SettingsView.vue')
    expect(code).toContain("runtimeLocalStoreFile = 'data.db'")
  })
})

// ─── main.ts global listeners ─────────────────────────────

describe('Performance: main.ts global listeners', () => {
  it('main.ts adds two global listeners without cleanup (acceptable for app lifecycle)', () => {
    const code = readSrc('main.ts')
    expect(code).toContain("window.addEventListener('unhandledrejection'")
    expect(code).toContain("document.addEventListener('click'")
    expect(code).not.toContain('removeEventListener')
  })
})

// ─── useAutoStart never used in UI ────────────────────────

describe('Dead code: useAutoStart composable', () => {
  it('is no longer exported from composables/index.ts', () => {
    const content = readSrc('composables/index.ts')
    expect(content).not.toContain('useAutoStart')
  })
})
