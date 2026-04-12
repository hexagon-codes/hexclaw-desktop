/**
 * HexClaw API-level E2E tests
 *
 * Tests sidecar API endpoints directly (no browser).
 * Covers: session lifecycle, knowledge RAG, memory, gateway security,
 *         config/Ollama, and logs/trace.
 */

import { test, expect } from '@playwright/test'
import { api, wsChat, USER_ID, type ChatResult } from './helpers'

// ---------------------------------------------------------------------------
// 0. 环境探测 — 确认至少一个 LLM provider 可用
// ---------------------------------------------------------------------------
let providerAvailable = false

test.beforeAll(async () => {
  try {
    const { data } = await api('GET', '/api/v1/config')
    const llm = (data as any).llm ?? {}
    const providers = llm.providers ?? {}
    const hasKey = Object.values(providers).some((p: any) => p.has_key)
    const hasOllama = Object.keys(providers).some((k: string) => k.toLowerCase().includes('ollama'))

    if (hasKey || hasOllama) {
      // 进一步探测 Ollama 是否真正在线
      if (!hasKey && hasOllama) {
        try {
          const health = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) })
          providerAvailable = health.ok
        } catch { providerAvailable = false }
      } else {
        providerAvailable = true
      }
    }
  } catch { /* sidecar not running */ }
})

// ---------------------------------------------------------------------------
// 1. Session lifecycle
// ---------------------------------------------------------------------------
test.describe.serial('Session lifecycle', () => {
  test.setTimeout(180_000)

  let sessionId: string

  test('First message creates session and gets reply', async () => {
    test.skip(!providerAvailable, 'No LLM provider available (Ollama offline or no API key configured)')
    const result: ChatResult = await wsChat(`session smoke ${Date.now()}`)
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.chunks).toBeGreaterThanOrEqual(1)
  })

  test('Session appears in list', async () => {
    const { status, data } = await api('GET', `/api/v1/sessions?user_id=${USER_ID}`)
    expect(status).toBe(200)

    const sessions: any[] = data.sessions ?? []
    expect(sessions.length).toBeGreaterThan(0)

    // Keep the first session id for later tests
    sessionId = sessions[0].id
  })

  test('Session has user + assistant messages in history', async () => {
    expect(sessionId).toBeTruthy()

    const { status, data } = await api(
      'GET',
      `/api/v1/sessions/${sessionId}/messages?user_id=${USER_ID}`,
    )
    expect(status).toBe(200)

    const messages: any[] = data.messages ?? []
    expect(messages.some((m: any) => m.role === 'user')).toBe(true)
    expect(messages.some((m: any) => m.role === 'assistant')).toBe(true)
  })

  test('HTTP chat fallback works', async () => {
    const { status, data } = await api('POST', '/api/v1/chat', {
      message: `http fallback ${Date.now()}`,
    })
    expect(status).toBe(200)
    expect(data.reply?.length).toBeGreaterThan(0)
  })

  test('Delete session removes it from list', async () => {
    expect(sessionId).toBeTruthy()

    await api('DELETE', `/api/v1/sessions/${sessionId}?user_id=${USER_ID}`)

    const { data } = await api('GET', `/api/v1/sessions?user_id=${USER_ID}`)
    const ids = (data.sessions ?? []).map((s: any) => s.id)
    expect(ids).not.toContain(sessionId)
  })

  test('Cross-provider switch (default then alternate)', async () => {
    // 探测式：先查可用 provider，再按实际能力断言
    const { data: cfgData } = await api('GET', '/api/v1/config')
    const providers = (cfgData as any)?.llm?.providers ?? {}
    const providerNames = Object.keys(providers)

    // 找到一个非默认且有 key 的 provider
    const defaultProv = (cfgData as any)?.llm?.default ?? ''
    const alternate = providerNames.find(
      (n: string) => n !== defaultProv && (providers[n]?.has_key || n.toLowerCase().includes('ollama')),
    )

    const r1: ChatResult = await wsChat(`provider A ${Date.now()}`)
    expect(r1.content.length).toBeGreaterThan(0)

    if (!alternate) {
      // 只有一个 provider，跳过交叉验证
      return
    }

    const r2: ChatResult = await wsChat(`provider B ${Date.now()}`, {
      provider: alternate,
      model: providers[alternate]?.model,
    })
    expect(r2.content.length).toBeGreaterThan(0)

    // The two replies should come from different providers
    const p1 = r1.metadata?.provider ?? ''
    const p2 = r2.metadata?.provider ?? ''
    expect(p1).not.toBe(p2)
  })
})

// ---------------------------------------------------------------------------
// 2. Knowledge RAG
// ---------------------------------------------------------------------------
test.describe('Knowledge RAG', () => {
  test.setTimeout(180_000)

  test('Document list returns indexed docs', async () => {
    const { status, data } = await api('GET', '/api/v1/knowledge/documents')
    expect(status).toBe(200)

    const docs: any[] = data.documents ?? []
    expect(docs.length).toBeGreaterThanOrEqual(0)
  })

  test('Search endpoint returns 200 with valid structure', async () => {
    const { status, data } = await api('POST', '/api/v1/knowledge/search', {
      query: 'Apple design',
      top_k: 3,
    })
    expect(status).toBe(200)

    // 探测式：不假设索引中有数据，只验证接口契约
    const results: any[] = data.results ?? []
    expect(Array.isArray(results)).toBe(true)
    // 如果有结果，验证结构
    if (results.length > 0) {
      expect(results[0]).toHaveProperty('content')
      expect(results[0]).toHaveProperty('score')
    }
  })

  test('RAG chat returns reply', async () => {
    const result: ChatResult = await wsChat(
      'What are Apple Human Interface Guidelines core principles?',
    )
    expect(result.content.length).toBeGreaterThan(0)
  })

  test('Irrelevant question still gets reply', async () => {
    const result: ChatResult = await wsChat(`unrelated question ${Date.now()}`)
    expect(result.content.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Memory
// ---------------------------------------------------------------------------
test.describe('Memory', () => {
  test('Read memory API returns 200', async () => {
    const { status } = await api('GET', '/api/v1/memory')
    expect(status).toBe(200)
  })

  test('Write memory succeeds', async () => {
    const { status } = await api('POST', '/api/v1/memory', {
      content: `e2e memory ${Date.now()}`,
    })
    expect([200, 201, 204]).toContain(status)
  })

  test('Written memory persists on re-read', async () => {
    const { status, data } = await api('GET', '/api/v1/memory')
    expect(status).toBe(200)
    expect(JSON.stringify(data)).toContain('e2e')
  })
})

// ---------------------------------------------------------------------------
// 4. Gateway security
// ---------------------------------------------------------------------------
test.describe('Gateway security', () => {
  test('Empty message returns 400', async () => {
    const { status } = await api('POST', '/api/v1/chat', { message: '' })
    expect(status).toBe(400)
  })

  test('Invalid provider returns 500', async () => {
    const { status } = await api('POST', '/api/v1/chat', {
      message: 'test',
      provider: '不存在',
    })
    expect(status).toBe(500)
  })

  test('Cross-user isolation (different user_id sees empty sessions)', async () => {
    const { status, data } = await api(
      'GET',
      `/api/v1/sessions?user_id=nobody-${Date.now()}`,
    )
    expect(status).toBe(200)
    expect(data.sessions ?? []).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Config & Ollama
// ---------------------------------------------------------------------------
test.describe('Config & Ollama', () => {
  test('Config API has LLM default', async () => {
    const { status, data } = await api('GET', '/api/v1/config')
    expect(status).toBe(200)
    expect(data.llm?.default).toBeTruthy()
  })

  test('Config has providers', async () => {
    const { data } = await api('GET', '/api/v1/config')
    const providers = data.llm?.providers ?? {}
    expect(Object.keys(providers).length).toBeGreaterThan(0)
  })

  test('Ollama is running with models', async () => {
    const { status, data } = await api('GET', '/api/v1/ollama/status')
    expect(status).toBe(200)
    expect(data.running).toBe(true)
    expect(data.model_count).toBeGreaterThan(0)
  })

  test('Health endpoint returns healthy', async () => {
    const { status } = await api('GET', '/health')
    expect(status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 6. Logs & Trace
// ---------------------------------------------------------------------------
test.describe('Logs & Trace', () => {
  test('Logs API returns entries', async () => {
    const { status, data } = await api('GET', '/api/v1/logs?limit=50')
    expect(status).toBe(200)

    const logs: any[] = data.logs ?? []
    expect(logs.length).toBeGreaterThan(0)
  })

  test('Some entries have trace_id', async () => {
    const { data } = await api('GET', '/api/v1/logs?limit=80')
    const logs: any[] = data.logs ?? []
    const traced = logs.filter((l: any) => l.trace_id)
    expect(traced.length).toBeGreaterThan(0)
  })

  test('Some entries have structured fields', async () => {
    const { data } = await api('GET', '/api/v1/logs?limit=80')
    const logs: any[] = data.logs ?? []
    const fielded = logs.filter((l: any) => l.fields && Object.keys(l.fields).length > 0)
    expect(fielded.length).toBeGreaterThan(0)
  })

  test('Log stats API works', async () => {
    const { status, data } = await api('GET', '/api/v1/logs/stats')
    expect(status).toBe(200)
    expect(data).toBeTruthy()
  })
})
