import { describe, expect, it } from 'vitest'

import { backendToProviders, providersToBackend } from '@/stores/settings-helpers'
import type { BackendLLMConfig, ProviderConfig } from '@/types'

describe('provider locality + num_ctx config round-trip', () => {
  it('restores explicit cloud locality for a loopback cloud gateway', () => {
    const backend: BackendLLMConfig = {
      default: 'openai',
      providers: {
        openai: {
          api_key: '****test',
          base_url: 'http://localhost:18080/v1',
          model: 'gpt-5.6-sol',
          models: ['gpt-5.6-sol'],
          compatible: 'openai',
          locality: 'cloud',
          num_ctx: 8192,
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 1, ttl: '24h', max_entries: 1000 },
    }

    const [provider] = backendToProviders(backend)
    expect(provider?.locality).toBe('cloud')
    expect(provider?.numCtx).toBe(8192)
  })

  it('persists locality and num_ctx instead of deleting them on settings save', () => {
    const provider: ProviderConfig = {
      id: 'openai',
      backendKey: 'openai',
      name: 'openai',
      type: 'openai',
      enabled: true,
      apiKey: '****test',
      baseUrl: 'http://localhost:18080/v1',
      models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      selectedModelId: 'gpt-5.6-sol',
      locality: 'cloud',
      numCtx: 8192,
    }

    const backend = providersToBackend([provider], 'gpt-5.6-sol', 'openai')
    expect(backend.providers.openai?.locality).toBe('cloud')
    expect(backend.providers.openai?.num_ctx).toBe(8192)
  })

  it('round-trips user confirmation and host-scoped private-network access', () => {
    const provider: ProviderConfig = {
      id: 'corp-gateway',
      backendKey: 'corp-gateway',
      name: 'Corp Gateway',
      type: 'custom',
      enabled: true,
      apiKey: '****test',
      baseUrl: 'http://10.0.0.8:8080/v1',
      models: [{ id: 'corp-model', name: 'Corp Model' }],
      selectedModelId: 'corp-model',
      locality: 'cloud',
      localitySource: 'user',
      confirmedEndpointHost: '10.0.0.8',
      privateNetworkAccess: { host: '10.0.0.8', allowed: true },
    }

    const backend = providersToBackend([provider], 'corp-model', 'corp-gateway')
    expect(backend.providers['corp-gateway']).toMatchObject({
      locality: 'cloud',
      locality_source: 'user',
      confirmed_endpoint_host: '10.0.0.8',
      private_network_access: { host: '10.0.0.8', allowed: true },
    })

    const [restored] = backendToProviders(backend, [provider])
    expect(restored).toMatchObject({
      locality: 'cloud',
      localitySource: 'user',
      confirmedEndpointHost: '10.0.0.8',
      privateNetworkAccess: { host: '10.0.0.8', allowed: true },
    })
  })
})
