import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const toolbar = readFileSync(resolve(__dirname, '../ChatToolbar.vue'), 'utf8')
const chatView = readFileSync(resolve(__dirname, '../../../views/ChatView.vue'), 'utf8')

describe('chat search information architecture', () => {
  it('removes the duplicate current-conversation search UI and state completely', () => {
    expect(toolbar).not.toContain("import { Search,")
    expect(toolbar).not.toContain("emit('search')")
    expect(toolbar).not.toContain('common.search')
    expect(chatView).not.toContain('ChatSearchDialog')
    expect(chatView).not.toContain('showSearch')
    expect(chatView).not.toContain('handleSearchShortcut')
    expect(existsSync(resolve(__dirname, '../ChatSearchDialog.vue'))).toBe(false)
  })

  it('keeps the left session list as the sole title-and-content search surface', () => {
    const sessionList = readFileSync(resolve(__dirname, '../SessionList.vue'), 'utf8')
    expect(sessionList).toContain("searchMessages(query, { limit: 50 })")
    expect(sessionList).toContain('formatSearchSnippet')
    expect(sessionList).toContain("t('chat.filterSessions')")
  })
})
