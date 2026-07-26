import { describe, expect, it } from 'vitest'

import {
  classifyProviderEndpoint,
  resolveEffectiveProviderLocality,
} from '@/utils/provider-endpoint'

describe('provider endpoint classification', () => {
  it.each([
    ['official public endpoint', 'openai', 'https://api.openai.com/v1', 'cloud', false],
    ['custom public endpoint', 'custom', 'https://llm.example.com/v1', 'cloud', false],
    ['built-in ollama', 'ollama', 'http://127.0.0.1:11434/v1', 'local', false],
    ['loopback compatible gateway', 'openai', 'http://localhost:18080/v1', 'ambiguous', false],
    ['private IPv4 endpoint', 'custom', 'http://192.168.1.20:8000/v1', 'ambiguous', true],
    ['private IPv6 endpoint', 'custom', 'http://[fd00::20]:8000/v1', 'ambiguous', true],
    ['metadata endpoint', 'custom', 'http://169.254.169.254/latest/meta-data', 'blocked', true],
    ['metadata hostname', 'custom', 'http://metadata.google.internal/', 'blocked', true],
    ['benchmark literal', 'custom', 'https://198.18.0.1/v1', 'blocked', true],
    ['unspecified IPv4', 'custom', 'http://0.0.0.0:8000/v1', 'blocked', true],
  ] as const)(
    '%s',
    (_name, providerType, baseUrl, classification, requiresPrivateNetworkAccess) => {
      expect(classifyProviderEndpoint(providerType, baseUrl)).toMatchObject({
        classification,
        requiresPrivateNetworkAccess,
      })
    },
  )

  it('uses only the URL hostname and ignores local-looking userinfo, path, and query', () => {
    expect(
      classifyProviderEndpoint(
        'custom',
        'https://localhost@api.example.com/v1/localhost?next=127.0.0.1',
      ).classification,
    ).toBe('cloud')
  })

  it('treats an unconfirmed ambiguous endpoint as cloud-safe', () => {
    expect(
      resolveEffectiveProviderLocality({
        type: 'openai',
        baseUrl: 'http://localhost:18080/v1',
        locality: 'auto',
      }),
    ).toBe('cloud')
  })

  it('honors a user confirmation only while it matches the current normalized host', () => {
    expect(
      resolveEffectiveProviderLocality({
        type: 'custom',
        baseUrl: 'http://192.168.1.20:8000/v1',
        locality: 'local',
        localitySource: 'user',
        confirmedEndpointHost: '192.168.1.20',
      }),
    ).toBe('local')

    expect(
      resolveEffectiveProviderLocality({
        type: 'custom',
        baseUrl: 'http://192.168.1.21:8000/v1',
        locality: 'local',
        localitySource: 'user',
        confirmedEndpointHost: '192.168.1.20',
      }),
    ).toBe('cloud')
  })
})
