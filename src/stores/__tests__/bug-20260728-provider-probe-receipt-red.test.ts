import { describe, expect, it } from 'vitest'

import { backendToProviders } from '../settings-helpers'
import type { BackendLLMConfig } from '@/types/settings'

describe('BUG-20260728-011 provider probe receipt hydration', () => {
  it('maps the backend receipt by stable provider identity for SettingsView remounts', () => {
    const backend = {
      default: 'custom',
      providers: {
        custom: {
          provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
          display_name: 'HexClaw-GPT',
          api_key: '****-test',
          base_url: 'https://provider.example.test/v1',
          model: 'gpt-5.6-sol',
          models: ['gpt-5.6-sol'],
          model_specs_mode: 'explicit',
          model_specs: [
            {
              id: 'gpt-5.6-sol',
              capabilities: ['text'],
            },
          ],
          compatible: 'openai',
          locality: 'cloud',
          enabled: true,
          probe_receipt: {
            provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
            outcome: 'passed',
            tested_at: Date.UTC(2026, 6, 28, 6, 20),
            probe_started_at: Date.UTC(2026, 6, 28, 6, 19, 59),
            latency_ms: 321,
            locality: 'cloud',
            message: '连接测试通过',
          },
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10_000 },
    } as unknown as BackendLLMConfig

    const providers = backendToProviders(backend)
    const provider = providers[0] as (typeof providers)[number] & {
      probeReceipt?: {
        providerInstanceId: string
        outcome: string
        testedAt: number
        latencyMs: number
        locality: string
      }
    }

    expect(provider.providerInstanceId).toBe(
      'pvd_v1_00112233445566778899aabbccddeeff',
    )
    expect(provider.probeReceipt).toEqual(
      expect.objectContaining({
        providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
        outcome: 'passed',
        testedAt: Date.UTC(2026, 6, 28, 6, 20),
        latencyMs: 321,
        locality: 'cloud',
      }),
    )
  })

  it('preserves the backend failed receipt message across Settings remount hydration', () => {
    const backend = {
      default: 'HexClaw-GPT',
      providers: {
        'HexClaw-GPT': {
          provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
          display_name: 'HexClaw-GPT',
          api_key: '****-test',
          base_url: 'https://provider.example.test/v1',
          model: 'gpt-5.6-sol',
          models: ['gpt-5.6-sol'],
          compatible: 'openai',
          locality: 'cloud',
          enabled: true,
          probe_receipt: {
            provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
            outcome: 'failed',
            tested_at: Date.UTC(2026, 6, 28, 6, 20),
            probe_started_at: Date.UTC(2026, 6, 28, 6, 19, 59),
            latency_ms: 321,
            locality: 'cloud',
            message: 'upstream unavailable',
          },
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10_000 },
    } as unknown as BackendLLMConfig

    const provider = backendToProviders(backend)[0]!

    expect(provider.probeReceipt).toEqual(
      expect.objectContaining({
        outcome: 'failed',
        errorMessage: 'upstream unavailable',
      }),
    )
  })
})
