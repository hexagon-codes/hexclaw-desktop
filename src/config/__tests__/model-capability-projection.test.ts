import { describe, expect, it } from 'vitest'
import {
  mergeProviderModels,
  mergeRemoteModelsIntoProvider,
} from '../model-contract'
import type { ProviderConfig } from '@/types'

function providerFixture(): ProviderConfig {
  return {
    id: 'custom-provider',
    providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
    backendKey: 'custom-provider',
    name: 'Custom Provider',
    type: 'custom',
    enabled: true,
    apiKey: '****masked',
    baseUrl: 'https://models.example/v1',
    models: [],
  }
}

describe('model capability projection', () => {
  it('prefers the server effective projection over the static model specification', () => {
    const models = mergeProviderModels(
      providerFixture(),
      'vision-looking-id',
      ['vision-looking-id'],
      [{
        id: 'vision-looking-id',
        display_name: 'Static model name',
        capabilities: ['text'],
      }],
      [{
        id: 'vision-looking-id',
        display_name: 'Server projection name',
        capabilities: ['text', 'vision'],
      }],
    )

    expect(models).toEqual([
      expect.objectContaining({
        id: 'vision-looking-id',
        name: 'Server projection name',
        capabilities: ['text', 'vision'],
      }),
    ])
  })

  it('keeps a bare remote catalog model unclassified instead of deriving capability from its id', () => {
    const target = providerFixture()

    mergeRemoteModelsIntoProvider(
      target,
      [{
        id: 'vendor/vision-image-model',
        name: 'Vision image model',
        inputModalities: ['text', 'image'],
      }],
      [],
    )

    expect(target.models).toEqual([
      expect.objectContaining({
        id: 'vendor/vision-image-model',
        capabilities: [],
      }),
    ])
  })
})
