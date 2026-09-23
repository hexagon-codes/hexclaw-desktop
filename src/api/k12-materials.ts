import { apiGet } from './client'

export type MaterialPreparationState = 'not_prepared' | 'ready' | 'preparing' | 'needs_review' | 'failed' | 'outcome_unknown' | 'stopped'
export interface MaterialPreparationItem {
  candidate_id: string
  state: MaterialPreparationState
  stem: string
  reference_answer?: string
  answer?: string
  block_id: string
  page?: number
  line: number
  reason?: string
  asset_id?: string
  asset_version?: number
}
export interface MaterialPreparation {
  document_id: string
  source_revision: number
  state: MaterialPreparationState
  extraction_complete: boolean
  counts: Record<string, number>
  items?: MaterialPreparationItem[]
}
export function getMaterialPreparations(ids: string[], signal?: AbortSignal) {
  const query = new URLSearchParams()
  for (const id of ids) query.append('document_id', id)
  return apiGet<{ preparations: MaterialPreparation[] }>(`/api/k12/materials/preparations?${query}`, undefined, { signal })
}
export function getMaterialPreparation(id: string, signal?: AbortSignal) {
  return apiGet<MaterialPreparation>(`/api/k12/materials/${encodeURIComponent(id)}/preparation`, undefined, { signal })
}
export function materialPreparationSummary(value?: MaterialPreparation): string {
  if (!value) return ''
  const labels: Record<string, string> = { ready: 'ready', preparing: 'preparing', needs_review: 'need review', failed: 'failed', outcome_unknown: 'result unknown', stopped: 'stopped' }
  return Object.entries(labels).filter(([key]) => (value.counts[key] ?? 0) > 0)
    .map(([key, label]) => `${value.counts[key]} ${label}`).join(' · ')
}
