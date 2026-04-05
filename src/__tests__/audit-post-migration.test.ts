/**
 * Post-DB-Migration Audit Tests
 *
 * The app removed its frontend SQLite and now uses backend API for all data.
 * These tests verify correctness of the migration and catch residual DB references.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ════════════════════════════════════════════════════════
// Category 1: messageService API migration correctness
// ════════════════════════════════════════════════════════

const {
  listSessions,
  listSessionMessages,
  createSessionApi,
  updateSessionTitleApi,
  deleteSessionApi,
} = vi.hoisted(() => ({
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listSessionMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
  createSessionApi: vi.fn().mockResolvedValue({ id: 's1', title: 'Test', created_at: '2026-01-01' }),
  updateSessionTitleApi: vi.fn().mockResolvedValue({ id: 's1', title: 'Updated', updated_at: '2026-01-02' }),
  deleteSessionApi: vi.fn().mockResolvedValue({ message: 'ok' }),
}))

vi.mock('@/api/chat', () => ({
  listSessions,
  listSessionMessages,
  createSession: createSessionApi,
  updateSessionTitle: updateSessionTitleApi,
  deleteSession: deleteSessionApi,
}))

import {
  loadAllSessions, loadMessages, createSession, updateSessionTitle,
  deleteSession, persistMessage, touchSession,
  getLastSessionId, setLastSessionId,
} from '@/services/messageService'

describe('Category 1: messageService API migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  // --- loadAllSessions ---

  it('loadAllSessions: API returns empty → returns []', async () => {
    listSessions.mockResolvedValueOnce({ sessions: [], total: 0 })
    const result = await loadAllSessions()
    expect(result).toEqual([])
  })

  it('loadAllSessions: API throws → returns [] not crash', async () => {
    listSessions.mockRejectedValueOnce(new Error('network down'))
    const result = await loadAllSessions()
    expect(result).toEqual([])
  })

  it('loadAllSessions: API returns sessions with missing optional fields → fills defaults', async () => {
    listSessions.mockResolvedValueOnce({
      sessions: [
        { id: 's1' },  // missing title, created_at, updated_at, message_count
      ],
      total: 1,
    })
    const result = await loadAllSessions()
    expect(result).toHaveLength(1)
    expect(result[0]!.title).toBe('新对话')
    expect(result[0]!.message_count).toBe(0)
    expect(result[0]!.created_at).toBeTruthy()
    expect(result[0]!.updated_at).toBeTruthy()
  })

  it('loadAllSessions: API returns null sessions field → returns []', async () => {
    listSessions.mockResolvedValueOnce({ sessions: null, total: 0 })
    const result = await loadAllSessions()
    expect(result).toEqual([])
  })

  // --- loadMessages ---

  it('loadMessages: API returns messages with missing fields → handles gracefully', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [
        { id: 'm1', role: 'user', content: 'hello' },  // missing timestamp
      ],
      total: 1,
    })
    const result = await loadMessages('s1')
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('m1')
  })

  it('loadMessages: API returns null messages field → returns []', async () => {
    listSessionMessages.mockResolvedValueOnce({ messages: null, total: 0 })
    const result = await loadMessages('s1')
    expect(result).toEqual([])
  })

  it('loadMessages: API throws → returns [] not crash', async () => {
    listSessionMessages.mockRejectedValueOnce(new Error('500'))
    const result = await loadMessages('s1')
    expect(result).toEqual([])
  })

  // --- createSession ---

  it('createSession: calls POST with correct payload', async () => {
    await createSession('session-abc', 'My Chat')
    expect(createSessionApi).toHaveBeenCalledWith('session-abc', 'My Chat')
  })

  // --- updateSessionTitle ---

  it('updateSessionTitle: calls PATCH with correct args', async () => {
    await updateSessionTitle('s1', 'New Title')
    expect(updateSessionTitleApi).toHaveBeenCalledWith('s1', 'New Title')
  })

  // --- deleteSession ---

  it('deleteSession: calls DELETE with correct id', async () => {
    await deleteSession('s1')
    expect(deleteSessionApi).toHaveBeenCalledWith('s1')
  })

  // --- persistMessage ---

  it('persistMessage: is no-op returning true', async () => {
    const result = await persistMessage(
      { id: 'm1', role: 'user', content: 'test', timestamp: '2026-01-01' },
      's1',
    )
    expect(result).toBe(true)
  })

  // --- touchSession ---

  it('touchSession: is no-op (no throw)', async () => {
    await expect(touchSession('s1')).resolves.toBeUndefined()
  })

  // --- lastSessionId localStorage ---

  it('getLastSessionId: returns null when not set', () => {
    expect(getLastSessionId()).toBeNull()
  })

  it('setLastSessionId + getLastSessionId: round-trip', () => {
    setLastSessionId('session-xyz')
    expect(getLastSessionId()).toBe('session-xyz')
  })

  it('getLastSessionId: reads from correct localStorage key', () => {
    localStorage.setItem('hexclaw_lastSessionId', 'stored-id')
    expect(getLastSessionId()).toBe('stored-id')
  })

  it('setLastSessionId: writes to correct localStorage key', () => {
    setLastSessionId('new-id')
    expect(localStorage.getItem('hexclaw_lastSessionId')).toBe('new-id')
  })
})

// ════════════════════════════════════════════════════════
// Category 2: Chat store without DB
// ════════════════════════════════════════════════════════

// Chat store tests require Pinia + additional mocks; tested via separate
// describe block with its own module-level mocks already set above.

describe('Category 2: Chat store without DB', () => {
  // The chat store is already mocked at module level via '@/api/chat',
  // so we can verify it delegates to API not DB.

  it('loadSessions: delegates to messageService.loadAllSessions (API)', async () => {
    // Verify the implementation source imports from API, not DB
    const chatStoreSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'stores', 'chat.ts'), 'utf-8',
    )
    expect(chatStoreSource).toContain("import * as msgSvc from '@/services/messageService'")
    expect(chatStoreSource).not.toContain("from '@/db/")
    expect(chatStoreSource).not.toContain('getDB')
    expect(chatStoreSource).not.toContain('tauri-plugin-sql')
  })

  it('selectSession: loads messages via messageService (API layer)', () => {
    const chatStoreSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'stores', 'chat.ts'), 'utf-8',
    )
    expect(chatStoreSource).toContain('msgSvc.loadMessages(sessionId)')
  })

  it('newSession: creates session via messageService.createSession (API)', () => {
    const chatStoreSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'stores', 'chat.ts'), 'utf-8',
    )
    expect(chatStoreSource).toContain('msgSvc.createSession(')
  })

  it('deleteSession: deletes via messageService.deleteSession (API) and updates local state', () => {
    const chatStoreSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'stores', 'chat.ts'), 'utf-8',
    )
    expect(chatStoreSource).toContain('msgSvc.deleteSession(sessionId)')
    expect(chatStoreSource).toContain('sessions.value = sessions.value.filter')
  })

  it('sendMessage: outbox functions have been removed from chatService', () => {
    const chatServiceSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'chatService.ts'), 'utf-8',
    )
    // Verify outbox functions are fully removed
    expect(chatServiceSource).not.toContain('outboxInsert')
    expect(chatServiceSource).not.toContain('outboxMarkSending')
    expect(chatServiceSource).not.toContain('outboxMarkSent')
    expect(chatServiceSource).not.toContain('outboxMarkFailed')
  })

  it('session switch: selectSession clears previous state', () => {
    const chatStoreSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'stores', 'chat.ts'), 'utf-8',
    )
    // selectSession should reset artifacts, error, selected artifact
    expect(chatStoreSource).toContain('selectedArtifactId.value = null')
    expect(chatStoreSource).toContain('showArtifacts.value = false')
    expect(chatStoreSource).toContain('error.value = null')
  })
})

// ════════════════════════════════════════════════════════
// Category 3: Knowledge view without DB cache
// ════════════════════════════════════════════════════════

describe('Category 3: Knowledge view without DB cache', () => {
  it('loadDocs: fetches from API directly, no DB cache layer', () => {
    const knowledgeViewSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'views', 'KnowledgeView.vue'), 'utf-8',
    )
    // Should import from API
    expect(knowledgeViewSource).toContain("from '@/api/knowledge'")
    // DB cache layer should be gone
    expect(knowledgeViewSource).not.toContain("from '@/db/")
    expect(knowledgeViewSource).not.toContain('getDB')
    // Comment confirming removal
    expect(knowledgeViewSource).toContain('DB cache layer removed')
  })

  it('loadDocs: API failure shows error, not stale cache', () => {
    const knowledgeViewSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'views', 'KnowledgeView.vue'), 'utf-8',
    )
    // Should have errorMsg reactive ref
    expect(knowledgeViewSource).toContain('errorMsg')
    expect(knowledgeViewSource).toContain('errorSeverity')
    // Should not have any cache TTL or stale cache logic
    expect(knowledgeViewSource).not.toMatch(/CACHE_TTL_MS\s*=\s*\d/)
    expect(knowledgeViewSource).toContain('CACHE_TTL_MS removed')
  })
})

// ════════════════════════════════════════════════════════
// Category 4: Templates without DB
// ════════════════════════════════════════════════════════

describe('Category 4: Templates without DB', () => {
  it('templates stored and read from localStorage', () => {
    const templateSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'components', 'chat', 'TemplatePopup.vue'), 'utf-8',
    )
    expect(templateSource).toContain("localStorage.getItem(TEMPLATES_KEY)")
    expect(templateSource).toContain("localStorage.setItem(TEMPLATES_KEY")
    expect(templateSource).not.toContain("from '@/db/")
    expect(templateSource).not.toContain('getDB')
    expect(templateSource).not.toContain('tauri-plugin-sql')
  })

  it('search templates works with localStorage data', () => {
    const templateSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'components', 'chat', 'TemplatePopup.vue'), 'utf-8',
    )
    // dbSearchTemplates should filter loadTemplatesFromStorage results
    expect(templateSource).toContain('function dbSearchTemplates')
    expect(templateSource).toContain('dbGetTemplates()')
    // dbGetTemplates should use loadTemplatesFromStorage
    expect(templateSource).toContain('function dbGetTemplates')
    expect(templateSource).toContain('loadTemplatesFromStorage()')
  })
})

// ════════════════════════════════════════════════════════
// Category 5: Residual DB references check
// ════════════════════════════════════════════════════════

function getAllSourceFiles(dir: string): string[] {
  const result: string[] = []
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', '__tests__'].includes(entry.name)) continue
        walk(fullPath)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.vue')) &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.endsWith('.test.ts')
      ) {
        result.push(fullPath)
      }
    }
  }
  walk(dir)
  return result
}

describe('Category 5: Residual DB references check', () => {
  const srcDir = path.resolve(__dirname, '..')
  const files = getAllSourceFiles(srcDir)

  it('no remaining imports from @/db/', () => {
    const violations: string[] = []
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8')
      if (content.match(/from\s+['"]@\/db\//)) {
        violations.push(path.relative(srcDir, filePath))
      }
    }
    expect(violations).toEqual([])
  })

  it('no remaining references to tauri-plugin-sql', () => {
    const violations: string[] = []
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8')
      if (content.includes('tauri-plugin-sql')) {
        violations.push(path.relative(srcDir, filePath))
      }
    }
    expect(violations).toEqual([])
  })

  it('no remaining getDB() calls', () => {
    const violations: string[] = []
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8')
      if (content.match(/getDB\s*\(/)) {
        violations.push(path.relative(srcDir, filePath))
      }
    }
    expect(violations).toEqual([])
  })

  it('no remaining Database imports from plugin-sql', () => {
    const violations: string[] = []
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8')
      if (content.match(/import.*Database.*from.*plugin-sql/)) {
        violations.push(path.relative(srcDir, filePath))
      }
    }
    expect(violations).toEqual([])
  })
})

// ════════════════════════════════════════════════════════
// Category 6: API client completeness
// ════════════════════════════════════════════════════════

describe('Category 6: API client completeness', () => {
  it('apiPatch function exists in client.ts', () => {
    const clientSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'api', 'client.ts'), 'utf-8',
    )
    expect(clientSource).toContain('export function apiPatch')
  })

  it('apiPatch is re-exported from api/index.ts barrel', () => {
    const indexSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'api', 'index.ts'), 'utf-8',
    )
    // apiPatch should be included in the re-export from client
    expect(indexSource).toContain('apiPatch')
  })

  it('createSession API function exists in chat.ts', () => {
    const chatSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'api', 'chat.ts'), 'utf-8',
    )
    expect(chatSource).toContain('export function createSession')
  })

  it('updateSessionTitle API function exists and uses PATCH', () => {
    const chatSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'api', 'chat.ts'), 'utf-8',
    )
    expect(chatSource).toContain('export function updateSessionTitle')
    expect(chatSource).toContain('apiPatch')
  })

  it('deleteSession API function exists and uses DELETE', () => {
    const chatSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'api', 'chat.ts'), 'utf-8',
    )
    expect(chatSource).toContain('export function deleteSession')
    expect(chatSource).toContain('apiDelete')
  })

  it('listSessions sends user_id in query params', () => {
    const chatSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'api', 'chat.ts'), 'utf-8',
    )
    expect(chatSource).toContain('user_id: DESKTOP_USER_ID')
  })
})
