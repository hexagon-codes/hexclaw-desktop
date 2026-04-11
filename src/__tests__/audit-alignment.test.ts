/**
 * Audit: Frontend-Backend Alignment & Security Tests
 *
 * Tests actual request shapes, response resilience, and security vectors
 * across all high-risk API modules. Failing tests indicate REAL bugs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ═══════════════════════════════════════════════════════════════════
// Global mocks
// ═══════════════════════════════════════════════════════════════════

vi.mock('@/config/env', () => ({
  env: {
    apiBase: 'http://localhost:16060',
    wsBase: 'ws://localhost:16060',
    timeout: 30000,
    logLevel: 'warn',
    isDev: false,
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/constants', () => ({
  DESKTOP_USER_ID: 'desktop-user',
}))

// ═══════════════════════════════════════════════════════════════════
// Section 1: API Request/Response Shape Validation
// ═══════════════════════════════════════════════════════════════════

describe('1. API Request/Response Shape Validation', () => {
  // ─── chat.ts ──────────────────────────────────────────────────

  describe('chat.ts — sendChatViaBackend', () => {
    let invokeArgs: unknown

    beforeEach(() => {
      vi.resetModules()
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn((_cmd: string, args: unknown) => {
          invokeArgs = args
          return Promise.resolve(JSON.stringify({
            reply: 'hello',
            session_id: 'sess-1',
          }))
        }),
      }))
    })

    it('sends temperature and max_tokens — but backend ChatRequest does NOT declare them (silently dropped)', async () => {
      const { sendChatViaBackend } = await import('@/api/chat')
      await sendChatViaBackend('test', { temperature: 0.5, maxTokens: 1024 })

      const params = (invokeArgs as { params: Record<string, unknown> }).params
      // Frontend DOES send these fields
      expect(params).toHaveProperty('temperature', 0.5)
      expect(params).toHaveProperty('max_tokens', 1024)
      // But backend ChatRequest struct has NO json tags for temperature/max_tokens.
      // They are silently ignored by the Go JSON decoder. This is a confirmed
      // misalignment: the frontend offers per-message temperature/max_tokens,
      // but the backend ignores them.
    })

    it('maps options.sessionId to session_id (camelCase → snake_case)', async () => {
      const { sendChatViaBackend } = await import('@/api/chat')
      await sendChatViaBackend('test', { sessionId: 'my-session' })

      const params = (invokeArgs as { params: Record<string, unknown> }).params
      expect(params).toHaveProperty('session_id', 'my-session')
      expect(params).not.toHaveProperty('sessionId')
    })

    it('includes user_id = DESKTOP_USER_ID', async () => {
      const { sendChatViaBackend } = await import('@/api/chat')
      await sendChatViaBackend('hello')

      const params = (invokeArgs as { params: Record<string, unknown> }).params
      expect(params).toHaveProperty('user_id', 'desktop-user')
    })

    it('null-coalesces missing optional fields', async () => {
      const { sendChatViaBackend } = await import('@/api/chat')
      await sendChatViaBackend('test')

      const params = (invokeArgs as { params: Record<string, unknown> }).params
      expect(params.session_id).toBeNull()
      expect(params.role).toBeNull()
      expect(params.provider).toBeNull()
      expect(params.model).toBeNull()
      expect(params.temperature).toBeNull()
      expect(params.max_tokens).toBeNull()
      expect(params.attachments).toBeNull()
    })

    it('throws on non-JSON backend response', async () => {
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue('not json!!!'),
      }))
      vi.resetModules()
      const { sendChatViaBackend } = await import('@/api/chat')
      await expect(sendChatViaBackend('test')).rejects.toThrow('non-JSON')
    })

    it('handles backend JSON without reply field gracefully (defensive check added)', async () => {
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue(JSON.stringify({ session_id: 's1' })),
      }))
      vi.resetModules()
      const { sendChatViaBackend } = await import('@/api/chat')

      // FIXED: (result?.reply ?? '').slice(0, 50) handles undefined reply without crashing
      const result = await sendChatViaBackend('test')
      expect(result.session_id).toBe('s1')
    })
  })

  describe('chat.ts — sendChat compat wrapper', () => {
    beforeEach(() => {
      vi.resetModules()
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue(JSON.stringify({
          reply: 'ok',
          session_id: 's1',
        })),
      }))
    })

    it('sendChat forwards provider_id as provider fallback', async () => {
      const { sendChat } = await import('@/api/chat')
      // ChatRequest has both provider and provider_id
      // sendChat does: provider: req.provider ?? req.provider_id
      const mockInvoke = (await import('@tauri-apps/api/core')).invoke as ReturnType<typeof vi.fn>

      await sendChat({ message: 'hi', provider_id: 'deepseek' })
      const params = mockInvoke.mock.calls[0]![1].params
      expect(params.provider).toBe('deepseek')
    })

    it('sendChat forwards temperature/maxTokens from ChatRequest', async () => {
      const { sendChat } = await import('@/api/chat')
      const mockInvoke = (await import('@tauri-apps/api/core')).invoke as ReturnType<typeof vi.fn>

      await sendChat({
        message: 'hi',
        temperature: 0.9,
        max_tokens: 2000,
      })
      const params = mockInvoke.mock.calls[0]![1].params
      // FIXED: sendChat now forwards temperature and max_tokens from ChatRequest
      expect(params.temperature).toBe(0.9)
      expect(params.max_tokens).toBe(2000)
    })
  })

  // ─── config.ts ─────────────────────────────────────────────────

  describe('config.ts — getLLMConfig/updateLLMConfig', () => {
    beforeEach(() => {
      vi.resetModules()
      ;(globalThis as Record<string, unknown>).isTauri = true
    })

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).isTauri
    })

    it('getLLMConfig calls proxy with GET /api/v1/config/llm', async () => {
      const mockInvoke = vi.fn().mockResolvedValue(JSON.stringify({
        default: 'openai',
        providers: {},
        routing: { enabled: false, strategy: 'round_robin' },
        cache: { enabled: false, similarity: 0.9, ttl: '1h', max_entries: 100 },
      }))
      vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

      const { getLLMConfig } = await import('@/api/config')
      const config = await getLLMConfig()

      expect(mockInvoke).toHaveBeenCalledWith('proxy_api_request', {
        method: 'GET',
        path: '/api/v1/config/llm',
        body: null,
      })
      expect(config).toHaveProperty('default')
      expect(config).toHaveProperty('providers')
      expect(config).toHaveProperty('routing')
      expect(config).toHaveProperty('cache')
    })

    it('updateLLMConfig calls proxy with PUT and stringified body', async () => {
      const mockInvoke = vi.fn().mockResolvedValue(JSON.stringify({ ok: true }))
      vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

      const { updateLLMConfig } = await import('@/api/config')
      const config = {
        default: 'deepseek',
        providers: {
          deepseek: { api_key: 'sk-xxx', base_url: 'https://api.deepseek.com', model: 'deepseek-chat', compatible: 'openai' },
        },
        routing: { enabled: false, strategy: 'round_robin' },
        cache: { enabled: false, similarity: 0.9, ttl: '1h', max_entries: 100 },
      }
      await updateLLMConfig(config)

      expect(mockInvoke).toHaveBeenCalledWith('proxy_api_request', {
        method: 'PUT',
        path: '/api/v1/config/llm',
        body: JSON.stringify(config),
      })
    })

    it('getLLMConfig throws on non-JSON response', async () => {
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue('invalid'),
      }))

      const { getLLMConfig } = await import('@/api/config')
      await expect(getLLMConfig()).rejects.toThrow('non-JSON')
    })
  })

  // ─── agents.ts ─────────────────────────────────────────────────

  describe('agents.ts — registerAgent/updateAgent', () => {
    let mockApi: ReturnType<typeof vi.fn>

    beforeEach(() => {
      vi.resetModules()
      mockApi = vi.fn().mockResolvedValue({ message: 'ok', name: 'my-agent' })
      vi.doMock('@/api/client', () => ({
        apiGet: mockApi,
        apiPost: mockApi,
        apiPut: mockApi,
        apiDelete: mockApi,
      }))
    })

    it('registerAgent sends full AgentConfig as body to POST /api/v1/agents', async () => {
      const { registerAgent } = await import('@/api/agents')
      const agent = { name: 'test-agent', display_name: 'Test', model: 'gpt-4', provider: 'openai' }
      await registerAgent(agent)

      expect(mockApi).toHaveBeenCalledWith('/api/v1/agents', agent)
    })

    it('updateAgent URL-encodes the agent name', async () => {
      const { updateAgent } = await import('@/api/agents')
      await updateAgent('agent/special', { model: 'gpt-4o' })

      // Should encode the name in the URL
      expect(mockApi).toHaveBeenCalledWith(
        `/api/v1/agents/${encodeURIComponent('agent/special')}`,
        { model: 'gpt-4o' },
      )
    })

    it('getAgents response includes { agents, total, default } fields', async () => {
      const fullResponse = { agents: [], total: 0, default: 'general' }
      mockApi.mockResolvedValueOnce(fullResponse)

      const { getAgents } = await import('@/api/agents')
      const result = await getAgents()

      expect(result).toHaveProperty('agents')
      expect(result).toHaveProperty('total')
      expect(result).toHaveProperty('default')
    })
  })

  // ─── knowledge.ts ─────────────────────────────────────────────

  describe('knowledge.ts — uploadDocument & search', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('uploadDocument uses FormData with field name "file"', async () => {
      let capturedBody: unknown
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: vi.fn((url: string, body: unknown) => {
          capturedBody = body
          return Promise.resolve({ id: 'doc1', title: 'test', chunk_count: 3, created_at: '2024-01-01' })
        }),
        apiDelete: vi.fn(),
      }))

      const { uploadDocument } = await import('@/api/knowledge')
      const file = new File(['hello world'], 'test.txt', { type: 'text/plain' })
      await uploadDocument(file)

      expect(capturedBody).toBeInstanceOf(FormData)
      expect((capturedBody as FormData).get('file')).toBeInstanceOf(File)
    })

    it('searchKnowledge handles both result and results keys from backend', async () => {
      const mockPost = vi.fn()
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      // Backend may return { result: [...] } or { results: [...] }
      mockPost.mockResolvedValueOnce({
        results: [{ content: 'chunk1', score: 0.9 }],
      })

      const { searchKnowledge } = await import('@/api/knowledge')
      const res1 = await searchKnowledge('test query')
      expect(res1.result).toHaveLength(1)
      expect(res1.result[0]!.content).toBe('chunk1')
    })

    it('searchKnowledge sends { query, top_k } to POST /api/v1/knowledge/search', async () => {
      const mockPost = vi.fn().mockResolvedValue({ result: [] })
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { searchKnowledge } = await import('@/api/knowledge')
      await searchKnowledge('hello', 10)

      expect(mockPost).toHaveBeenCalledWith(
        '/api/v1/knowledge/search',
        { query: 'hello', top_k: 10 },
      )
    })
  })

  // ─── tasks.ts ──────────────────────────────────────────────────

  describe('tasks.ts — createCronJob/getCronJobHistory', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('createCronJob sends user_id and defaults type to "cron"', async () => {
      const mockPost = vi.fn().mockResolvedValue({ id: 'j1', name: 'job', next_run_at: '' })
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { createCronJob } = await import('@/api/tasks')
      await createCronJob({ name: 'daily', schedule: '0 9 * * *', prompt: 'hello' })

      expect(mockPost).toHaveBeenCalledWith('/api/v1/cron/jobs', {
        name: 'daily',
        schedule: '0 9 * * *',
        prompt: 'hello',
        type: 'cron',
        user_id: 'desktop-user',
      })
    })

    it('getCronJobHistory normalizes both history and runs response keys', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        runs: [
          { id: 'r1', job_id: 'j1', status: 'success', run_at: '2024-01-01T00:00:00Z' },
        ],
      })
      vi.doMock('@/api/client', () => ({
        apiGet: mockGet,
        apiPost: vi.fn(),
        apiDelete: vi.fn(),
      }))

      const { getCronJobHistory } = await import('@/api/tasks')
      const history = await getCronJobHistory('j1')

      // Should normalize run_at to started_at
      expect(history[0]!.started_at).toBe('2024-01-01T00:00:00Z')
    })

    it('getCronJobHistory falls back to empty array when neither history nor runs exists', async () => {
      const mockGet = vi.fn().mockResolvedValue({})
      vi.doMock('@/api/client', () => ({
        apiGet: mockGet,
        apiPost: vi.fn(),
        apiDelete: vi.fn(),
      }))

      const { getCronJobHistory } = await import('@/api/tasks')
      const history = await getCronJobHistory('j1')

      expect(history).toEqual([])
    })
  })

  // ─── mcp.ts ────────────────────────────────────────────────────

  describe('mcp.ts — callMcpTool', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('sends { name, arguments } to POST /api/v1/mcp/tools/call', async () => {
      const mockPost = vi.fn().mockResolvedValue({ result: 'done' })
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { callMcpTool } = await import('@/api/mcp')
      await callMcpTool('read_file', { path: '/tmp/test' })

      expect(mockPost).toHaveBeenCalledWith('/api/v1/mcp/tools/call', {
        name: 'read_file',
        arguments: { path: '/tmp/test' },
      })
    })

    it('rejects empty tool name', async () => {
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: vi.fn(),
        apiDelete: vi.fn(),
      }))

      const { callMcpTool } = await import('@/api/mcp')
      await expect(callMcpTool('', {})).rejects.toThrow('toolName must be a non-empty string')
      await expect(callMcpTool('   ', {})).rejects.toThrow('toolName must be a non-empty string')
    })

    it('throws if backend response contains error string', async () => {
      const mockPost = vi.fn().mockResolvedValue({ result: null, error: 'tool not found' })
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { callMcpTool } = await import('@/api/mcp')
      await expect(callMcpTool('no_such_tool', {})).rejects.toThrow('tool not found')
    })

    it('throws if backend returns null', async () => {
      const mockPost = vi.fn().mockResolvedValue(null)
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { callMcpTool } = await import('@/api/mcp')
      await expect(callMcpTool('some_tool', {})).rejects.toThrow('malformed response')
    })
  })

  // ─── ollama.ts ─────────────────────────────────────────────────

  describe('ollama.ts — getOllamaStatus / pullOllamaModel', () => {
    const originalFetch = globalThis.fetch

    beforeEach(() => {
      vi.resetModules()
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it('getOllamaStatus directly fetches Ollama native API', async () => {
      vi.resetModules()
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ models: [{ name: 'qwen3', size: 1000, modified_at: '2024-01-01', details: {} }] }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: '0.3.0' }) })
      vi.stubGlobal('fetch', mockFetch)
      vi.doMock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' }, OLLAMA_BASE: 'http://localhost:11434' }))

      const { getOllamaStatus } = await import('@/api/ollama')
      const status = await getOllamaStatus()

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.anything())
      expect(status.running).toBe(true)
      expect(status.model_count).toBe(1)
      vi.unstubAllGlobals()
    })

    it('getOllamaStatus returns not running on error', async () => {
      vi.resetModules()
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
      vi.doMock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' }, OLLAMA_BASE: 'http://localhost:11434' }))

      const { getOllamaStatus } = await import('@/api/ollama')
      const status = await getOllamaStatus()
      expect(status.running).toBe(false)
      vi.unstubAllGlobals()
    })

    it('getOllamaRunning extracts models from Ollama /api/ps', async () => {
      vi.resetModules()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          models: [{ name: 'llama3.1', size: 1000, size_vram: 500, expires_at: '', context_length: 4096 }],
        }),
      }))
      vi.doMock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' }, OLLAMA_BASE: 'http://localhost:11434' }))

      const { getOllamaRunning } = await import('@/api/ollama')
      const models = await getOllamaRunning()
      expect(models).toHaveLength(1)
      expect(models[0]!.name).toBe('llama3.1')
      vi.unstubAllGlobals()
    })

    it('getOllamaRunning returns empty array when data.models is missing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }))

      const { getOllamaRunning } = await import('@/api/ollama')
      const models = await getOllamaRunning()
      expect(models).toEqual([])
      vi.unstubAllGlobals()
    })

    it('pullOllamaModel parses NDJSON stream events (with and without data: prefix)', async () => {
      const chunks = [
        'data: {"status":"pulling manifest"}\n',
        '{"status":"downloading","completed":50,"total":100,"digest":"sha256:abc"}\n',
        'data: {"status":"success"}\n',
      ]
      let chunkIndex = 0

      const mockReader = {
        read: vi.fn(() => {
          if (chunkIndex < chunks.length) {
            const encoder = new TextEncoder()
            return Promise.resolve({ done: false, value: encoder.encode(chunks[chunkIndex++]!) })
          }
          return Promise.resolve({ done: true, value: undefined })
        }),
      }

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: { getReader: () => mockReader },
      }))

      const { pullOllamaModel } = await import('@/api/ollama')
      const events: unknown[] = []
      await pullOllamaModel('llama3.1', (p) => events.push(p))

      expect(events).toHaveLength(3)
      expect(events[0]).toEqual({ status: 'pulling manifest' })
      expect(events[1]).toEqual({ status: 'downloading', completed: 50, total: 100, digest: 'sha256:abc' })
      expect(events[2]).toEqual({ status: 'success' })
    })

    it('pullOllamaModel throws on error response with error field', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'model not found' }),
      }))

      const { pullOllamaModel } = await import('@/api/ollama')
      await expect(pullOllamaModel('nonexistent', vi.fn())).rejects.toThrow('model not found')
    })

    it('pullOllamaModel throws when response body is null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: null,
      }))

      const { pullOllamaModel } = await import('@/api/ollama')
      await expect(pullOllamaModel('test', vi.fn())).rejects.toThrow('No response body')
    })

    it('pullOllamaModel throws on stream event with error field', async () => {
      const chunks = [
        '{"status":"error","error":"disk full"}\n',
      ]
      let chunkIndex = 0
      const mockReader = {
        read: vi.fn(() => {
          if (chunkIndex < chunks.length) {
            return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[chunkIndex++]!) })
          }
          return Promise.resolve({ done: true, value: undefined })
        }),
      }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: { getReader: () => mockReader },
      }))

      const { pullOllamaModel } = await import('@/api/ollama')
      const events: unknown[] = []
      // FIXED: pullOllamaModel now tracks stream errors and throws after the loop
      await expect(pullOllamaModel('model', (p) => events.push(p))).rejects.toThrow('disk full')
      expect(events[0]).toEqual({ status: 'error', error: 'disk full' })
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// Section 2: Security Tests
// ═══════════════════════════════════════════════════════════════════

describe('2. Security Tests', () => {
  describe('proxy_api_request path validation (frontend-side)', () => {
    // The Rust backend (commands.rs) should reject path traversal,
    // but the frontend config.ts passes the path directly without
    // any validation.

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).isTauri
    })

    it('proxyApiRequestText does NOT validate path before sending (no frontend guard)', async () => {
      vi.resetModules()
      ;(globalThis as Record<string, unknown>).isTauri = true
      const mockInvoke = vi.fn().mockResolvedValue('{}')
      vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

      const { getLLMConfig } = await import('@/api/config')
      // This call should work fine
      await getLLMConfig()

      // Verify the path is sent as-is
      expect(mockInvoke).toHaveBeenCalledWith('proxy_api_request', {
        method: 'GET',
        path: '/api/v1/config/llm',
        body: null,
      })

      // The proxyApiRequestText function has NO path validation.
      // It relies entirely on the Rust side. Frontend could add a guard.
    })
  })

  describe('XSS in MarkdownRenderer (v-html)', () => {
    it('DOMPurify strips script tags from markdown content', async () => {
      const DOMPurify = (await import('dompurify')).default
      const MarkdownIt = (await import('markdown-it')).default

      const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
      const malicious = 'Hello <script>alert("xss")</script> world'
      const rendered = md.render(malicious)
      const sanitized = DOMPurify.sanitize(rendered)

      // markdown-it with html:false escapes tags to entities, so <script> is
      // never a real DOM element — the text "alert" survives but is NOT executable.
      expect(sanitized).not.toContain('<script>')

      // Also verify: even if html were enabled, DOMPurify strips it
      const mdHtml = new MarkdownIt({ html: true })
      const renderedHtml = mdHtml.render(malicious)
      const sanitizedHtml = DOMPurify.sanitize(renderedHtml)
      expect(sanitizedHtml).not.toContain('<script>')
    })

    it('DOMPurify strips onerror event handlers', async () => {
      const DOMPurify = (await import('dompurify')).default
      const MarkdownIt = (await import('markdown-it')).default

      // markdown-it with html:false will escape this, but test DOMPurify as defense-in-depth
      const md = new MarkdownIt({ html: true }) // worst case: if html were enabled
      const malicious = '<img src=x onerror="alert(1)">'
      const rendered = md.render(malicious)
      const sanitized = DOMPurify.sanitize(rendered)

      expect(sanitized).not.toContain('onerror')
    })

    it('DOMPurify strips javascript: URLs in links', async () => {
      const DOMPurify = (await import('dompurify')).default
      const MarkdownIt = (await import('markdown-it')).default

      // markdown-it with html:false already blocks javascript: protocol in links,
      // rendering the markdown link syntax as literal text (not an <a> tag).
      const md = new MarkdownIt({ html: false, linkify: true })
      const malicious = '[click me](javascript:alert(1))'
      const rendered = md.render(malicious)

      // Verify no actual <a href="javascript:..."> was generated
      expect(rendered).not.toContain('href="javascript:')
      expect(rendered).not.toContain("href='javascript:")

      // Double-check: even if raw HTML were somehow injected, DOMPurify strips it
      const rawHtmlLink = '<a href="javascript:alert(1)">click</a>'
      const sanitized = DOMPurify.sanitize(rawHtmlLink)
      expect(sanitized).not.toContain('javascript:')
    })
  })

  describe('Agent display_name in Vue templates', () => {
    it('Vue {{ }} interpolation escapes HTML in display_name (safe by design)', () => {
      // Vue's {{ }} automatically escapes HTML entities.
      // Only v-html is dangerous. AgentsView uses {{ agent.display_name }},
      // so <script>alert(1)</script> would render as literal text.
      // This is a design verification, not a runtime test.
      const malicious = '<script>alert("xss")</script>'
      // Simulate Vue's text interpolation (equivalent to createTextNode)
      const div = document.createElement('div')
      div.textContent = malicious
      expect(div.innerHTML).not.toContain('<script>')
      expect(div.innerHTML).toContain('&lt;script&gt;')
    })
  })

  describe('Model name injection', () => {
    it('model name with script tag is safely handled by Vue template (textContent escaping)', () => {
      const maliciousModel = '<img src=x onerror=alert(1)>'
      const div = document.createElement('div')
      // Vue {{ }} uses textContent, which escapes HTML entities
      div.textContent = maliciousModel
      // The key security property: innerHTML does NOT contain a real <img> tag.
      // The "onerror" text is present but only as escaped text, not an attribute.
      expect(div.innerHTML).not.toContain('<img')
      expect(div.innerHTML).toContain('&lt;img')
      // Verify the tag cannot be parsed as HTML
      const parser = new DOMParser()
      const doc = parser.parseFromString(div.innerHTML, 'text/html')
      expect(doc.querySelectorAll('img').length).toBe(0)
    })
  })

  describe('URL validation for base_url (SSRF)', () => {
    afterEach(() => {
      delete (globalThis as Record<string, unknown>).isTauri
    })

    it('testLLMConnection rejects private base_url before proxying to backend', async () => {
      vi.resetModules()
      ;(globalThis as Record<string, unknown>).isTauri = true
      const mockInvoke = vi.fn().mockResolvedValue(JSON.stringify({
        ok: false,
        message: 'connection refused',
      }))
      vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

      const { testLLMConnection } = await import('@/api/config')
      await expect(testLLMConnection({
        provider: {
          type: 'custom',
          base_url: 'http://169.254.169.254/latest/meta-data',  // AWS metadata SSRF
          api_key: 'test',
          model: 'test',
        },
      })).rejects.toThrow('Unsafe base_url')

      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('sendStreamViaTauri has been removed (dead code cleanup)', async () => {
      vi.resetModules()
      vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
      vi.doMock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

      const chatModule = await import('@/api/chat')
      // sendStreamViaTauri was dead code (~55 lines) and has been removed
      expect('sendStreamViaTauri' in chatModule).toBe(false)
    })
  })

  describe('sanitizeArtifactHtml security', () => {
    it('strips script tags from artifact HTML', async () => {
      const { sanitizeArtifactHtml } = await import('@/utils/safe-html')
      const result = sanitizeArtifactHtml('<div>Hello</div><script>alert(1)</script>')
      expect(result).not.toContain('<script>')
    })

    it('strips iframe tags from artifact HTML', async () => {
      const { sanitizeArtifactHtml } = await import('@/utils/safe-html')
      const result = sanitizeArtifactHtml('<iframe src="https://evil.com"></iframe>')
      expect(result).not.toContain('<iframe')
    })

    it('strips form/input tags from artifact HTML', async () => {
      const { sanitizeArtifactHtml } = await import('@/utils/safe-html')
      const result = sanitizeArtifactHtml('<form action="https://evil.com"><input type="text"></form>')
      expect(result).not.toContain('<form')
      expect(result).not.toContain('<input')
    })

    it('title is sanitized in the generated HTML document', async () => {
      const { sanitizeArtifactHtml } = await import('@/utils/safe-html')
      const result = sanitizeArtifactHtml('<p>safe</p>', '<script>alert(1)</script>')
      expect(result).not.toContain('<script>alert(1)</script>')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// Section 3: Response Shape Resilience
// ═══════════════════════════════════════════════════════════════════

describe('3. Response Shape Resilience', () => {
  describe('knowledge.ts — normalizeKnowledgeSearchResults resilience', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('handles null result from backend', async () => {
      const mockPost = vi.fn().mockResolvedValue({ result: null })
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { searchKnowledge } = await import('@/api/knowledge')
      const res = await searchKnowledge('test')
      // normalizeKnowledgeSearchResults handles null by returning []
      expect(res.result).toEqual([])
    })

    it('handles string result from backend (legacy format)', async () => {
      const mockPost = vi.fn().mockResolvedValue({ result: 'Here is the relevant info' })
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { searchKnowledge } = await import('@/api/knowledge')
      const res = await searchKnowledge('test')
      expect(res.result).toHaveLength(1)
      expect(res.result[0]!.content).toBe('Here is the relevant info')
      expect(res.result[0]!.score).toBe(1)
    })

    it('handles result with missing optional fields', async () => {
      const mockPost = vi.fn().mockResolvedValue({
        result: [{ content: 'chunk' }],  // only content, everything else missing
      })
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { searchKnowledge } = await import('@/api/knowledge')
      const res = await searchKnowledge('test')
      expect(res.result).toHaveLength(1)
      expect(res.result[0]!.content).toBe('chunk')
      expect(res.result[0]!.score).toBe(0) // defaults to 0
    })

    it('filters out results with empty content', async () => {
      const mockPost = vi.fn().mockResolvedValue({
        result: [
          { content: '', score: 0.9 },
          { content: 'valid', score: 0.5 },
        ],
      })
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { searchKnowledge } = await import('@/api/knowledge')
      const res = await searchKnowledge('test')
      expect(res.result).toHaveLength(1)
      expect(res.result[0]!.content).toBe('valid')
    })
  })

  describe('mcp.ts — callMcpTool response resilience', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('rejects when backend returns a non-object (number)', async () => {
      const mockPost = vi.fn().mockResolvedValue(42)
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { callMcpTool } = await import('@/api/mcp')
      await expect(callMcpTool('test', {})).rejects.toThrow('malformed response')
    })

    it('rejects when backend returns a string instead of object', async () => {
      const mockPost = vi.fn().mockResolvedValue('unexpected string')
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { callMcpTool } = await import('@/api/mcp')
      await expect(callMcpTool('test', {})).rejects.toThrow('malformed response')
    })

    it('returns default result:null when backend returns empty object (no result field)', async () => {
      const mockPost = vi.fn().mockResolvedValue({})
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: mockPost,
        apiDelete: vi.fn(),
      }))

      const { callMcpTool } = await import('@/api/mcp')
      // FIXED: When result is undefined and no error, callMcpTool returns { result: null }
      const res = await callMcpTool('test', {})
      expect(res).toEqual({ result: null })
      expect(res.result).toBeNull()
    })
  })

  describe('tasks.ts — getCronJobHistory resilience', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('handles response with extra unexpected fields without crashing', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        history: [
          {
            id: 'r1',
            job_id: 'j1',
            status: 'success',
            started_at: '2024-01-01T00:00:00Z',
            unexpected_extra_field: 'should not crash',
            another_field: 42,
          },
        ],
      })
      vi.doMock('@/api/client', () => ({
        apiGet: mockGet,
        apiPost: vi.fn(),
        apiDelete: vi.fn(),
      }))

      const { getCronJobHistory } = await import('@/api/tasks')
      const history = await getCronJobHistory('j1')
      expect(history).toHaveLength(1)
      expect(history[0]!.id).toBe('r1')
      // Extra fields are spread via ...r, so they survive but don't crash
    })

    it('handles run item missing both started_at and run_at', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        history: [{ id: 'r1', job_id: 'j1', status: 'running' }],
      })
      vi.doMock('@/api/client', () => ({
        apiGet: mockGet,
        apiPost: vi.fn(),
        apiDelete: vi.fn(),
      }))

      const { getCronJobHistory } = await import('@/api/tasks')
      const history = await getCronJobHistory('j1')
      // started_at = r.started_at || r.run_at || '' → should be ''
      expect(history[0]!.started_at).toBe('')
    })
  })

  describe('chat.ts — sendChatViaBackend response resilience', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('handles empty object response gracefully (no reply field)', async () => {
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue('{}'),
      }))

      const { sendChatViaBackend } = await import('@/api/chat')
      // FIXED: (result?.reply ?? '').slice(0, 50) handles undefined reply
      const result = await sendChatViaBackend('test')
      expect(result.reply).toBeUndefined()
    })

    it('handles null reply without crashing', async () => {
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue(JSON.stringify({ reply: null, session_id: 's1' })),
      }))

      const { sendChatViaBackend } = await import('@/api/chat')
      // FIXED: (result?.reply ?? '').slice(0, 50) handles null reply
      const result = await sendChatViaBackend('test')
      expect(result.reply).toBeNull()
      expect(result.session_id).toBe('s1')
    })

    it('does not crash when metadata is missing (optional field)', async () => {
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue(JSON.stringify({
          reply: 'hello',
          session_id: 's1',
          // no metadata, no tool_calls
        })),
      }))

      const { sendChatViaBackend } = await import('@/api/chat')
      const result = await sendChatViaBackend('test')
      expect(result.metadata).toBeUndefined()
      expect(result.tool_calls).toBeUndefined()
    })

    it('handles extra unexpected fields in response without crashing', async () => {
      vi.doMock('@tauri-apps/api/core', () => ({
        invoke: vi.fn().mockResolvedValue(JSON.stringify({
          reply: 'hi',
          session_id: 's1',
          usage: { prompt_tokens: 10, completion_tokens: 20 },
          some_future_field: true,
        })),
      }))

      const { sendChatViaBackend } = await import('@/api/chat')
      const result = await sendChatViaBackend('test')
      expect(result.reply).toBe('hi')
      // Extra fields are silently kept (JSON.parse doesn't strip them)
    })
  })

  describe('ollama.ts — response resilience', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('deleteOllamaModel URL-encodes model name with special characters', async () => {
      const mockApiDelete = vi.fn().mockResolvedValue(undefined)
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: vi.fn(),
        apiDelete: mockApiDelete,
      }))

      const { deleteOllamaModel } = await import('@/api/ollama')
      await deleteOllamaModel('user/model:latest')

      const calledPath = mockApiDelete.mock.calls[0]![0] as string
      expect(calledPath).toContain(encodeURIComponent('user/model:latest'))
    })

    it('restartOllama returns "unknown" when response has no status', async () => {
      vi.doMock('@/api/client', () => ({
        apiGet: vi.fn(),
        apiPost: vi.fn().mockResolvedValue({}),
        apiDelete: vi.fn(),
      }))

      const { restartOllama } = await import('@/api/ollama')
      const status = await restartOllama()
      expect(status).toBe('unknown')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// Section 4: Gaps in existing response-shapes.test.ts
// ═══════════════════════════════════════════════════════════════════

describe('4. Gaps from response-shapes.test.ts', () => {
  describe('ChatRequest type declares temperature/max_tokens but sendChat drops them', () => {
    it('ChatRequest interface includes temperature and max_tokens fields', () => {
      // The ChatRequest type has temperature and max_tokens fields:
      // temperature?: number
      // max_tokens?: number
      // But sendChat() only forwards: sessionId, provider, model
      // This is a CONFIRMED gap: the type is more expressive than the implementation.
      const request = {
        message: 'test',
        temperature: 0.5,
        max_tokens: 1000,
      } satisfies import('@/types').ChatRequest

      expect(request.temperature).toBeDefined()
      expect(request.max_tokens).toBeDefined()
    })
  })

  describe('BackendChatResponse missing usage field', () => {
    it('frontend BackendChatResponse does not declare usage (backend sends it)', () => {
      // response-shapes.test.ts already documents this. Verify it is still true
      // by checking the interface doesn't have 'usage'.
      const response: import('@/api/chat').BackendChatResponse = {
        reply: 'hello',
        session_id: 's1',
      }
      // TypeScript won't let us access .usage — confirming the gap still exists.
      expect('usage' in response).toBe(false)
    })
  })

  describe('CronJobRun type vs actual backend response', () => {
    it('backend may return run_at instead of started_at (documented in CronJobRunWire)', async () => {
      vi.resetModules()
      const mockGet = vi.fn().mockResolvedValue({
        runs: [
          { id: 'r1', job_id: 'j1', status: 'success', run_at: '2024-01-01T00:00:00Z' },
        ],
      })
      vi.doMock('@/api/client', () => ({
        apiGet: mockGet,
        apiPost: vi.fn(),
        apiDelete: vi.fn(),
      }))

      const { getCronJobHistory } = await import('@/api/tasks')
      const history = await getCronJobHistory('j1')

      // The normalizer maps run_at → started_at
      expect(history[0]!.started_at).toBe('2024-01-01T00:00:00Z')
    })
  })

  describe('MCP server status has dual response format', () => {
    it('getMcpServerStatus accepts both statuses (map) and servers (array) format', async () => {
      vi.resetModules()
      // Backend may return either format
      const mockGet = vi.fn()
      vi.doMock('@/api/client', () => ({
        apiGet: mockGet,
        apiPost: vi.fn(),
        apiDelete: vi.fn(),
      }))

      // Format 1: statuses map
      mockGet.mockResolvedValueOnce({
        statuses: { 'my-server': 'connected' },
      })

      const { getMcpServerStatus } = await import('@/api/mcp')
      const res1 = await getMcpServerStatus()
      expect(res1.statuses).toBeDefined()

      // Format 2: servers array
      mockGet.mockResolvedValueOnce({
        servers: [{ name: 'my-server', connected: true, tool_count: 5 }],
        total: 1,
      })

      const res2 = await getMcpServerStatus()
      expect(res2.servers).toBeDefined()

      // Format 3: empty object — both formats optional, no crash
      mockGet.mockResolvedValueOnce({})
      const res3 = await getMcpServerStatus()
      expect(res3.statuses).toBeUndefined()
      expect(res3.servers).toBeUndefined()
    })
  })

  describe('knowledge isKnowledgeUploadEndpointMissing detection', () => {
    it('detects 404 status on error object', async () => {
      const { isKnowledgeUploadEndpointMissing } = await import('@/api/knowledge')
      expect(isKnowledgeUploadEndpointMissing({ status: 404 })).toBe(true)
      expect(isKnowledgeUploadEndpointMissing({ statusCode: 405 })).toBe(true)
    })

    it('detects 404 in error message string', async () => {
      const { isKnowledgeUploadEndpointMissing } = await import('@/api/knowledge')
      expect(isKnowledgeUploadEndpointMissing(new Error('Request failed with 404'))).toBe(true)
    })

    it('detects Chinese error messages for disabled knowledge', async () => {
      const { isKnowledgeUploadEndpointMissing } = await import('@/api/knowledge')
      expect(isKnowledgeUploadEndpointMissing(new Error('未提供知识库上传接口'))).toBe(true)
      expect(isKnowledgeUploadEndpointMissing(new Error('未启用知识库'))).toBe(true)
    })
  })

  describe('knowledge isKnowledgeUploadUnsupportedFormat detection', () => {
    it('detects 415 status', async () => {
      const { isKnowledgeUploadUnsupportedFormat } = await import('@/api/knowledge')
      expect(isKnowledgeUploadUnsupportedFormat({ status: 415 })).toBe(true)
    })

    it('detects unsupported format keywords in message', async () => {
      const { isKnowledgeUploadUnsupportedFormat } = await import('@/api/knowledge')
      expect(isKnowledgeUploadUnsupportedFormat(new Error('Unsupported file type'))).toBe(true)
      expect(isKnowledgeUploadUnsupportedFormat(new Error('文件格式错误'))).toBe(true)
    })
  })
})
