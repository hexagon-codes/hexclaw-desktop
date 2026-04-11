/**
 * Chain integration tests: Session Lifecycle, IM Channel Lifecycle, Knowledge Lifecycle
 *
 * Each chain exercises a sequence of API calls in order, verifying that every
 * function in the chain forwards the correct parameters to the underlying
 * transport layer (Tauri invoke for chat/IM, ofetch for knowledge/session REST).
 *
 * Mocks are reset between chains via `vi.resetModules()` to guarantee fresh
 * module-level state (e.g. the singleton Tauri store cache in im-channels.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Tauri invoke + plugin-store mocks (IM channel chain) ────────────────────

const invoke = vi.hoisted(() => vi.fn())
const storeGet = vi.hoisted(() => vi.fn())
const storeSet = vi.hoisted(() => vi.fn())
const load = vi.hoisted(() => vi.fn(async () => ({ get: storeGet, set: storeSet })))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ load }))

// ─── ofetch mock (session / knowledge chains via apiGet/apiPost/etc.) ────────

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

// ─── Shared infrastructure mocks ─────────────────────────────────────────────

vi.mock('@/config/env', () => ({
  OLLAMA_BASE: 'http://localhost:11434', env: { apiBase: 'http://localhost:16060', wsBase: 'ws://localhost:16060', timeout: 30000, logLevel: 'warn' },
}))

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/utils/errors', () => ({
  fromHttpStatus: vi.fn((s: number, msg?: string) => ({ code: `HTTP_${s}`, message: msg ?? `HTTP ${s}`, status: s })),
  fromNativeError: vi.fn((e: unknown) => ({ status: 500, message: String(e) })),
  messageFromUnknownError: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}))

// =============================================================================
// Chain 1 — Session Lifecycle
// =============================================================================

describe('Chain 1: Session Lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFetch.mockReset()
    invoke.mockReset()
  })

  it('executes the full session lifecycle in sequence', async () => {
    // Import the module once; all functions share the same mockFetch.
    const chat = await import('../chat')
    let fetchCallIdx = 0

    // --- Step 1: listSessions ------------------------------------------------
    mockFetch.mockResolvedValueOnce({
      sessions: [
        { id: 's1', title: 'First chat', user_id: 'desktop-user', created_at: '2026-01-01', updated_at: '2026-01-01' },
        { id: 's2', title: 'Second chat', user_id: 'desktop-user', created_at: '2026-01-02', updated_at: '2026-01-02' },
      ],
      total: 2,
    })

    const sessions = await chat.listSessions({ limit: 10, offset: 5 })

    expect(sessions.sessions).toHaveLength(2)
    expect(sessions.total).toBe(2)
    fetchCallIdx++
    expect(mockFetch).toHaveBeenNthCalledWith(fetchCallIdx,
      '/api/v1/sessions',
      expect.objectContaining({
        method: 'GET',
        query: expect.objectContaining({ user_id: 'desktop-user', limit: 10, offset: 5 }),
      }),
    )

    // --- Step 2: sendChatViaBackend ------------------------------------------
    invoke.mockResolvedValueOnce(JSON.stringify({
      reply: 'Hello! How can I help?',
      session_id: 's1',
      tool_calls: [],
    }))

    const chatReply = await chat.sendChatViaBackend('Hi there', {
      sessionId: 's1',
      provider: 'openai',
      model: 'gpt-4',
      temperature: 0.7,
      maxTokens: 1024,
    })

    expect(chatReply.reply).toBe('Hello! How can I help?')
    expect(chatReply.session_id).toBe('s1')
    expect(invoke).toHaveBeenCalledWith('backend_chat', {
      params: expect.objectContaining({
        message: 'Hi there',
        session_id: 's1',
        provider: 'openai',
        model: 'gpt-4',
        temperature: 0.7,
        max_tokens: 1024,
        user_id: 'desktop-user',
      }),
    })

    // --- Step 3: listSessionMessages -----------------------------------------
    mockFetch.mockResolvedValueOnce({
      messages: [
        { id: 'm1', role: 'user', content: 'Hi there' },
        { id: 'm2', role: 'assistant', content: 'Hello! How can I help?' },
      ],
      total: 2,
    })

    const msgs = await chat.listSessionMessages('s1', { limit: 50, offset: 10 })

    expect(msgs.messages).toHaveLength(2)
    fetchCallIdx++
    expect(mockFetch).toHaveBeenNthCalledWith(fetchCallIdx,
      '/api/v1/sessions/s1/messages',
      expect.objectContaining({
        method: 'GET',
        query: expect.objectContaining({ limit: 50, offset: 10 }),
      }),
    )

    // --- Step 4: searchMessages ----------------------------------------------
    mockFetch.mockResolvedValueOnce({
      results: [{ id: 'm1', role: 'user', content: 'Hi there', session_id: 's1', score: 0.95 }],
      total: 1,
      query: 'Hi',
    })

    const search = await chat.searchMessages('Hi', { limit: 5 })

    expect(search.results).toHaveLength(1)
    expect(search.query).toBe('Hi')
    fetchCallIdx++
    expect(mockFetch).toHaveBeenNthCalledWith(fetchCallIdx,
      '/api/v1/messages/search',
      expect.objectContaining({
        method: 'GET',
        query: expect.objectContaining({ q: 'Hi', user_id: 'desktop-user', limit: 5 }),
      }),
    )

    // --- Step 5: forkSession -------------------------------------------------
    mockFetch.mockResolvedValueOnce({ session: { id: 's3', title: 'Fork of First chat', user_id: 'desktop-user', created_at: '2025-01-01', updated_at: '2025-01-01' }, message: 'Forked from s1' })

    const fork = await chat.forkSession('s1', 'm1')

    expect(fork.session.id).toBe('s3')
    fetchCallIdx++
    expect(mockFetch).toHaveBeenNthCalledWith(fetchCallIdx,
      '/api/v1/sessions/s1/fork',
      expect.objectContaining({
        method: 'POST',
        body: { message_id: 'm1', user_id: 'desktop-user' },
      }),
    )

    // --- Step 6: getSessionBranches ------------------------------------------
    mockFetch.mockResolvedValueOnce({
      branches: [
        { id: 's3', title: 'Fork of First chat', user_id: 'desktop-user', parent_session_id: 's1' },
      ],
    })

    const branches = await chat.getSessionBranches('s1')

    expect(branches.branches).toHaveLength(1)
    expect((branches.branches[0] as any).parent_session_id).toBe('s1')
    fetchCallIdx++
    expect(mockFetch).toHaveBeenNthCalledWith(fetchCallIdx,
      '/api/v1/sessions/s1/branches',
      expect.objectContaining({ method: 'GET' }),
    )

    // --- Step 7: updateMessageFeedback ---------------------------------------
    mockFetch.mockResolvedValueOnce({ message: 'Feedback updated' })

    await chat.updateMessageFeedback('m2', 'like')

    fetchCallIdx++
    expect(mockFetch).toHaveBeenNthCalledWith(fetchCallIdx,
      '/api/v1/messages/m2/feedback',
      expect.objectContaining({
        method: 'PUT',
        body: { feedback: 'like', user_id: 'desktop-user' },
      }),
    )

    // --- Step 8: deleteSession -----------------------------------------------
    mockFetch.mockResolvedValueOnce({ message: 'Session deleted' })

    const del = await chat.deleteSession('s1')

    expect(del.message).toBe('Session deleted')
    fetchCallIdx++
    expect(mockFetch).toHaveBeenNthCalledWith(fetchCallIdx,
      '/api/v1/sessions/s1?user_id=desktop-user',
      expect.objectContaining({ method: 'DELETE' }),
    )

    // Verify the entire chain executed all 7 ofetch calls + 1 invoke call
    expect(mockFetch).toHaveBeenCalledTimes(7)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('listSessions returns array of sessions with default params', async () => {
    mockFetch.mockResolvedValueOnce({ sessions: [], total: 0 })

    const { listSessions } = await import('../chat')
    const result = await listSessions()

    expect(result.sessions).toEqual([])
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({
        method: 'GET',
        query: { user_id: 'desktop-user' },
      }),
    )
  })

  it('sendChatViaBackend passes null for optional params when omitted', async () => {
    invoke.mockResolvedValueOnce(JSON.stringify({ reply: 'ok', session_id: 's1' }))

    const { sendChatViaBackend } = await import('../chat')
    await sendChatViaBackend('hello')

    const params = invoke.mock.calls[0]![1].params
    expect(params.session_id).toBeNull()
    expect(params.provider).toBeNull()
    expect(params.model).toBeNull()
    expect(params.temperature).toBeNull()
    expect(params.max_tokens).toBeNull()
    expect(params.attachments).toBeNull()
  })

  it('searchMessages passes query and user_id correctly', async () => {
    mockFetch.mockResolvedValueOnce({ results: [], total: 0, query: 'test' })

    const { searchMessages } = await import('../chat')
    await searchMessages('test')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/messages/search',
      expect.objectContaining({
        method: 'GET',
        query: { q: 'test', user_id: 'desktop-user' },
      }),
    )
  })

  it('forkSession sends correct POST with optional messageId', async () => {
    mockFetch.mockResolvedValueOnce({ session_id: 's-fork', message: 'Forked' })

    const { forkSession } = await import('../chat')
    await forkSession('s1')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/sessions/s1/fork',
      expect.objectContaining({
        method: 'POST',
        body: { message_id: undefined, user_id: 'desktop-user' },
      }),
    )
  })

  it('deleteSession uses DELETE method', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'ok' })

    const { deleteSession } = await import('../chat')
    await deleteSession('s-to-remove')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/sessions/s-to-remove?user_id=desktop-user',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

// =============================================================================
// Chain 2 — IM Channel Lifecycle
// =============================================================================

describe('Chain 2: IM Channel Lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    invoke.mockReset()
    storeGet.mockReset()
    storeSet.mockReset()
    load.mockClear()
  })

  /** Helper: set up an empty store, then return a fresh im-channels module. */
  async function freshModule(initialInstances: Record<string, unknown> = {}) {
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') return { ...initialInstances }
      return undefined
    })
    return import('../im-channels')
  }

  it('executes the full IM channel lifecycle in sequence', async () => {
    // --- Step 1: createIMInstance -------------------------------------------
    // syncBackendInstance (POST) should succeed
    invoke.mockResolvedValueOnce(JSON.stringify({ status: 'ok' }))

    const mod = await freshModule()
    const created = await mod.createIMInstance('My Telegram', 'telegram', { token: 'bot-123' }, true)

    expect(created.name).toBe('My Telegram')
    expect(created.type).toBe('telegram')
    expect(created.enabled).toBe(true)
    expect(created.config.token).toBe('bot-123')
    expect(created.id).toBeTruthy()
    // Verify backend sync was called
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'POST',
      path: '/api/v1/platforms/instances',
      body: JSON.stringify({
        provider: 'telegram',
        name: 'My Telegram',
        enabled: true,
        config: { token: 'bot-123' },
      }),
    })
    // Verify store was written
    expect(storeSet).toHaveBeenCalledWith(
      'im-instances',
      expect.objectContaining({
        [created.id]: expect.objectContaining({ name: 'My Telegram' }),
      }),
    )

    // --- Step 2: getIMInstances ----------------------------------------------
    // Refresh module to simulate a new read cycle
    invoke.mockReset()
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          [created.id]: {
            id: created.id,
            name: 'My Telegram',
            type: 'telegram',
            enabled: true,
            config: { token: 'bot-123' },
            createdAt: created.createdAt,
          },
        }
      }
      return undefined
    })

    const mod2 = await import('../im-channels')
    const instances = await mod2.getIMInstances()

    expect(instances).toHaveLength(1)
    expect(instances[0]!.name).toBe('My Telegram')
    // getIMInstances only reads the store, no invoke calls
    expect(invoke).not.toHaveBeenCalled()

    // --- Step 3: testSavedIMInstanceRuntime -----------------------------------
    invoke.mockImplementation(async (_cmd: string, payload: Record<string, string | null>) => {
      if (payload.path === '/health') {
        return JSON.stringify({ status: 'healthy' })
      }
      if (payload.path === '/api/v1/platforms/instances') {
        return JSON.stringify({ message: 'synced' })
      }
      if (payload.path === `/api/v1/platforms/instances/${encodeURIComponent('My Telegram')}/test`) {
        return JSON.stringify({ success: true, message: 'Telegram bot is alive' })
      }
      return JSON.stringify({})
    })

    const mod3 = await import('../im-channels')
    const testResult = await mod3.testSavedIMInstanceRuntime(instances[0]!)

    expect(testResult.success).toBe(true)
    expect(testResult.message).toBe('Telegram bot is alive')
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'POST',
      path: `/api/v1/platforms/instances/${encodeURIComponent('My Telegram')}/test`,
      body: null,
    })

    // --- Step 4: startIMInstance ---------------------------------------------
    invoke.mockReset()
    invoke.mockResolvedValueOnce(JSON.stringify({ message: 'Instance started' }))

    const mod4 = await import('../im-channels')
    const startResult = await mod4.startIMInstance('My Telegram')

    expect(startResult.success).toBe(true)
    expect(startResult.message).toBe('Instance started')
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'POST',
      path: `/api/v1/platforms/instances/${encodeURIComponent('My Telegram')}/start`,
      body: null,
    })

    // --- Step 5: stopIMInstance ----------------------------------------------
    invoke.mockReset()
    invoke.mockResolvedValueOnce(JSON.stringify({ message: 'Instance stopped' }))

    const mod5 = await import('../im-channels')
    const stopResult = await mod5.stopIMInstance('My Telegram')

    expect(stopResult.success).toBe(true)
    expect(stopResult.message).toBe('Instance stopped')
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'POST',
      path: `/api/v1/platforms/instances/${encodeURIComponent('My Telegram')}/stop`,
      body: null,
    })

    // --- Step 6: updateIMInstance (rename) ------------------------------------
    invoke.mockReset()
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          [created.id]: {
            id: created.id,
            name: 'My Telegram',
            type: 'telegram' as const,
            enabled: true,
            config: { token: 'bot-123' },
            createdAt: created.createdAt,
          },
        }
      }
      return undefined
    })

    // Rename triggers: POST new name (disabled) -> DELETE old name -> POST new name (enabled)
    invoke.mockImplementation(async (_cmd: string, payload: Record<string, string | null>) => {
      if (payload.method === 'POST') return JSON.stringify({ status: 'ok' })
      if (payload.method === 'DELETE') return JSON.stringify({ ok: true })
      return JSON.stringify({})
    })

    const mod6 = await import('../im-channels')
    const renamed = await mod6.updateIMInstance(created.id, { name: 'Telegram Renamed' })

    expect(renamed).toBe(true)
    // Should have called: POST (create new disabled), DELETE (old name), POST (re-enable new)
    const postCalls = invoke.mock.calls.filter((c) => c[1]?.method === 'POST')
    const deleteCalls = invoke.mock.calls.filter((c) => c[1]?.method === 'DELETE')
    expect(postCalls.length).toBe(2)
    expect(deleteCalls.length).toBe(1)
    expect(deleteCalls[0]![1].path).toContain(encodeURIComponent('My Telegram'))
    // Store should be updated with new name
    expect(storeSet).toHaveBeenCalledWith(
      'im-instances',
      expect.objectContaining({
        [created.id]: expect.objectContaining({ name: 'Telegram Renamed' }),
      }),
    )

    // --- Step 7: deleteIMInstance --------------------------------------------
    invoke.mockReset()
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          [created.id]: {
            id: created.id,
            name: 'Telegram Renamed',
            type: 'telegram' as const,
            enabled: true,
            config: { token: 'bot-123' },
            createdAt: created.createdAt,
          },
        }
      }
      return undefined
    })
    invoke.mockResolvedValueOnce(JSON.stringify({ ok: true }))

    const mod7 = await import('../im-channels')
    const deleted = await mod7.deleteIMInstance(created.id)

    expect(deleted).toBe(true)
    // DELETE backend call
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'DELETE',
      path: `/api/v1/platforms/instances/${encodeURIComponent('Telegram Renamed')}`,
      body: null,
    })
    // Store should be written without the deleted instance
    const lastStoreWrite = storeSet.mock.calls[storeSet.mock.calls.length - 1]!
    expect(lastStoreWrite[0]).toBe('im-instances')
    expect(lastStoreWrite[1]).not.toHaveProperty(created.id)
  })

  it('createIMInstance validates required fields', async () => {
    // Telegram requires 'token' -- pass empty config
    const mod = await freshModule()

    await expect(
      mod.createIMInstance('Bad Bot', 'telegram', {}, true),
    ).rejects.toThrow('Missing required fields')

    // No backend call should have been made
    expect(invoke).not.toHaveBeenCalled()
  })

  it('createIMInstance rejects duplicate names (case-insensitive)', async () => {
    const mod = await freshModule({
      existing: {
        id: 'existing',
        name: 'My Bot',
        type: 'telegram',
        enabled: true,
        config: { token: 'tok' },
        createdAt: 1,
      },
    })

    await expect(
      mod.createIMInstance(' my bot ', 'telegram', { token: 'tok2' }),
    ).rejects.toThrow('实例名称重复')
  })

  it('rename rollback cleans up new instance when old delete fails', async () => {
    const existing = {
      r1: {
        id: 'r1',
        name: 'OldName',
        type: 'discord' as const,
        enabled: true,
        config: { token: 'discord-tok' },
        createdAt: 1,
      },
    }

    const mod = await freshModule(existing)

    let callIdx = 0
    invoke.mockImplementation(async (_cmd: string, payload: Record<string, string | null>) => {
      callIdx++
      // 1st: POST new name -> success
      if (callIdx === 1 && payload.method === 'POST') return JSON.stringify({ ok: true })
      // 2nd: DELETE old name -> failure
      if (callIdx === 2 && payload.method === 'DELETE') throw new Error('backend refused delete')
      // 3rd: DELETE new name (rollback) -> success
      if (callIdx === 3 && payload.method === 'DELETE') return JSON.stringify({ ok: true })
      return JSON.stringify({})
    })

    await expect(mod.updateIMInstance('r1', { name: 'NewName' })).rejects.toThrow('backend refused delete')

    const rollbackDeleteCalls = invoke.mock.calls.filter(
      (c) => c[1]?.method === 'DELETE' && typeof c[1]?.path === 'string' && c[1].path.includes('NewName'),
    )
    expect(rollbackDeleteCalls).toHaveLength(1)
  })

  it('testSavedIMInstanceRuntime skips connectivity check for disabled instances', async () => {
    invoke.mockImplementation(async (_cmd: string, payload: Record<string, string | null>) => {
      if (payload.path === '/health') return JSON.stringify({ status: 'healthy' })
      return JSON.stringify({})
    })

    const mod = await freshModule()
    const result = await mod.testSavedIMInstanceRuntime({
      id: 'd1',
      name: 'Disabled Bot',
      type: 'telegram',
      enabled: false,
      config: { token: 'tok' },
      createdAt: 1,
    })

    expect(result.success).toBe(true)
    expect(result.message).toContain('disabled')
  })

  it('deleteIMInstance removes from both backend and store', async () => {
    const existing = {
      del1: {
        id: 'del1',
        name: 'ToDelete',
        type: 'telegram' as const,
        enabled: true,
        config: { token: 'tok' },
        createdAt: 1,
      },
    }

    const mod = await freshModule(existing)
    invoke.mockResolvedValueOnce(JSON.stringify({ ok: true }))

    const result = await mod.deleteIMInstance('del1')

    expect(result).toBe(true)
    // Backend DELETE
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'DELETE',
      path: '/api/v1/platforms/instances/ToDelete',
      body: null,
    })
    // Store written without the instance
    const storeArg = storeSet.mock.calls.find((c) => c[0] === 'im-instances')
    expect(storeArg).toBeTruthy()
    expect(storeArg![1]).not.toHaveProperty('del1')
  })
})

// =============================================================================
// Chain 3 — Knowledge Lifecycle
// =============================================================================

describe('Chain 3: Knowledge Lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFetch.mockReset()
  })

  it('executes the full knowledge lifecycle in sequence', async () => {
    // --- Step 1: addDocument -------------------------------------------------
    mockFetch.mockResolvedValueOnce({
      id: 'doc-1',
      title: 'Architecture Guide',
      chunk_count: 3,
      created_at: '2026-03-29T00:00:00Z',
    })

    const { addDocument } = await import('../knowledge')
    const added = await addDocument('Architecture Guide', 'Content about architecture...', 'manual')

    expect(added.id).toBe('doc-1')
    expect(added.title).toBe('Architecture Guide')
    expect(added.chunk_count).toBe(3)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents',
      expect.objectContaining({
        method: 'POST',
        body: { title: 'Architecture Guide', content: 'Content about architecture...', source: 'manual' },
      }),
    )

    // --- Step 2: getDocuments ------------------------------------------------
    mockFetch.mockResolvedValueOnce({
      documents: [
        { id: 'doc-1', title: 'Architecture Guide', chunk_count: 3, created_at: '2026-03-29T00:00:00Z' },
      ],
      total: 1,
    })

    const { getDocuments } = await import('../knowledge')
    const docs = await getDocuments()

    expect(docs.documents).toHaveLength(1)
    expect(docs.total).toBe(1)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents',
      expect.objectContaining({ method: 'GET' }),
    )

    // --- Step 3: getDocument -------------------------------------------------
    mockFetch.mockResolvedValueOnce({
      id: 'doc-1',
      title: 'Architecture Guide',
      content: 'Full document content here...',
      chunk_count: 3,
      created_at: '2026-03-29T00:00:00Z',
    })

    const { getDocument } = await import('../knowledge')
    const detail = await getDocument('doc-1')

    expect(detail.id).toBe('doc-1')
    expect(detail.content).toBe('Full document content here...')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents/doc-1',
      expect.objectContaining({ method: 'GET' }),
    )

    // --- Step 4: getDocumentContent ------------------------------------------
    mockFetch.mockResolvedValueOnce({
      id: 'doc-1',
      title: 'Architecture Guide',
      content: 'Full document content from detail API',
      chunk_count: 3,
      created_at: '2026-03-29T00:00:00Z',
    })

    const { getDocumentContent } = await import('../knowledge')
    const content = await getDocumentContent({
      id: 'doc-1',
      title: 'Architecture Guide',
      chunk_count: 3,
      created_at: '2026-03-29T00:00:00Z',
    })

    expect(content).toBe('Full document content from detail API')

    // --- Step 5: searchKnowledge ---------------------------------------------
    mockFetch.mockResolvedValueOnce({
      result: [
        { content: 'relevant chunk 1', score: 0.95, doc_id: 'doc-1', doc_title: 'Architecture Guide', chunk_index: 0 },
        { content: 'relevant chunk 2', score: 0.82, doc_id: 'doc-1', doc_title: 'Architecture Guide', chunk_index: 1 },
      ],
    })

    const { searchKnowledge } = await import('../knowledge')
    const searchResult = await searchKnowledge('architecture patterns', 5)

    expect(searchResult.result).toHaveLength(2)
    expect(searchResult.result[0]!.score).toBe(0.95)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/search',
      expect.objectContaining({
        method: 'POST',
        body: { query: 'architecture patterns', top_k: 5 },
      }),
    )

    // --- Step 6: reindexDocument ---------------------------------------------
    mockFetch.mockResolvedValueOnce({ status: 'reindexing', message: 'Document queued for reindex' })

    const { reindexDocument } = await import('../knowledge')
    const reindex = await reindexDocument('doc-1')

    expect(reindex.status).toBe('reindexing')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents/doc-1/reindex',
      expect.objectContaining({ method: 'POST' }),
    )

    // --- Step 7: deleteDocument ----------------------------------------------
    mockFetch.mockResolvedValueOnce({ message: 'Document deleted' })

    const { deleteDocument } = await import('../knowledge')
    const delResult = await deleteDocument('doc-1')

    expect(delResult.message).toBe('Document deleted')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents/doc-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('addDocument calls correct API path with title, content, and source', async () => {
    mockFetch.mockResolvedValueOnce({ id: 'd2', title: 'T', chunk_count: 1, created_at: '' })

    const { addDocument } = await import('../knowledge')
    await addDocument('Title', 'Body text', 'api')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents',
      expect.objectContaining({
        method: 'POST',
        body: { title: 'Title', content: 'Body text', source: 'api' },
      }),
    )
  })

  it('getDocuments calls GET on /api/v1/knowledge/documents', async () => {
    mockFetch.mockResolvedValueOnce({ documents: [], total: 0 })

    const { getDocuments } = await import('../knowledge')
    await getDocuments()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('getDocument encodes special characters in document ID', async () => {
    mockFetch.mockResolvedValueOnce({ id: 'doc/special id', title: 'Test', content: '' })

    const { getDocument } = await import('../knowledge')
    await getDocument('doc/special id')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents/doc%2Fspecial%20id',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('getDocumentContent falls back to search when detail API fails', async () => {
    // First call (getDocument inside getDocumentContent) rejects
    mockFetch.mockRejectedValueOnce(new Error('404 not found'))
    // Second call (searchKnowledge inside getDocumentContent) resolves
    mockFetch.mockResolvedValueOnce({
      result: [
        { content: 'chunk A', doc_id: 'doc-x', chunk_index: 0, score: 0.9 },
        { content: 'chunk B', doc_id: 'doc-x', chunk_index: 1, score: 0.8 },
      ],
    })

    const { getDocumentContent } = await import('../knowledge')
    const content = await getDocumentContent({
      id: 'doc-x',
      title: 'Fallback Test',
      chunk_count: 2,
      created_at: '',
    })

    expect(content).toBe('chunk A\n\nchunk B')
  })

  it('searchKnowledge passes query and default top_k', async () => {
    mockFetch.mockResolvedValueOnce({ result: [] })

    const { searchKnowledge } = await import('../knowledge')
    await searchKnowledge('find this')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/search',
      expect.objectContaining({
        method: 'POST',
        body: { query: 'find this', top_k: 3 },
      }),
    )
  })

  it('reindexDocument calls POST on correct path with encoded ID', async () => {
    mockFetch.mockResolvedValueOnce({ status: 'ok' })

    const { reindexDocument } = await import('../knowledge')
    await reindexDocument('doc/needs reindex')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents/doc%2Fneeds%20reindex/reindex',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('deleteDocument calls DELETE with encoded document ID', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'ok' })

    const { deleteDocument } = await import('../knowledge')
    await deleteDocument('doc-abc')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents/doc-abc',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
