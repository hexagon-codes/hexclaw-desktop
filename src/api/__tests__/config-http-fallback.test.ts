import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/env', () => ({
  env: {
    apiBase: 'http://localhost:16060',
  },
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

describe('config API web http fallback', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('getLLMConfig uses HTTP when not running in Tauri', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        default: 'Ollama (本地)',
        providers: {
          'Ollama (本地)': {
            api_key: '',
            base_url: 'http://localhost:11434/v1',
            model: 'qwen3.5:9b',
            models: ['qwen3.5:9b'],
            compatible: '',
          },
        },
        routing: { enabled: true, strategy: 'cost-aware' },
        cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
      }),
    }))

    const { getLLMConfig } = await import('../config')
    const result = await getLLMConfig()

    expect(fetch).toHaveBeenCalledWith('http://localhost:16060/api/v1/config/llm', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      body: undefined,
    })
    expect(result.default).toBe('Ollama (本地)')
    expect(result.providers['Ollama (本地)']?.model).toBe('qwen3.5:9b')
  })

  it('updateLLMConfig uses HTTP PUT when not running in Tauri', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"ok":true}',
    }))

    const { updateLLMConfig } = await import('../config')
    await updateLLMConfig({
      default: 'Ollama (本地)',
      providers: {
        'Ollama (本地)': {
          api_key: '',
          base_url: 'http://localhost:11434/v1',
          model: 'qwen3.5:9b',
          models: ['qwen3.5:9b'],
          compatible: '',
        },
      },
      routing: { enabled: true, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:16060/api/v1/config/llm',
      expect.objectContaining({
        method: 'PUT',
      }),
    )
  })
})
