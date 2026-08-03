import { env } from '@/config/env'

const K12_BASE = '/api/k12'

/** Resolve an immutable K12 asset identity to the authenticated read endpoint. */
export function k12AssetURL(agent: string, assetId: string): string {
  if (!assetId.startsWith('asset://')) return ''
  const file = assetId.slice(assetId.lastIndexOf('/') + 1)
  if (!agent.trim() || !file) return ''
  return `${env.apiBase}${K12_BASE}/assets/${file}?agent=${encodeURIComponent(agent)}`
}
