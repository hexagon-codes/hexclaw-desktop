/**
 * Code Review v12 — View Layer Audit Verification Tests
 *
 * Static analysis tests verifying bugs found in the view layer audit.
 * Uses readFileSync to check source patterns.
 *
 * FIXED issues (assert correct state):
 *   1. ChatView loadSessions race condition — await added
 *   2. TeamView i18n destructuring — { t } = useI18n()
 *   3. TasksView delete confirmation — confirm(t('tasks.confirmDelete'...))
 *   4. KnowledgeView upload index corruption — uses entry.progress instead of uploadingFiles.value[idx]
 *   5. IMChannelsView deleteIMInstance 404 handling — try/catch around deleteBackendInstance
 *
 * DOCUMENTED issues (assert current state):
 *   6. TeamView hardcoded Chinese strings in template
 *   7. TasksView missing error toast (console.error only) in handleDelete/handlePauseResume
 *   8. ChatView single-file drop — handleDrop uses files?.[0]
 *   9. im-channels.ts createIMInstance ghost instance risk — syncBackendInstance before writeInstances
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = resolve(__dirname, '..')
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), 'utf-8')
}

// ════════════════════════════════════════════════════════════
// Issue 1 (FIXED): ChatView loadSessions race condition
// ════════════════════════════════════════════════════════════

describe('Issue 1: ChatView loadSessions must be awaited', () => {
  const src = readSrc('views/ChatView.vue')

  it('contains "await chatStore.loadSessions()" in onMounted', () => {
    expect(src).toContain('await chatStore.loadSessions()')
  })

  it('onMounted callback is async', () => {
    // The onMounted must receive an async function so await works
    expect(src).toMatch(/onMounted\s*\(\s*async\s*\(/)
  })

  it('loadSessions is called before session-dependent logic', () => {
    const mountedStart = src.indexOf('onMounted(async')
    const awaitLoad = src.indexOf('await chatStore.loadSessions()', mountedStart)
    const roleQuery = src.indexOf('route.query.role', mountedStart)
    // await loadSessions must come before route.query.role usage
    expect(awaitLoad).toBeGreaterThan(0)
    expect(roleQuery).toBeGreaterThan(awaitLoad)
  })
})

// ════════════════════════════════════════════════════════════
// Issue 2 (FIXED): TeamView i18n destructuring
// ════════════════════════════════════════════════════════════

describe('Issue 2: TeamView i18n destructuring', () => {
  const src = readSrc('views/TeamView.vue')

  it('destructures { t } from useI18n()', () => {
    expect(src).toMatch(/const\s*\{\s*t\s*\}\s*=\s*useI18n\(\)/)
  })

  it('imports useI18n from vue-i18n', () => {
    expect(src).toContain("import { useI18n } from 'vue-i18n'")
  })
})

// ════════════════════════════════════════════════════════════
// Issue 3 (FIXED): TasksView delete confirmation
// ════════════════════════════════════════════════════════════

describe('Issue 3: TasksView delete confirmation with i18n', () => {
  const src = readSrc('views/TasksView.vue')

  it('handleDelete calls confirm() with t("tasks.confirmDelete")', () => {
    const handleDeleteBlock = src.slice(
      src.indexOf('async function handleDelete'),
      src.indexOf('async function handleDelete') + 400,
    )
    expect(handleDeleteBlock).toMatch(/confirm\s*\(\s*t\(\s*['"]tasks\.confirmDelete['"]/)
  })

  it('confirm() is called before deleteCronJob', () => {
    const handleDeleteStart = src.indexOf('async function handleDelete')
    const confirmIdx = src.indexOf('confirm(t(', handleDeleteStart)
    const deleteIdx = src.indexOf('deleteCronJob', handleDeleteStart)
    expect(confirmIdx).toBeGreaterThan(0)
    expect(deleteIdx).toBeGreaterThan(confirmIdx)
  })

  it('en.ts has tasks.confirmDelete key', () => {
    const en = readSrc('i18n/locales/en.ts')
    expect(en).toMatch(/confirmDelete\s*:\s*['"].*\{name\}/)
  })

  it('zh-CN.ts has tasks.confirmDelete key', () => {
    const zhCN = readSrc('i18n/locales/zh-CN.ts')
    expect(zhCN).toMatch(/confirmDelete\s*:\s*['"].*\{name\}/)
  })
})

// ════════════════════════════════════════════════════════════
// Issue 4 (FIXED): KnowledgeView upload index corruption
// ════════════════════════════════════════════════════════════

describe('Issue 4: KnowledgeView upload uses entry reference, not index', () => {
  const src = readSrc('views/KnowledgeView.vue')

  it('does NOT use uploadingFiles.value[idx] pattern for progress updates', () => {
    // The buggy pattern was: uploadingFiles.value[idx].progress = pct
    expect(src).not.toMatch(/uploadingFiles\.value\[\s*idx\s*\]/)
  })

  it('uses entry.progress = pct for progress updates', () => {
    expect(src).toContain('entry.progress = pct')
  })

  it('uses entry.status = "done" for completion', () => {
    expect(src).toContain("entry.status = 'done'")
  })

  it('uses entry.status = "error" for failure', () => {
    expect(src).toContain("entry.status = 'error'")
  })

  it('entry is a direct object reference pushed into the array', () => {
    // The entry object must be created and pushed to uploadingFiles.value
    // so that mutations to entry reflect in the reactive array
    expect(src).toMatch(/const\s+entry[\s\S]{0,200}uploadingFiles\.value\.push\(entry\)/)
  })
})

// ════════════════════════════════════════════════════════════
// Issue 5 (FIXED): deleteIMInstance 404 handling
// ════════════════════════════════════════════════════════════

describe('Issue 5: deleteIMInstance wraps deleteBackendInstance in try/catch', () => {
  const src = readSrc('api/im-channels.ts')

  it('deleteIMInstance function exists', () => {
    expect(src).toMatch(/export\s+async\s+function\s+deleteIMInstance/)
  })

  it('wraps deleteBackendInstance call in try/catch', () => {
    const fnStart = src.indexOf('export async function deleteIMInstance')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).toContain('try')
    expect(fnBody).toContain('deleteBackendInstance')
    expect(fnBody).toMatch(/catch/)
  })

  it('still deletes the local record even if backend delete fails', () => {
    const fnStart = src.indexOf('export async function deleteIMInstance')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    const catchIdx = fnBody.indexOf('catch')
    const deleteAllIdx = fnBody.indexOf('delete all[id]')
    // local cleanup happens after the try/catch block
    expect(deleteAllIdx).toBeGreaterThan(catchIdx)
  })
})

// ════════════════════════════════════════════════════════════
// Issue 6 (DOCUMENTED): TeamView hardcoded Chinese strings
// ════════════════════════════════════════════════════════════

describe('Issue 6: TeamView still has hardcoded Chinese in template', () => {
  const src = readSrc('views/TeamView.vue')
  const templateStart = src.indexOf('<template>')
  const template = src.slice(templateStart)

  it('PageHeader title contains hardcoded Chinese "团队协作"', () => {
    expect(template).toContain('团队协作')
  })

  it('PageHeader description contains hardcoded Chinese "共享智能体"', () => {
    expect(template).toContain('共享智能体')
  })

  it('tab buttons contain hardcoded Chinese strings', () => {
    expect(template).toContain('共享智能体')
    expect(template).toContain('团队成员')
    expect(template).toContain('导入/导出')
  })

  it('invite button has hardcoded "邀请成员"', () => {
    expect(template).toContain('邀请成员')
  })
})

// ════════════════════════════════════════════════════════════
// Issue 7 (DOCUMENTED): TasksView missing error toast
// ════════════════════════════════════════════════════════════

describe('Issue 7: TasksView handleDelete/handlePauseResume use console.error, not toast', () => {
  const src = readSrc('views/TasksView.vue')

  it('handleDelete error handler uses console.error', () => {
    const fnStart = src.indexOf('async function handleDelete')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).toContain('console.error')
  })

  it('handleDelete does NOT use toast.error', () => {
    const fnStart = src.indexOf('async function handleDelete')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).not.toContain('toast.error')
  })

  it('handlePauseResume error handler uses console.error', () => {
    const fnStart = src.indexOf('async function handlePauseResume')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).toContain('console.error')
  })

  it('handlePauseResume does NOT use toast.error', () => {
    const fnStart = src.indexOf('async function handlePauseResume')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).not.toContain('toast.error')
  })
})

// ════════════════════════════════════════════════════════════
// Issue 8 (DOCUMENTED): ChatView single-file drop
// ════════════════════════════════════════════════════════════

describe('Issue 8: ChatView handleDrop only processes first file', () => {
  const src = readSrc('views/ChatView.vue')

  it('handleDrop accesses files?.[0] — only first file', () => {
    const fnStart = src.indexOf('function handleDrop')
    const fnEnd = src.indexOf('\n}', fnStart + 10)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).toContain('files?.[0]')
  })

  it('handleDrop does not iterate over multiple files', () => {
    const fnStart = src.indexOf('function handleDrop')
    const fnEnd = src.indexOf('\n}', fnStart + 10)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    // Should not have forEach, for...of, or Array.from on files
    expect(fnBody).not.toContain('forEach')
    expect(fnBody).not.toContain('for (')
    expect(fnBody).not.toContain('for(')
    expect(fnBody).not.toContain('Array.from')
  })
})

// ════════════════════════════════════════════════════════════
// Issue 9 (DOCUMENTED): createIMInstance ghost instance risk
// ════════════════════════════════════════════════════════════

describe('Issue 9: createIMInstance calls syncBackendInstance before writeInstances', () => {
  const src = readSrc('api/im-channels.ts')

  it('createIMInstance calls syncBackendInstance', () => {
    const fnStart = src.indexOf('export async function createIMInstance')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).toContain('syncBackendInstance')
  })

  it('createIMInstance calls writeInstances', () => {
    const fnStart = src.indexOf('export async function createIMInstance')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).toContain('writeInstances')
  })

  it('syncBackendInstance is called BEFORE writeInstances (prevents ghost instance)', () => {
    const fnStart = src.indexOf('export async function createIMInstance')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    const syncIdx = fnBody.indexOf('syncBackendInstance')
    const writeIdx = fnBody.indexOf('writeInstances')
    // sync must come first — if it throws, no local record is written
    expect(syncIdx).toBeGreaterThan(0)
    expect(writeIdx).toBeGreaterThan(syncIdx)
  })

  it('syncBackendInstance uses await so errors propagate', () => {
    const fnStart = src.indexOf('export async function createIMInstance')
    const fnEnd = src.indexOf('\n}', fnStart + 50)
    const fnBody = src.slice(fnStart, fnEnd + 2)
    expect(fnBody).toMatch(/await\s+syncBackendInstance/)
  })
})
