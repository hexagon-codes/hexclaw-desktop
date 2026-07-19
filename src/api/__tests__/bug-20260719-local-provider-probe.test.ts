import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://localhost:16060' },
}))

vi.mock('@/utils/platform', () => ({
  isTauri: vi.fn(() => false),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('local OpenAI-compatible provider probes', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends a connection probe to an exact loopback cloud gateway', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, message: '连接测试通过' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { testLLMConnection } = await import('../config')
    const result = await testLLMConnection({
      provider: {
        type: 'openai',
        base_url: 'http://localhost:18080/v1',
        api_key: 'test-key',
        model: 'test-model',
      },
    })

    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('allows an RFC1918 endpoint only with exact host authorization', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, message: '连接测试通过' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { testLLMConnection } = await import('../config')
    await testLLMConnection(
      {
        provider: {
          type: 'custom',
          base_url: 'http://192.168.1.20:8000/v1',
          api_key: 'test-key',
          model: 'local-model',
        },
      },
      {
        locality: 'local',
        privateNetworkAccess: { host: '192.168.1.20', allowed: true },
      },
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('still blocks cloud metadata endpoints even when marked local', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { testLLMConnection } = await import('../config')
    await expect(testLLMConnection(
      {
        provider: {
          type: 'custom',
          base_url: 'http://169.254.169.254/latest/meta-data',
          api_key: 'test-key',
          model: 'test-model',
        },
      },
      { locality: 'local' },
    )).rejects.toThrow('Unsafe base_url')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches models through the same loopback gateway policy', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ models: [{ id: 'test-model' }] }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { fetchProviderModels } = await import('../config')
    const models = await fetchProviderModels(
      'http://127.0.0.1:18080/v1',
      'test-key',
      { providerType: 'openai', locality: 'cloud' },
    )

    expect(models.map((model) => model.id)).toEqual(['test-model'])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
