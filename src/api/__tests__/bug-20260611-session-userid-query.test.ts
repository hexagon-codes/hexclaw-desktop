/**
 * BUG-20260611 (review Critical): session write endpoints that the backend
 * reads user_id from QUERY were silently failing because the frontend helper
 * injected user_id into the BODY.
 *
 * Backend api/handler_session.go: 10 of 11 session/message handlers read
 * user_id via sessionUserIDFromRequest() = query ONLY. Only handleCreateSession
 * (line 293) tolerates a body user_id via ...OrBody(). suggestSessionTitle
 * (handler line 389) and updateMessageFeedback (line 239) hit query-only
 * readers, so a body user_id fell through to "api-user" → getOwnedSession 404/403.
 *
 * Contract: every session/message write call must carry user_id in the URL
 * query string so it reaches both query-only and OrBody backend readers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: { create: () => mockFetch },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import {
  suggestSessionTitle,
  updateMessageFeedback,
  forkSession,
  createSession,
  updateSessionTitle,
  appendSessionMessage,
} from '../chat'
import { DESKTOP_USER_ID } from '@/constants'

function lastCall() {
  const calls = mockFetch.mock.calls
  return calls[calls.length - 1] as [string, Record<string, unknown>]
}

describe('BUG-20260611 session write user_id must be in query', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({})
  })

  it('suggestSessionTitle puts user_id in the URL query (backend reads query only)', async () => {
    await suggestSessionTitle('sess-abc', 'Some Title')
    const [url, opts] = lastCall()
    const query = (opts?.query ?? {}) as Record<string, unknown>
    const inQuery = url.includes(`user_id=${DESKTOP_USER_ID}`) || query.user_id === DESKTOP_USER_ID
    expect(inQuery).toBe(true)
  })

  it('updateMessageFeedback puts user_id in the URL query (backend reads query only)', async () => {
    await updateMessageFeedback('msg-xyz', 'like')
    const [url, opts] = lastCall()
    const query = (opts?.query ?? {}) as Record<string, unknown>
    const inQuery = url.includes(`user_id=${DESKTOP_USER_ID}`) || query.user_id === DESKTOP_USER_ID
    expect(inQuery).toBe(true)
  })
})

// Review M11: the session* write wrappers are belt-and-suspenders — they must
// inject user_id into BOTH the URL query and the JSON body, because backend
// handlers fall into three reader categories (query-only, query-or-body,
// body-only) and a wrapper covering only one category reintroduces the bug
// silently when a new endpoint of another category is added.
describe('M11 session write wrappers inject user_id into query AND body', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({})
  })

  it('forkSession keeps user_id in the BODY — backend handleForkSession (api/handler_session.go:547) reads the body only and falls back to "api-user" without it', async () => {
    await forkSession('sess-1', 'msg-1')
    const [url, opts] = lastCall()
    const body = (opts?.body ?? {}) as Record<string, unknown>
    // Body placement is the load-bearing half for this endpoint.
    expect(body.user_id).toBe(DESKTOP_USER_ID)
    expect(body.message_id).toBe('msg-1')
    // Query is the belt-and-suspenders half (harmless to body-only readers).
    expect(url).toContain(`user_id=${encodeURIComponent(DESKTOP_USER_ID)}`)
  })

  it('createSession (query-or-body backend reader) carries user_id in both places', async () => {
    await createSession('sess-1', 'Title')
    const [url, opts] = lastCall()
    expect(((opts?.body ?? {}) as Record<string, unknown>).user_id).toBe(DESKTOP_USER_ID)
    expect(url).toContain(`user_id=${encodeURIComponent(DESKTOP_USER_ID)}`)
  })

  it('updateSessionTitle carries user_id in both places', async () => {
    await updateSessionTitle('sess-1', 'New title')
    const [url, opts] = lastCall()
    expect(((opts?.body ?? {}) as Record<string, unknown>).user_id).toBe(DESKTOP_USER_ID)
    expect(url).toContain(`user_id=${encodeURIComponent(DESKTOP_USER_ID)}`)
  })

  it('does not duplicate user_id when the call site already put it in the URL', async () => {
    await appendSessionMessage('sess-1', { role: 'user', content: 'hi' })
    const [url] = lastCall()
    expect(url.match(/user_id=/g)?.length).toBe(1)
  })

  it('structural guard: sessionPost/sessionPatch/sessionPut all route the URL through withUserIdQuery, and withUserIdQuery appends an encoded user_id', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/api/chat.ts'), 'utf-8')

    // Every write wrapper must pass its URL through withUserIdQuery so a
    // future sessionPost against a query-only endpoint still carries user_id.
    for (const fn of ['sessionPost', 'sessionPatch', 'sessionPut']) {
      const re = new RegExp(`function ${fn}<T>\\(url: string[^)]*\\)\\s*\\{\\s*return api(Post|Patch|Put)<T>\\(withUserIdQuery\\(url\\)`)
      expect(re.test(source), `${fn} must wrap its URL with withUserIdQuery()`).toBe(true)
    }
    // And the helper itself must append an encoded user_id query param.
    expect(source).toMatch(/function withUserIdQuery[\s\S]{0,400}user_id=\$\{encodeURIComponent\(DESKTOP_USER_ID\)\}/)
  })
})
