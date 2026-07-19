import type {
  PrivateNetworkAccess,
  ProviderConfig,
  ProviderLocality,
  ProviderType,
} from '@/types/settings'

export type ProviderEndpointClassification = 'cloud' | 'local' | 'ambiguous' | 'blocked'

export interface ProviderEndpointDecision {
  classification: ProviderEndpointClassification
  host: string
  requiresPrivateNetworkAccess: boolean
}

function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

function parseHost(baseUrl: string): string {
  if (!baseUrl.trim()) return ''
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return normalizeHost(parsed.hostname)
  } catch {
    return ''
  }
}

function ipv4Parts(host: string): number[] | null {
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null
}

function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true
  const parts = ipv4Parts(host)
  return parts?.[0] === 127
}

function isBlockedHost(host: string): boolean {
  if (host === 'metadata.google.internal' || host === '0.0.0.0' || host === '::') return true
  const parts = ipv4Parts(host)
  if (parts?.[0] === 169 && parts[1] === 254) return true
  return host.startsWith('fe80:')
}

function isPrivateNetwork(host: string): boolean {
  const parts = ipv4Parts(host)
  if (parts) {
    const [a, b] = parts
    return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
  }
  return host.includes(':') && (host.startsWith('fc') || host.startsWith('fd'))
}

export function providerEndpointHost(baseUrl: string): string {
  return parseHost(baseUrl)
}

export function matchesProviderPrivateNetworkAccess(
  baseUrl: string,
  access?: PrivateNetworkAccess,
): boolean {
  const host = parseHost(baseUrl)
  return !!host && access?.allowed === true && normalizeHost(access.host) === host
}

export function classifyProviderEndpoint(
  providerType: ProviderType | string,
  baseUrl: string,
): ProviderEndpointDecision {
  const host = parseHost(baseUrl)
  if (!baseUrl.trim()) {
    return { classification: 'cloud', host: '', requiresPrivateNetworkAccess: false }
  }
  if (!host || isBlockedHost(host)) {
    return { classification: 'blocked', host, requiresPrivateNetworkAccess: true }
  }
  if (isLoopback(host)) {
    return {
      classification: providerType.toLowerCase() === 'ollama' ? 'local' : 'ambiguous',
      host,
      requiresPrivateNetworkAccess: false,
    }
  }
  if (isPrivateNetwork(host)) {
    return { classification: 'ambiguous', host, requiresPrivateNetworkAccess: true }
  }
  if (providerType.toLowerCase() === 'ollama') {
    return { classification: 'blocked', host, requiresPrivateNetworkAccess: false }
  }
  return { classification: 'cloud', host, requiresPrivateNetworkAccess: false }
}

export function resolveEffectiveProviderLocality(
  provider: Pick<
    ProviderConfig,
    'type' | 'baseUrl' | 'locality' | 'localitySource' | 'confirmedEndpointHost'
  >,
): Exclude<ProviderLocality, 'auto'> {
  const decision = classifyProviderEndpoint(provider.type, provider.baseUrl)
  if (decision.classification === 'local') return 'local'
  if (decision.classification !== 'ambiguous') return 'cloud'

  const hasMatchingUserConfirmation =
    provider.localitySource === 'user' &&
    !!decision.host &&
    normalizeHost(provider.confirmedEndpointHost ?? '') === decision.host
  if (hasMatchingUserConfirmation && provider.locality === 'local') return 'local'
  return 'cloud'
}
