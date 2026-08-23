import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://localhost:16060' },
  OLLAMA_BASE: 'http://localhost:11434',
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

describe('BUG-20260728-011 provider probe receipt API contract', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('sends the stable provider identity and returns the durable receipt facts', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          message: '连接测试通过',
          persisted: true,
          tested_at: '2026-07-28T06:20:00Z',
          latency_ms: 321,
        }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { testLLMConnection } = await import('../config')
    const result = await testLLMConnection(
      {
        provider: {
          type: 'custom',
          base_url: 'https://provider.example.test/v1',
          api_key: 'sk-test',
          model: 'gpt-5.6-sol',
        },
      },
      {
        providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
        locality: 'cloud',
      } as never,
    )

    const request = fetchSpy.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({
          provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
        }),
      }),
    )
    expect(result).toEqual(
      expect.objectContaining({
        persisted: true,
        tested_at: '2026-07-28T06:20:00Z',
      }),
    )
  })
})
