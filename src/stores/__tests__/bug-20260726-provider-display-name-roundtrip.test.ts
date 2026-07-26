import { describe, expect, it } from 'vitest'

import { backendToProviders, providersToBackend } from '@/stores/settings-helpers'
import type { BackendLLMConfig, ProviderConfig } from '@/types'

const provider: ProviderConfig = {
  id: 'local-hexclaw-gpt',
  providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
  backendKey: 'hexclaw-gpt',
  name: 'HexClaw-GPT',
  type: 'custom',
  enabled: true,
  apiKey: '',
  baseUrl: 'https://example.test/v1',
  models: [{ id: 'gpt-5.6-sol', name: 'gpt-5.6-sol' }],
  selectedModelId: 'gpt-5.6-sol',
}

describe('provider display name config round-trip', () => {
  it('sends the configured name and restores it after local state is lost', () => {
    const backend = providersToBackend(
      [provider],
      'gpt-5.6-sol',
      'local-hexclaw-gpt',
    )

    expect(backend.providers['hexclaw-gpt']).toMatchObject({
      display_name: 'HexClaw-GPT',
    })

    const [restored] = backendToProviders(backend)
    expect(restored?.backendKey).toBe('hexclaw-gpt')
    expect(restored?.name).toBe('HexClaw-GPT')
  })

  it('keeps the persisted local name ahead of a stale backend display name', () => {
    const backend = {
      default: 'hexclaw-gpt',
      providers: {
        'hexclaw-gpt': {
          display_name: 'Stale Backend Name',
          api_key: '',
          base_url: 'https://example.test/v1',
          model: 'gpt-5.6-sol',
          compatible: 'openai',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 1, ttl: '24h', max_entries: 1000 },
    } as BackendLLMConfig

    const [restored] = backendToProviders(backend, [provider])
    expect(restored?.name).toBe('HexClaw-GPT')
    expect(restored?.backendKey).toBe('hexclaw-gpt')
  })

  it('keeps old configs compatible by falling back to the routing key', () => {
    const backend: BackendLLMConfig = {
      default: 'hexclaw-gpt',
      providers: {
        'hexclaw-gpt': {
          api_key: '',
          base_url: 'https://example.test/v1',
          model: 'gpt-5.6-sol',
          compatible: 'openai',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 1, ttl: '24h', max_entries: 1000 },
    }

    const [restored] = backendToProviders(backend)
    expect(restored?.name).toBe('hexclaw-gpt')
    expect(restored?.backendKey).toBe('hexclaw-gpt')
  })
})
