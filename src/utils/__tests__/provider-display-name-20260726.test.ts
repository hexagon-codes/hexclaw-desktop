import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@/types'
import { resolveProviderDisplayName } from '../provider-display-name'
import chatViewSource from '@/views/ChatView.vue?raw'

const provider = {
  id: 'provider-config-id',
  providerInstanceId: 'provider-instance-id',
  backendKey: 'hexclaw-gpt',
  name: 'HexClaw-GPT',
  type: 'custom',
  enabled: true,
  apiKey: '',
  baseUrl: 'http://127.0.0.1:18080/v1',
  models: [],
} satisfies ProviderConfig

describe('BUG-20260726-017 Provider display name fidelity', () => {
  it.each([
    'provider-config-id',
    'provider-instance-id',
    'hexclaw-gpt',
    'HEXCLAW-GPT',
    'HexClaw-GPT',
  ])('resolves %s to the exact configured name', (identity) => {
    expect(resolveProviderDisplayName(identity, [provider])).toBe('HexClaw-GPT')
  })

  it('uses the current configured name after a rename without changing the route key', () => {
    expect(resolveProviderDisplayName('hexclaw-gpt', [{ ...provider, name: '家庭 GPT' }])).toBe(
      '家庭 GPT',
    )
  })

  it('falls back to the frozen display name and then the raw key', () => {
    expect(resolveProviderDisplayName('removed-key', [], '曾用服务商')).toBe('曾用服务商')
    expect(resolveProviderDisplayName('removed-key', [])).toBe('removed-key')
    expect(resolveProviderDisplayName('', [])).toBe('')
  })

  it('wires the shared resolver into the canonical message footer', () => {
    expect(chatViewSource).toContain('messageProviderDisplay(msg)')
    expect(chatViewSource).not.toMatch(
      /\[metadataValue\(msg,\s*'provider'\),\s*metadataValue\(msg,\s*'model'\)\]/,
    )
  })
})
