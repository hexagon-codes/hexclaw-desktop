import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://localhost:16060' },
}))

vi.mock('@/utils/platform', () => ({
  isTauri: vi.fn(() => false),
}))

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('provider private-network policy', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('blocks an RFC1918 endpoint when no host-scoped authorization exists', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { testLLMConnection } = await import('../config')
    await expect(
      testLLMConnection(
        {
          provider: {
            type: 'custom',
            base_url: 'http://10.0.0.8:8080/v1',
            api_key: 'test-key',
            model: 'corp-model',
          },
        },
        { locality: 'cloud' },
      ),
    ).rejects.toThrow('private network')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('allows a private cloud gateway only for the exact authorized host', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, message: '连接测试通过' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { testLLMConnection } = await import('../config')
    const result = await testLLMConnection(
      {
        provider: {
          type: 'custom',
          base_url: 'http://10.0.0.8:8080/v1',
          api_key: 'test-key',
          model: 'corp-model',
        },
      },
      {
        locality: 'cloud',
        privateNetworkAccess: { host: '10.0.0.8', allowed: true },
      },
    )

    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not reuse an authorization after the endpoint host changes', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { testLLMConnection } = await import('../config')
    await expect(
      testLLMConnection(
        {
          provider: {
            type: 'custom',
            base_url: 'http://10.0.0.9:8080/v1',
            api_key: 'test-key',
            model: 'corp-model',
          },
        },
        {
          locality: 'cloud',
          privateNetworkAccess: { host: '10.0.0.8', allowed: true },
        },
      ),
    ).rejects.toThrow('private network')

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
