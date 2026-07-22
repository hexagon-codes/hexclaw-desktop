import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('provider model catalog transport contract', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('rejects a backend HTTP-200 error envelope instead of treating it as an empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ models: [], error: 'HTTP 401' }),
    }))

    const { fetchProviderModels } = await import('../config')

    await expect(
      fetchProviderModels('https://api.example.com/v1', 'stale-key'),
    ).rejects.toThrow('HTTP 401')
  })

  it('sends the stable provider identity so the backend can use its persisted real credential', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ models: [{ id: 'server-model' }] }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { fetchProviderModels } = await import('../config')
    await fetchProviderModels('https://api.example.com/v1', '****masked', {
      providerType: 'custom',
      providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
    })

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
    })
  })

  it('rejects URL-policy failures instead of returning an indistinguishable empty catalog', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { fetchProviderModels } = await import('../config')

    await expect(
      fetchProviderModels('http://169.254.169.254/latest/meta-data', 'secret'),
    ).rejects.toThrow('Unsafe base_url')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    { payload: '<html>bad gateway</html>', expected: 'non-JSON' },
    { payload: JSON.stringify({ models: [] }), expected: 'empty model catalog' },
  ])('rejects malformed or empty catalog payload: $expected', async ({ payload, expected }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => payload,
    }))

    const { fetchProviderModels } = await import('../config')

    await expect(fetchProviderModels('https://api.example.com/v1', 'key')).rejects.toThrow(expected)
  })
})
