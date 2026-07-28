import { describe, expect, it } from 'vitest'

import {
  invalidateChangedProviderProbeReceipt,
  providerProbeConnectivityFingerprint,
} from '../settings-helpers'
import type { ProviderConfig, ProviderProbeReceipt } from '@/types/settings'

const receipt: ProviderProbeReceipt = {
  providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
  outcome: 'passed',
  testedAt: Date.UTC(2026, 6, 28, 6, 20),
  latencyMs: 321,
  locality: 'cloud',
}

function provider(): ProviderConfig {
  return {
    id: 'provider',
    providerInstanceId: receipt.providerInstanceId,
    probeReceipt: { ...receipt },
    name: 'HexClaw-GPT',
    type: 'custom',
    enabled: true,
    apiKey: 'sk-test',
    baseUrl: 'https://provider.example.test/v1',
    selectedModelId: 'gpt-5.6-sol',
    models: [{ id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', capabilities: ['text'] }],
    locality: 'cloud',
  }
}

describe('BUG-20260728-011 provider probe receipt fingerprint', () => {
  it.each([
    ['provider type', { type: 'openai' }],
    ['base URL', { baseUrl: 'https://changed.example.test/v1' }],
    ['API key', { apiKey: 'sk-rotated' }],
    ['selected model', { selectedModelId: 'gpt-5.6-terra' }],
    ['locality', { locality: 'local' }],
  ] as const)('invalidates immediately when %s changes', (_field, update) => {
    const previous = provider()
    const next = { ...previous, ...update } as ProviderConfig

    invalidateChangedProviderProbeReceipt(previous, next)

    expect(next.probeReceipt).toBeUndefined()
  })

  it('preserves the receipt when only the display name changes', () => {
    const previous = provider()
    const next = { ...previous, name: 'Renamed Provider' }

    expect(providerProbeConnectivityFingerprint(next)).toBe(
      providerProbeConnectivityFingerprint(previous),
    )
    invalidateChangedProviderProbeReceipt(previous, next)

    expect(next.probeReceipt).toEqual(receipt)
  })
})
