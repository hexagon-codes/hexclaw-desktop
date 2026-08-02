import { describe, expect, it } from 'vitest'

import type { ProviderConfig } from '@/types'
import { providersToBackend } from '../settings-helpers'
import {
  materializeProviderApiKeys,
  providerCredentialReplacements,
} from '../settings-provider-secrets'

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'renderer-card-id',
  providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
  backendKey: 'openai-main',
  name: 'OpenAI Main',
  type: 'openai',
  enabled: true,
  apiKey: '********',
  credentialRef:
    'llm_provider/pvd_v1_00112233445566778899aabbccddeeff/api_key',
  credentialPresent: true,
  baseUrl: 'https://api.openai.com/v1',
  models: [{ id: 'gpt-5', name: 'gpt-5', capabilities: ['text'] }],
  ...overrides,
})

describe('provider credential mutation boundary', () => {
  it('serializes masked credentials as preserve without api_key or credential_ref', async () => {
    const [materialized] = await materializeProviderApiKeys([provider()])
    const wire = providersToBackend([materialized!], 'gpt-5', materialized!.id)
    expect(wire.providers['openai-main']).not.toHaveProperty('api_key')
    expect(wire.providers['openai-main']!.api_key_mutation).toEqual({ mode: 'preserve' })
    expect(providerCredentialReplacements([materialized!])).toEqual([])
  })

  it('sends a fresh secret only in the native replacement side channel', async () => {
    const [materialized] = await materializeProviderApiKeys([
      provider({ apiKey: 'sk-fresh', credentialRef: undefined, credentialPresent: undefined }),
    ])
    const wire = providersToBackend([materialized!], 'gpt-5', materialized!.id)
    expect(wire.providers['openai-main']).not.toHaveProperty('api_key')
    expect(wire.providers['openai-main']!.api_key_mutation).toEqual({
      mode: 'replace',
      credential_ref:
        'llm_provider/pvd_v1_00112233445566778899aabbccddeeff/api_key',
    })
    expect(providerCredentialReplacements([materialized!])).toEqual([
      { providerKey: 'openai-main', secret: 'sk-fresh' },
    ])
  })

  it('leaves a new provider ref for the native reserve endpoint', async () => {
    const [materialized] = await materializeProviderApiKeys([
      provider({
        providerInstanceId: undefined,
        backendKey: undefined,
        credentialRef: undefined,
        credentialPresent: undefined,
        apiKey: 'sk-new',
      }),
    ])
    const wire = providersToBackend([materialized!], 'gpt-5', materialized!.id)
    expect(wire.providers['OpenAI Main']!.api_key_mutation).toEqual({ mode: 'replace' })
    expect(providerCredentialReplacements([materialized!])).toEqual([
      { providerKey: 'OpenAI Main', secret: 'sk-new' },
    ])
  })

  it('fails closed when a masked ref is not present in the native vault', async () => {
    await expect(
      materializeProviderApiKeys([provider({ credentialPresent: false })]),
    ).rejects.toThrow('只有脱敏值')
  })
})
